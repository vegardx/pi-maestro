import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { type AuthoringComplete, createSessionAuthor } from "./authoring.js";
import { createAuditedBash } from "./bash-tool.js";
import {
	type Announce,
	beginModeExit,
	createDialogGate,
	createModeExitController,
	type ExitFlowDeps,
	type ExitFlowOutcome,
	type ModeExitContext,
	type ModeExitHook,
} from "./exit-flow.js";
import { MODE_NAMES, type ModeName, modeCeiling } from "./mode.js";
import { createRunNarrator, type RunNarrator } from "./narrate.js";
import { inspectPlan, type Plan, type PlanHostPort } from "./plan.js";
import {
	createPlanCommand,
	PLAN_WORKFLOW_REF,
	type PlanStart,
} from "./plan-command.js";
import { planHostPort } from "./plan-host.js";
import { planDigest, type WorkflowInput } from "./plan-input.js";
import {
	gatedPublishUI,
	isWorkflowShipped,
	type Publication,
	shipPlan,
	WORKFLOW_SHIPPED_CHANNEL,
	watchShippedRuns,
} from "./publish.js";
import { createSeat, type Seat } from "./seat.js";
import {
	createSubagentPlanCheck,
	registerModeCeiling,
} from "./subagent-provider.js";
import {
	acquireWorkflowClient,
	acquireWorkflowClientOrWarn,
	callWorkflow,
	type WorkflowEventBus,
	type WorkflowReadClient,
} from "./workflow-provider.js";

/**
 * Re-exported because the `/mode` handler is the hook's only caller and this
 * is where a reader looks for it. The hook itself, and the whole exit behind
 * it, live in `exit-flow.ts`.
 */
export { beginModeExit, type ModeExitHook };

const DIRECT_MUTATION_TOOLS = new Set(["write", "edit", "delete"]);

/**
 * Why a tool call cannot happen in this posture, or nothing.
 *
 * ONE RULE IS LEFT, and it is the posture itself: plan mode is read-only, and
 * the tools that write directly are the ones it withholds.
 *
 * THE WORKFLOW RULE IS GONE, AND NOT BECAUSE IT WAS WRONG. This seat used to
 * refuse `workflow_run` and `workflow_propose` to the model in plan mode by
 * name, with a fixed sentence, because plan mode is a conversation and a run is
 * the seat acting. The rule was right and the ENFORCEMENT WAS IN THE WRONG
 * PLACE: a tool allowlist here had to be kept in step with whatever tools the
 * runtimes happened to register, and it said nothing at all about the launches
 * those tools make. The mode's ceiling says it once, in pi-subagent's own
 * vocabulary, and travels with every delegated launch in the process —
 * `modeCeiling` in `mode.ts`, registered at session start. pi-workflow refuses a
 * start whose definition needs more than the ceiling allows, naming both, which
 * is a better sentence than this file could write and it is true of every
 * launch rather than of two tool names.
 *
 * There is nothing here about writing a plan either. The document is not a tool
 * call: the hand-off asks the model for it directly, outside the agent loop and
 * with no tools offered at all.
 */
export function seatToolBlockReason(
	mode: ModeName,
	toolName: string,
): string | undefined {
	if (mode === "plan" && DIRECT_MUTATION_TOOLS.has(toolName))
		return `Mode plan is read-only; switch to /mode auto or /mode hack before using ${toolName}.`;
	return undefined;
}

