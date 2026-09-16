import type {
	ExtensionCommandContext,
	ExtensionContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { createAuditedBash } from "./bash-tool.js";
import {
	beginModeExit,
	createModeExitController,
	type ModeExitHook,
} from "./exit-flow.js";
import { MODE_NAMES, type ModeName } from "./mode.js";
import { workflowInputFile } from "./paths.js";
import { hasPendingExit } from "./pending-exit.js";
import type { Plan } from "./plan.js";
import { createPlanCommand, PLAN_WORKFLOW_REF } from "./plan-command.js";
import { EFFORTS, planDigest } from "./plan-input.js";
import {
	isWorkflowShipped,
	type Publication,
	shipPlan,
	WORKFLOW_SHIPPED_CHANNEL,
	watchShippedRuns,
} from "./publish.js";
import { createSeat, planToolAvailable, type Seat } from "./seat.js";
import {
	acquireWorkflowClient,
	acquireWorkflowClientOrWarn,
	type WorkflowEventBus,
} from "./workflow-provider.js";

/**
 * Re-exported because the `/mode` handler is the hook's only caller and this
 * is where a reader looks for it. The hook itself, and phase 1 behind it, live
 * in `exit-flow.ts`.
 */
export { beginModeExit, type ModeExitHook };

const DIRECT_MUTATION_TOOLS = new Set(["write", "edit", "delete"]);

/**
 * Why a tool call cannot happen in this posture, or nothing.
 *
 * `plan` is here as defence in depth only: the registration already withholds
 * it (`planToolAvailable`), so a call that reaches this point means a host kept
 * a stale tool set. Worth a named refusal rather than a silent write.
 *
 * Nothing else is gated by mode. Workflow tools in particular are left alone:
 * a run touches neither this working tree nor the host, so starting one from
 * plan mode is intended, not an oversight.
 */
export function seatToolBlockReason(
	mode: ModeName,
	toolName: string,
	pendingExit = false,
): string | undefined {
	if (mode === "plan" && DIRECT_MUTATION_TOOLS.has(toolName))
		return `Mode plan is read-only; switch to /mode auto or /mode hack before using ${toolName}.`;
	if (toolName === "plan" && !planToolAvailable(mode, pendingExit))
		return "The `plan` tool is not held in plan mode; it is offered on the way out, so switch with /mode auto or /mode hack and write the plan there.";
	return undefined;
}

/**
 * What a stored plan write should say, once, to the human watching.
 *
 * The tool result already tells the MODEL how to run the plan. This is the
 * other half, and now also the one place a human is told where the `plan` tool
 * lives: plan mode is the conversation and does not hold it, the exit offers it,
 * and a workflow run is allowed from either posture because it touches neither
 * the working tree nor the host.
 *
 * Returns the text rather than notifying, so the decision is testable without a
 * UI and so the event wiring stays one line.
 */
export function planStoredNotice(
	event: Pick<ToolResultEvent, "toolName" | "isError" | "details">,
	mode: ModeName,
): string | undefined {
	if (event.toolName !== "plan" || event.isError) return undefined;
	const details = event.details as
		| { stored?: unknown; slug?: unknown }
		| undefined;
	if (details?.stored !== true || typeof details.slug !== "string")
		return undefined;
	return (
		`Stored plan \`${details.slug}\`. Run it with \`/plan run ${details.slug} [${EFFORTS.join("|")}]\`; ` +
		`approval happens at the run's \`approve-plan\` checkpoint.` +
		" The `plan` tool is not held in plan mode — only while leaving it — but a" +
		" workflow run, research included, may be started from plan mode: it touches" +
		" neither this working tree nor the host." +
		(mode === "plan"
			? " To hand-edit instead, leave this posture with `/mode auto`."
			: "")
	);
}

export interface SeatHost {
	registerTool(tool: unknown): void;
	registerCommand(name: string, spec: unknown): void;
	/**
	 * Steering text for the session. Optional because the seat must start on a
	 * host that has none; `/plan run` then prints the call instead of injecting
	 * it, rather than pretending it handed something over.
	 */
	sendUserMessage?(
		content: string,
		options?: { deliverAs?: "steer" | "followUp" },
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
	 * working, and `/plan ship` says that publication needs the runtime rather
	 * than failing somewhere deeper.
	 */
	readonly events?: WorkflowEventBus;
}

export interface StartSeatOptions {
	readonly cwd?: string;
	readonly agentDir?: string;
	/** @see SeatOptions.pendingExit — the exit flow's record, once it exists. */
	readonly pendingExit?: () => boolean;
	/** @see beginModeExit — overridable so a test can watch the seam fire. */
	readonly beginModeExit?: ModeExitHook;
}

export interface SeatEntry {
	seat(): Seat;
	currentMode(): ModeName;
	pendingExit(): boolean;
	/**
	 * A session replacement: end an exit flow that is mid-dialog and drop its
	 * record. Idempotent, and a no-op when no flow is open.
	 */
	abortExitFlow(): void;
	/**
	 * Publish a stored plan's run (Flow C), through the acquired workflow client
	 * and the seat's own audited Bash tool. Both trigger paths land here:
	 * `/plan ship <slug>`, and a `maestro:workflow-shipped` announcement.
	 */
	publish(
		plan: Plan,
		ctx: ExtensionContext,
		runId?: string,
	): Promise<Publication>;
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
	 * The seat is built before any session context exists, and the pending
	 * record is keyed by session, so the id is learned from the first command
	 * that carries one rather than guessed at construction.
	 */
	let sessionId: string | undefined;

	/**
	 * Is an exit in progress? A record that cannot be read answers `false`: it
	 * is not a window this will open on trust, and phase 1 is where the human is
	 * told about it, loudly, with the path to remove.
	 */
	const pendingExit =
		options.pendingExit ??
		(() => {
			if (!sessionId) return false;
			try {
				return hasPendingExit(sessionId, options.agentDir);
			} catch {
				return false;
			}
		});

	const exit = createModeExitController({
		setMode: (name) => {
			seat().setMode(name);
		},
		cwd,
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		...(pi.sendUserMessage
			? { sendUserMessage: pi.sendUserMessage.bind(pi) }
			: {}),
	});
	const onModeExit = options.beginModeExit ?? exit.hook;

	/**
	 * Make Pi's tool set equal the seat's, which is the whole point of declaring
	 * availability: the set is recomputed from the registry on every mode change
	 * rather than remembered anywhere. Foreign tools — Pi's own, and every
	 * workflow tool — are copied through untouched; only names this seat
	 * declares are added or withdrawn.
	 */
	const syncTools = (live: Seat): void => {
		const available = live.tools.definitionsFor("maestro");
		for (const tool of available) {
			if (registered.has(tool.name)) continue;
			registered.add(tool.name);
			pi.registerTool(tool);
		}
		if (!pi.getActiveTools || !pi.setActiveTools) return;
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
			pendingExit,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
		});
		built = created;
		// Registration follows the mode, so it follows every route into one —
		// the `/mode` command today, the exit flow's own `setMode` tomorrow.
		created.onModeChange(() => syncTools(created));
		syncTools(created);
		return created;
	};

	pi.registerCommand("mode", {
		description: `Switch posture. /mode [${MODE_NAMES.join("|")}]`,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// The session id is learned here because this is the first context the
			// seat is ever handed; the pending record is keyed by it.
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
			// Phase 1 of the exit flow belongs here, before the posture changes,
			// because everything it asks about is what the human knows and the
			// plan does not yet say. It owns the switch it straddles: `stay` is
			// *Keep planning* and an aborted or refused flow, `settled` means the
			// flow moved the posture itself, in the order it needed.
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
			"run",
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
			ui: ctx.ui,
			workflowRef: PLAN_WORKFLOW_REF,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
			...(runId ? { runId } : {}),
		});
	};

	const planCommand = createPlanCommand({
		// A getter, not the store: `seat()` builds lazily, and building it at
		// registration time would undo that.
		get store() {
			return seat().store;
		},
		inputPath: (slug) => workflowInputFile(slug, options.agentDir),
		// `/plan`'s handler passes the whole command context through; `PlanShip`
		// narrows it to `ui` and `hasUI` so a test can hand over a fake, not
		// because the value here is ever less than a session context.
		ship: (plan, ctx) => publish(plan, ctx as ExtensionContext),
		...(pi.sendUserMessage
			? { sendUserMessage: pi.sendUserMessage.bind(pi) }
			: {}),
	});
	pi.registerCommand("plan", planCommand);

	return {
		seat,
		currentMode: () => built?.mode().name ?? "plan",
		pendingExit,
		abortExitFlow: exit.abort,
		publish,
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
		const entry = startSeat(pi);
		entry.seat();
		pi.on("tool_call", (event) => {
			const reason = seatToolBlockReason(
				entry.currentMode(),
				event.toolName,
				entry.pendingExit(),
			);
			if (reason) return { block: true, reason };
		});
		/**
		 * The last live session context, which a bus listener has no other way to
		 * get: `pi.events.on` hands over data and nothing else, and publication
		 * needs a UI to confirm with and a context to run the Bash tool in.
		 * Refreshed by every event that carries one, and dropped when the session
		 * it belongs to is replaced — an old context throws when it is used.
		 */
		let live: ExtensionContext | undefined;
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
					unwatch = watchShippedRuns({
						client,
						emit: (shipped) => events.emit(WORKFLOW_SHIPPED_CHANNEL, shipped),
					});
				} catch {
					// No runtime, or one this seat was not built against: the
					// `/plan ship` path still works and says so itself.
				}
			})();
		};
		pi.on("tool_result", (event, ctx) => {
			live = ctx;
			watch(ctx);
			const notice = planStoredNotice(event, entry.currentMode());
			if (notice) ctx.ui.notify(notice, "info");
			// Phase 2 of the exit flow attaches here (M3-EXIT2, the
			// `continueModeExit` seam in `exit-flow.ts`). Nothing of it ships yet.
		});
		pi.on("turn_start", (_event, ctx) => {
			live = ctx;
			watch(ctx);
		});

		// Flow C's trigger. The parked-run observer announces its own
		// `{"ship": true}`; `watchShippedRuns` announces a decision made through
		// `/workflow decide`, which never reaches that prompt. Both arrive here as
		// one channel, and the announcement is not the authority: the digest is
		// still checked against the stored plan, and a human still confirms.
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
						const go = await ctx.ui.confirm(
							"Publish this run?",
							`Run \`${data.runId}\` shipped \`${plan.slug}\` — ${plan.title}.\n` +
								"Publication branches, cherry-picks, runs the repository's check on the host, and asks again before pushing.",
						);
						if (!go) return;
						await entry.publish(plan, ctx, data.runId);
					} catch (error) {
						// A replaced session throws from its own context; a publication
						// that cannot be reported is over either way.
						void error;
					}
				})();
			});
		}
		// A new, resumed or forked session replaces the one a dialog sequence was
		// asked in, and an `ExtensionContext` from the old one throws. Ending the
		// flow here is what keeps a half-answered exit from writing a record for a
		// session that is gone.
		pi.on("session_start", () => {
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