export interface SeatHost {
	registerTool(tool: unknown): void;
	registerCommand(name: string, spec: unknown): void;
	/**
	 * A custom message into the session's own history.
	 *
	 * How the conversation learns what the exit did: one message naming the
	 * plan, its digest and the outcome. Optional, because a host without it is
	 * still a working seat — the person sees the same facts in the notices.
	 */
	sendMessage?(
		message: {
			customType: string;
			content: string;
			display: boolean;
		},
		options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	/**
	 * Pi's live tool set. Optional as a pair: `registerTool` has no inverse, so
	 * withdrawing a tool means naming the set that remains. A host without them
	 * still gets every tool that was available when the seat was built — it just
	 * cannot take one back, which is why the block reason above exists.
	 */
	getActiveTools?(): string[];
	setActiveTools?(toolNames: string[]): void;
	/**
	 * Pi's shared bus, where the workflow runtime answers discovery and where a
	 * decided `ship` is announced. Optional: a seat on a host without one keeps
	 * working — the hand-off takes its documented fallback, and
	 * `/plan ship` says that publication needs the runtime rather than failing
	 * somewhere deeper.
	 */
	readonly events?: WorkflowEventBus;
}

export interface StartSeatOptions {
	readonly cwd?: string;
	readonly agentDir?: string;
	/** @see beginModeExit — overridable so a test can watch the seam fire. */
	readonly beginModeExit?: ModeExitHook;
	/** The hand-off itself — overridable so a test can watch the seam fire. */
	readonly runExitFlow?: (deps: ExitFlowDeps) => Promise<ExitFlowOutcome>;
	/** How the model is asked. Overridable so a test needs no provider. */
	readonly complete?: (ctx: ModeExitContext) => AuthoringComplete;
	/**
	 * The live session, as the two questions a pinned review raises.
	 * @see SeatOptions.host
	 *
	 * Threaded to both readers of one document — the store, and the exit's own
	 * re-validation of a plan it rewrote — because a plan accepted against one
	 * host and re-read against another is a plan this seat refuses in the
	 * middle of its own exit.
	 */
	readonly host?: () => PlanHostPort | undefined;
	/**
	 * The live session, as the id the plan store records as a plan's author.
	 * @see StoreOptions.sessionId
	 *
	 * The extension reads it off whatever context is live; the `/mode` handler's
	 * own learned id is the fallback, so a seat that has only ever seen a
	 * command still knows who is writing.
	 */
	readonly sessionId?: () => string | undefined;
}

export interface SeatEntry {
	seat(): Seat;
	currentMode(): ModeName;
	/** Resolves once the exit flow, if any, has finished. */
	exitSettled(): Promise<void>;
	/**
	 * A session replacement: end an exit flow that is mid-dialog or mid-request.
	 * Idempotent, and a no-op when no flow is open.
	 */
	abortExitFlow(): void;
	/**
	 * Pi binds its action methods (`getActiveTools`, `setActiveTools`) only
	 * after every extension has loaded; until then they throw. The entry
	 * registers tools at load and reconciles the live tool set the first time
	 * this is called (the extension calls it from `session_start`), and on
	 * every mode change after that.
	 */
	runtimeBound(): void;
	/**
	 * Publish a stored plan's run (Flow C), through the acquired workflow client
	 * and the seat's own audited Bash tool. Both trigger paths land here:
	 * `/plan ship <slug>`, and a `maestro:workflow-shipped` announcement.
	 */
	publish(
		plan: Plan,
		ctx: ExtensionContext,
		runId?: string,
		options?: PublishOptions,
	): Promise<Publication>;
	/**
	 * Narrate the runs this seat started, through an acquired client.
	 *
	 * The seat is what KNOWS which runs are its own — the hand-off started one,
	 * or `/plan run` did — and the extension body is what has a client to observe
	 * with, so the two meet here. Returns the unsubscribe; calling it again
	 * replaces the narrator, which is what a new session needs.
	 */
	narrateRuns(client: Pick<WorkflowReadClient, "observe">): () => void;
	/** A dialog opened by Pi or another extension; both flows defer. */
	notePromptStart(): void;
	notePromptEnd(): void;
}

/** What the caller of a publication knows that publication does not. */
export interface PublishOptions {
	/** @see PublishDeps.requireShipDecision — set by the announcement path. */
	readonly requireShipDecision?: boolean;
}

export function startSeat(
	pi: SeatHost,
	options: StartSeatOptions = {},
): SeatEntry {
	const cwd = options.cwd ?? process.cwd();
	let built: Seat | undefined;
	const registered = new Set<string>();
	/**
	 * The session the `/mode` handler last ran in.
	 *
	 * The seat is built before any session context exists and the store records
	 * who wrote a plan, so the id is learned from the first command that carries
	 * one rather than guessed at construction. It is the fallback behind the
	 * live context, which a seat that has only ever seen a command does not have.
	 */
	let sessionId: string | undefined;
	const events = pi.events;
	/**
	 * One gate for every dialog this seat opens.
	 *
	 * The exit flow and publication are both dialog sequences on the same
	 * screen, and Pi's dialogs have no queue. Built here, handed to the exit
	 * controller and wrapped around publication's UI, so that
	 * `ui_prompt_start`/`ui_prompt_end` — which arrive once, on `notePrompt*` —
	 * defer both.
	 */
	const gate = createDialogGate();
	/**
	 * The runs this seat started, by id, so narration knows whose they are.
	 *
	 * Kept even before a narrator exists: a run can be started in the same turn
	 * the workflow runtime is first acquired, and a run this seat started and then
	 * failed to narrate would be exactly the silence narration exists to end.
	 */
	const started = new Map<string, string>();
	let narrator: RunNarrator | undefined;
	const follow = (runId: string, slug: string): void => {
		started.set(runId, slug);
		narrator?.follow(runId, slug);
	};
	/**
	 * What the conversation is told, and the only thing it is told.
	 *
	 * `deliverAs: "nextTurn"` because nothing about this needs a turn of its
	 * own: it is a fact the next turn should have, not a question.
	 */
	const announce: Announce | undefined = pi.sendMessage
		? (message) => {
				pi.sendMessage?.(
					{
						customType: message.customType,
						content: message.content,
						display: message.display,
					},
					{ deliverAs: "nextTurn" },
				);
			}
		: undefined;
	const exit = createModeExitController({
		setMode: (name) => {
			seat().setMode(name);
		},
		// The run the hand-off started is a run this session narrates.
		onStarted: follow,
		cwd,
		gate,
		// How the model is asked: the session's own model, the session's own
		// history, and no tools. The context comes from the `/mode` handler, so
		// the model the plan is written by is the one the person is talking to.
		complete:
			options.complete ??
			((ctx) =>
				(ctx as { model?: unknown }).model
					? createSessionAuthor(ctx as unknown as ExtensionContext)
					: undefined),
		// The exit reads the document it just obtained and writes accepted
		// patches back to it, so it gets the seat's own store rather than a
		// second reader of the same directory.
		store: () => seat().store,
		// The same host the store was given. The hand-off re-validates what it
		// rewrites — `diverse` written onto heavy lenses, every rewrite the plan
		// check asks for — and a reading without the host would refuse the pinned
		// model the store had just accepted.
		...(options.host
			? {
					inspect: (plan: Plan) =>
						inspectPlan(plan, undefined, options.host?.()),
				}
			: {}),
		...(events
			? {
					workflow: (ctx, notify) =>
						acquireWorkflowClientOrWarn(events, ctx, notify),
					// The plan check, built per flow so the context it acquires the
					// subagent runtime with is the session the person is in. A seat
					// with no bus has no check, and the confirmation says so.
					planCheck: (ctx) =>
						createSubagentPlanCheck({
							events,
							context: () => ctx as unknown as ExtensionContext,
							cwd,
						}),
				}
			: {}),
		...(options.runExitFlow ? { flow: options.runExitFlow } : {}),
		...(announce ? { announce } : {}),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
	});
	const onModeExit = options.beginModeExit ?? exit.hook;

	/**
	 * Make Pi's tool set equal the seat's, which is the whole point of declaring
	 * availability: the set is recomputed from the registry on every mode change
	 * rather than remembered anywhere. Foreign tools — Pi's own, and every
	 * workflow tool — are copied through untouched; only names this seat
	 * declares are added or withdrawn.
	 */
	let bound = false;
	const syncTools = (live: Seat): void => {
		const available = live.tools.definitionsFor("maestro");
		for (const tool of available) {
			if (registered.has(tool.name)) continue;
			registered.add(tool.name);
			pi.registerTool(tool);
		}
		// Registration is legal during extension load; reading or writing the
		// live tool set is not until Pi has bound its runtime (`runtimeBound`).
		// The set is recomputed from the registry whenever it is reconciled, so
		// nothing is lost by waiting.
		if (!bound || !pi.getActiveTools || !pi.setActiveTools) return;
		const ours = new Set(live.tools.declaredFor("maestro"));
		const availableNames = new Set(available.map((tool) => tool.name));
		const active = pi.getActiveTools();
		const next = active.filter(
			(name) => !ours.has(name) || availableNames.has(name),
		);
		for (const name of availableNames)
			if (!next.includes(name)) next.push(name);
		if (next.length !== active.length || next.some((n, i) => n !== active[i]))
			pi.setActiveTools(next);
	};

	const seat = (): Seat => {
		if (built) return built;
		const created = createSeat({
			cwd,
			sessionId: () => options.sessionId?.() ?? sessionId,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
			...(options.host ? { host: options.host } : {}),
		});
		built = created;
		// Registration follows the mode, so it follows every route into one —
		// the `/mode` command, and the exit flow's own `setMode`.
		created.onModeChange(() => syncTools(created));
		syncTools(created);
		return created;
	};

	pi.registerCommand("mode", {
		description: `Switch posture. /mode [${MODE_NAMES.join("|")}]`,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// Learned here because this is the first context the seat is ever
			// handed, and the store will not write a plan it cannot name an
			// author for.
			try {
				sessionId = ctx.sessionManager?.getSessionId() ?? sessionId;
			} catch {
				// A replaced session throws from its own context. Nothing to learn.
			}
			const wanted = args.trim().toLowerCase();
			if (!wanted) {
				ctx.ui.notify(`Mode is ${seat().mode().name}.`, "info");
				return;
			}
			if (!MODE_NAMES.includes(wanted as ModeName)) {
				ctx.ui.notify(
					`Unknown mode \`${wanted}\` — one of ${MODE_NAMES.join(", ")}.`,
					"warning",
				);
				return;
			}
			const previous = seat().mode().name;
			// THE WHOLE EXIT RUNS HERE, inside the `/mode` call, because it no
			// longer yields to a model turn: it asks its dialogs, asks the model
			// directly for the description and the document, and ends in a run or
			// in the conversation. It owns the switch it straddles: `stay` is
			// *Keep planning* and every path that ends without a run, `settled`
			// means the flow moved the posture itself, in the order it needed.
			const decision =
				previous !== wanted
					? ((await onModeExit(previous, wanted as ModeName, ctx)) ?? "switch")
					: "switch";
			if (decision === "stay") return;
			const next =
				decision === "settled"
					? seat().mode()
					: seat().setMode(wanted as ModeName);
			ctx.ui.notify(
				`Mode ${next.name}: ${next.cwd === "write" ? "can write" : "read-only"}, safeguards ${next.safeguards}.`,
				"info",
			);
		},
	});

	/**
	 * Flow C, wired from the two things it needs and cannot build itself: the
	 * workflow client that reads the run's receipt, and the seat's own audited
	 * Bash tool. Acquired per publication rather than held, so a runtime that
	 * arrived (or left) since the last one is the runtime this one uses.
	 */
	const publish = async (
		plan: Plan,
		ctx: ExtensionContext,
		runId?: string,
		how: PublishOptions = {},
	): Promise<Publication> => {
		const refuse = (reason: string): Publication => {
			ctx.ui.notify(reason, "error");
			return {
				ok: false,
				stoppedAt: "policy",
				reason,
				commands: [],
				mode: "none",
			};
		};
		if (!pi.events)
			return refuse(
				"publication: this host has no extension bus, so the workflow runtime cannot be reached — cherry-pick the run's handoff refs by hand.",
			);
		const bashTool = seat()
			.tools.definitionsFor("maestro")
			.find((tool) => tool.name === "bash");
		if (!bashTool)
			return refuse(
				"publication: the seat's audited Bash tool is not available, and publication runs every command through it.",
			);
		const client = await acquireWorkflowClientOrWarn(
			pi.events,
			ctx,
			(message, type) => ctx.ui.notify(message, type),
		);
		if (!client)
			return {
				ok: false,
				stoppedAt: "policy",
				reason: "publication: no workflow runtime answered discovery.",
				commands: [],
				mode: "none",
			};
		return shipPlan({
			slug: plan.slug,
			plan,
			provider: client,
			bash: createAuditedBash(bashTool, ctx, "maestro-publish"),
			// Through the seat's one gate: a publication confirm must not land on
			// top of a dialog Pi or another extension already has open.
			ui: gatedPublishUI(ctx.ui, gate),
			workflowRef: PLAN_WORKFLOW_REF,
			// The receipt goes beside the plan, and the store is what knows where
			// that is now that its root is keyed by project.
			store: seat().store,
			...(runId ? { runId } : {}),
			...(how.requireShipDecision ? { requireShipDecision: true } : {}),
		});
	};

	/**
	 * `/plan run <slug>`, wired to the one thing it needs and cannot build: the
	 * workflow client that starts the run.
	 *
	 * Acquired per run, like publication, so a runtime that arrived since the
	 * last one is the runtime this one uses. Every failure — no bus, no runtime,
	 * a refused ref, an input the definition's schema rejects — has already been
	 * reported through the seam's sanitized `notify` by the time this returns
	 * nothing.
	 */
	const startRun = async (
		input: WorkflowInput,
		ctx: ExtensionContext,
	): Promise<string | undefined> => {
		const notify = (message: string, type?: "info" | "warning" | "error") =>
			ctx.ui.notify(message, type);
		if (!pi.events) {
			notify(
				"This host has no extension bus, so the workflow runtime cannot be reached and no run can be started. The plan is stored and unchanged.",
				"warning",
			);
			return undefined;
		}
		const client = await acquireWorkflowClientOrWarn(pi.events, ctx, notify);
		if (!client) return undefined;
		// THE CURRENT MODE'S CEILING: `/plan run` is a person starting a run from
		// wherever they are standing, so the bound is the posture they are in. In
		// plan mode that is read-only, and pi-workflow refuses `plan-to-ship` —
		// which needs worktrees — naming both the need and the bound.
		const ceiling = modeCeiling(seat().mode().name);
		const receipt = await callWorkflow(
			() =>
				client.startBuiltin(PLAN_WORKFLOW_REF, {
					input,
					effort: input.effort,
					...(ceiling ? { ceiling } : {}),
				}),
			notify,
		);
		// `/plan run` is the other way a run of this seat's begins, and it is
		// narrated exactly like the hand-off's.
		if (receipt) follow(receipt.runId, input.plan.slug);
		return receipt?.runId;
	};

	const planCommand = createPlanCommand({
		// A getter, not the store: `seat()` builds lazily, and building it at
		// registration time would undo that.
		get store() {
			return seat().store;
		},
		// `/plan`'s handler passes the whole command context through; `PlanShip`
		// and `PlanStart` narrow it to `ui` and `hasUI` so a test can hand over a
		// fake, not because the value here is ever less than a session context.
		ship: (plan, ctx) => publish(plan, ctx as ExtensionContext),
		start: ((input, ctx) =>
			startRun(input, ctx as ExtensionContext)) satisfies PlanStart,
	});
	pi.registerCommand("plan", planCommand);

	return {
		seat,
		currentMode: () => built?.mode().name ?? "plan",
		exitSettled: exit.settled,
		abortExitFlow: exit.abort,
		runtimeBound: () => {
			bound = true;
			if (built) syncTools(built);
		},
		publish,
		narrateRuns: (client) => {
			narrator?.stop();
			const live = createRunNarrator({
				client,
				send: (message, options) => pi.sendMessage?.(message, options),
			});
			narrator = live;
			for (const [runId, slug] of started) live.follow(runId, slug);
			return () => {
				if (narrator === live) narrator = undefined;
				live.stop();
			};
		},
		notePromptStart: exit.notePromptStart,
		notePromptEnd: exit.notePromptEnd,
	};
}

/**
 * The stored plan a ship announcement is about, found by its digest.
 *
 * By DIGEST, not by slug: the announcement names the bytes the run was given,
 * and a slug whose document has since been rewritten is a different plan. A
 * plan that no longer matches is simply not found, and publication says so
 * instead of publishing against a document nobody approved.
 */
export function planForDigest(
	store: Seat["store"],
	digest: string,
): Plan | undefined {
	for (const summary of store.list()) {
		let plan: Plan | null = null;
		try {
			plan = store.loadPlan(summary.slug);
		} catch {
			// One unreadable plan must not hide the rest.
			continue;
		}
		if (plan && planDigest(plan) === digest) return plan;
	}
	return undefined;
}

export default defineExtension(
	{
		name: "maestro",
		path: "packages/maestro/src/extension.ts",
		doc: "Author plans and enforce the interactive seat posture.",
	},
	async (pi, maestro) => {
		/**
		 * The last live session context, which a bus listener has no other way to
		 * get: `pi.events.on` hands over data and nothing else, and publication
		 * needs a UI to confirm with and a context to run the Bash tool in.
		 * Refreshed by every event that carries one, and dropped when the session
		 * it belongs to is replaced — an old context throws when it is used.
		 *
		 * Declared before the seat because plan validation reads it too: a plan
		 * that pins a review model or skill is checked against this session, and
		 * `undefined` here means the pin is refused rather than trusted.
		 */
		let live: ExtensionContext | undefined;
		const entry = startSeat(pi, {
			// The model catalogue comes from the live context; the loaded skills
			// come from `pi` itself, which is the only place an extension can ask.
			host: () => planHostPort(live, pi),
			// The same live context answers who is writing a plan. A replaced
			// session throws from its own context, and an unknown author is
			// `undefined` here rather than a placeholder — the store refuses to
			// write a plan it cannot name the author of.
			sessionId: () => {
				try {
					return live?.sessionManager?.getSessionId();
				} catch {
					return undefined;
				}
			},
		});
		entry.seat();
		// THE MODE'S CEILING, REGISTERED ONCE, for the whole process.
		//
		// Not per session: the posture lives on the seat and outlives any one
		// session, and pi-subagent refuses a second registration by name — so
		// re-registering on `session_start` would turn the second session into an
		// unbounded one. The provider is a closure over `currentMode`, asked at
		// launch time, so a mode change under a running session bounds the next
		// launch rather than the one that was registered.
		if (pi.events) {
			const registered = registerModeCeiling(pi.events, entry.currentMode);
			if ("problem" in registered)
				// A seat whose delegations are bounded by somebody else's ceiling is
				// a fact worth saying once, not a reason to fail to load.
				pi.on("session_start", (_event, ctx) => {
					ctx.ui.notify(
						`The seat's delegation ceiling was not registered: ${registered.problem}. Launches in this session are bounded by whatever else registered one.`,
						"warning",
					);
				});
		}
		pi.on("tool_call", (event) => {
			const reason = seatToolBlockReason(entry.currentMode(), event.toolName);
			if (reason) return { block: true, reason };
		});
		/**
		 * Watch owned runs for a ship decided outside this session's prompt, once
		 * a context exists to acquire the runtime with. Silent when there is no
		 * runtime: a seat without pi-workflow is a working seat, and a warning per
		 * turn would say otherwise.
		 */
		let unwatch: (() => void) | undefined;
		const watch = (ctx: ExtensionContext): void => {
			if (unwatch || !pi.events) return;
			// Claimed before the await, so two events in the same tick cannot both
			// subscribe.
			unwatch = () => undefined;
			const events = pi.events;
			void (async () => {
				try {
					const client = await acquireWorkflowClient(events, ctx);
					// TWO SUBSCRIPTIONS ON ONE CLIENT, for two different jobs: the ship
					// watcher looks for a decision made outside this session's prompt,
					// and the narrator says what the run is doing while it does it.
					const unship = watchShippedRuns({
						client,
						emit: (shipped) => events.emit(WORKFLOW_SHIPPED_CHANNEL, shipped),
						// A finished run whose ship gate proves nothing is named out
						// loud in whatever session is live, because the alternative is
						// a run with real handoffs that silently never publishes.
						report: (message) => live?.ui.notify(message, "warning"),
					});
					const unnarrate = entry.narrateRuns(client);
					unwatch = () => {
						unship();
						unnarrate();
					};
				} catch {
					// No runtime, or one this seat was not built against: the
					// `/plan ship` path still works and says so itself.
				}
			})();
		};
		// Nothing about the plan comes through here any more: the exit asks the
		// model for the document itself. What is left is the one thing a bus
		// listener cannot get for itself — a live session context.
		pi.on("tool_result", (_event, ctx) => {
			live = ctx;
			watch(ctx);
		});
		pi.on("turn_start", (_event, ctx) => {
			live = ctx;
			watch(ctx);
		});

		// Flow C's trigger. The parked-run observer announces its own
		// `{"ship": true}`; `watchShippedRuns` announces a decision made through
		// `/workflow decide`, which never reaches that prompt. Both arrive here as
		// one channel, and the announcement is not the authority: publication
		// re-inspects the run, PROVES `{"ship": true}` from its own `ship`
		// checkpoint, checks the digest against the stored plan, and asks the one
		// confirmation the spec names before it pushes. There is no second "was it
		// shipped?" dialog, because that question now has an answer.
		if (pi.events) {
			pi.events.on(WORKFLOW_SHIPPED_CHANNEL, (data) => {
				if (!isWorkflowShipped(data)) return;
				const ctx = live;
				if (!ctx) return;
				void (async () => {
					try {
						const plan = planForDigest(entry.seat().store, data.planDigest);
						if (!plan) {
							ctx.ui.notify(
								`A run shipped plan digest \`${data.planDigest}\`, which no stored plan matches — publish it by hand from its handoff refs.`,
								"warning",
							);
							return;
						}
						await entry.publish(plan, ctx, data.runId, {
							requireShipDecision: true,
						});
					} catch (error) {
						// A replaced session throws from its own context; a publication
						// that cannot be reported is over either way.
						void error;
					}
				})();
			});
		}
		// A dialog opened by Pi or another extension replaces an open one and the
		// replaced promise never resolves, so the exit flow defers while one is on
		// screen. The event is not in this pi version's typed overloads and `on`
		// accepts any name, so the subscription is made through a widened
		// signature: on a host that never emits it, nothing defers and nothing
		// breaks.
		const subscribe = pi.on.bind(pi) as unknown as (
			event: string,
			handler: () => void,
		) => void;
		subscribe("ui_prompt_start", () => entry.notePromptStart());
		subscribe("ui_prompt_end", () => entry.notePromptEnd());
		// A new, resumed or forked session replaces the one a dialog sequence was
		// asked in, and an `ExtensionContext` from the old one throws. Ending the
		// flow here is what keeps a half-answered exit from writing a record for a
		// session that is gone.
		pi.on("session_start", () => {
			entry.runtimeBound();
			entry.abortExitFlow();
			// The watcher holds a context from the session that is gone, and the
			// announcement it would make could not be asked about anywhere.
			unwatch?.();
			unwatch = undefined;
			live = undefined;
		});
		maestro.capabilities.register(CAPABILITIES.modes, {
			current: entry.currentMode,
			onChange: (listener) => entry.seat().onModeChange(listener),
		});
		const { installMaestroObservability } = await import("./observability.js");
		installMaestroObservability(pi, entry.currentMode);
	},
);
