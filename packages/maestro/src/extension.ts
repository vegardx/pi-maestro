// The extension entry.
//
// One process runs a maestro, a worker, or a read-only agent, and which one is
// decided here, from the environment, once. The old system had a
// `disableExtensions` env kill switch for this: a child was told which parts
// of its parent to switch off,
// which meant the parent had to remember to tell it, and a forgotten entry gave
// a worker the maestro's whole surface. Here the surface is not switched off —
// it is never registered, because this process knows what it is.
//
// That makes one guard structural rather than remembered. `/mode` used to need
// an operator-only check so a spawned agent could not widen its own posture;
// now an agent process never registers the command at all.
//
// Registration is synchronous and the connection is not. Tools go in at load
// time, before pi has finished starting, and the link resolves behind them; a
// tool called before the handshake completes says so, instead of hanging.

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Answers, AskInboxV1, Questionnaire } from "@vegardx/pi-contracts";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { PersonaCatalogue } from "./agent.js";
import {
	type AgentWiring,
	createAskTransport,
	declareAgentTools,
	dialHome,
	type Reporter,
	readWiring,
	type SubagentDeps,
} from "./agent-runtime.js";
import { createBashTool } from "./bash-tool.js";
import { createCommitTool } from "./commit-tool.js";
import { createDeleteTool } from "./delete-tool.js";
import { readExecutionPolicySettings } from "./execution-policy.js";
import type { AgentLink } from "./link.js";
import { MODE_NAMES, type ModeName, mode, modeForChild } from "./mode.js";
import { routeSpawn } from "./model-routing.js";
import { maestroRoot } from "./paths.js";
import { BUILT_IN_PERSONAS } from "./personas.js";
import type { Plan } from "./plan.js";
import {
	createReadOnlySessionFactory,
	type ReadOnlyLaunchOptions,
} from "./read-only-session.js";
import { createSeat, type Seat } from "./seat.js";
import { currentDepth, describeReadOnlyTools } from "./spawn.js";
import { SubagentSessions } from "./subagent-sessions.js";
import { ToolRegistry } from "./tool-registry.js";
import {
	loadOrCreateWorkflowCommandRun,
	releaseUnapprovedWorkflowCommandRun,
	releaseWorkflowCommandRun,
	workflowCommandAuthoredDigest,
} from "./workflow/command-run.js";
import type {
	WorkflowPlanRunnerInput,
	WorkflowPlanRunnerResult,
} from "./workflow/workflow-plan-runner.js";
import { resolveBase } from "./workspace.js";

/** This file, so a spawned agent loads the same code its maestro is running. */
export function extensionPath(): string {
	return fileURLToPath(import.meta.url);
}

/**
 * `packages/research-tools`, which defines `websearch` and `webfetch`.
 *
 * Loaded into every agent because the classifier REDIRECTS to `webfetch`: a
 * `curl` of a read-only URL is refused with "use the webfetch tool". While this
 * was not loaded, that refusal named a tool nobody had — pi defines no
 * `webfetch`, and nothing else supplied one — so an agent asked to fetch a page
 * was told no, twice, with no way through.
 */
export function researchToolsPath(): string {
	return fileURLToPath(
		new URL("../../research-tools/src/index.ts", import.meta.url),
	);
}

/** `packages/ask`, which defines the `ask` tool AND the inbox `respond` uses. */
export function askPath(): string {
	return fileURLToPath(new URL("../../ask/src/index.ts", import.meta.url));
}

/**
 * What a spawned agent loads.
 *
 * `packages/ask` is here because without it a worker has NO `ask` TOOL. It
 * registered an `ask-transport.v1` — the routing for a tool it did not hold —
 * so the whole question chain was unreachable from a worker, and the tests
 * passed because they called `AgentLink.ask()` directly rather than through
 * anything a model could invoke. A transport for a tool nobody has is the same
 * phantom as a refusal naming a tool nobody has.
 */
export function agentExtensions(): readonly string[] {
	return [extensionPath(), askPath(), researchToolsPath()];
}

/**
 * The `subagent` wiring an agent process hands to `declareAgentTools`.
 *
 * Shared between the worker and the reader paths because it is the same
 * relationship in both: consult a read-only agent, wait for what it reports.
 * Only the depth source differs — a worker reads it off its wiring, a reader
 * off the environment — and `checkSpawn` caps both in one place.
 */
function subagentDepsFor(options: {
	readonly depth: () => number;
	readonly launch: ReadOnlyLaunchOptions;
	readonly registry: () => ToolRegistry;
}): { readonly deps: SubagentDeps; readonly sessions: SubagentSessions } {
	let personas: PersonaCatalogue | undefined;
	const openSession = createReadOnlySessionFactory(options.launch);
	// This process's held readers. One registry per process: what this process
	// starts is what this process may re-ask, and nothing else can reach in.
	const sessions = new SubagentSessions(openSession);
	const deps: SubagentDeps = {
		cwd: () => process.cwd(),
		depth: options.depth,
		sessions,
		// A spawned reader inherits its caller's model unless a roster says
		// otherwise; a named family resolves through the roster or is refused;
		// a fan-out resolves the spread its lead's brief will carry.
		route: (request, ctx) => routeSpawn(ctx as ExtensionContext, request),
		// THE SAME personas the maestro declares. An agent handing over a
		// review has to hand over the real review persona — the prose that
		// says what to look for — not a sentence this file made up about
		// one. Declared lazily only because the registry it validates
		// against is the one being built around this wiring.
		briefFor: (persona) => {
			personas ??= PersonaCatalogue.declare(
				BUILT_IN_PERSONAS,
				options.registry(),
			);
			const found = personas.require(persona);
			// This tool starts read-only agents only; a writer's persona
			// (`deliverable-worker`) is refused rather than smuggled in.
			if (found.kind !== "read-only")
				throw new Error(
					`persona \`${persona}\` is for a ${found.kind}, which this tool does not start — writers are plan-authored`,
				);
			return `${found.prose}\n\n${describeReadOnlyTools()}`;
		},
	};
	return { deps, sessions };
}

/**
 * Register the agent surface and start dialling home.
 *
 * Exported so a test can hand it a fake `pi` — the alternative is asserting on
 * a module's load-time side effects, which is how an entry point becomes the
 * thing nobody dares change.
 */
export function startWorker(
	pi: {
		registerTool(tool: unknown): void;
		on?(event: "session_shutdown", handler: () => void): void;
	},
	wiring: AgentWiring,
	launch: ReadOnlyLaunchOptions,
	capabilities?: {
		register(id: typeof CAPABILITIES.askTransport, value: unknown): unknown;
	},
): Promise<AgentLink> {
	let link: AgentLink | undefined;

	const subagent = subagentDepsFor({
		depth: () => wiring.depth,
		launch,
		registry: () => registry,
	});

	const reporter = (): Reporter => {
		if (!link)
			throw new Error(
				"not connected to maestro yet — the handshake has not completed",
			);
		return link;
	};

	const registry: ToolRegistry = ToolRegistry.declare(
		declareAgentTools({
			// No `confirm`: an agent runs unattended, so a command that needs a
			// human is refused rather than left prompting into a void.
			bash: createBashTool({
				holder: "worker",
				cwd: process.cwd(),
				// A worker is never in hack — safeguards do not propagate — so its
				// posture is fixed at the one `modeForChild` gives it.
				mode: () => modeForChild(mode("auto"), "worker"),
				policy: () => readExecutionPolicySettings(process.cwd()),
			}),
			// The other half of the shell decision. A worker commits through this
			// and never through bash: its branch ref lives in the SHARED git dir,
			// which the write profile denies — rightly, since a worker rewriting
			// branches that are not its own is what that deny is for.
			commit: createCommitTool({ cwd: () => process.cwd() }),
			remove: createDeleteTool(),
			reporter,
			subagent: subagent.deps,
		}),
	);

	// A worker holds worker tools. There is no list to keep in step with this
	// one — the holder is the whole selector.
	for (const tool of registry.definitionsFor("worker")) pi.registerTool(tool);

	// Hygiene, not the mechanism: held readers are child processes of this
	// worker and die with it. Stopping them here just makes the exit orderly
	// instead of leaving the reaping to the process tree.
	pi.on?.("session_shutdown", () => void subagent.sessions.stopAll());

	// `ask.v1` routes through whatever transport is registered. Registering one
	// here is the whole of "a worker's question goes to its maestro" — the agent
	// calls the same `ask` a maestro does, and position decides the destination.
	// Registered before the handshake completes, like the tools, and it says so
	// if called too early rather than hanging.
	capabilities?.register(CAPABILITIES.askTransport, {
		present: (questions: Questionnaire) =>
			createAskTransport(() => {
				if (!link)
					throw new Error("cannot ask yet — the handshake has not completed");
				return link;
			}).present(questions),
	});

	return dialHome(wiring).then((connected) => {
		link = connected;
		connected.status("working");
		// The maestro sees this worker's held readers in its own listing, so a
		// human watching the seat can tell "the worker is consulting a reviewer"
		// from "the worker has gone quiet". Wired only once the handshake is
		// done: a change made before there was a wire is fine to lose, because
		// every message is the FULL map and the snapshot sent right here catches
		// the maestro up.
		subagent.sessions.onChange((held) => connected.subagents(held));
		connected.subagents(subagent.sessions.list());
		return connected;
	});
}

/**
 * Register the read-only agent surface: a gated shell and `subagent`, nothing
 * else.
 *
 * This used to be a bare early return — a no-wiring child registered NOTHING,
 * and ran on its launched allowlist alone. Two rulings changed that. Every
 * agent holds `subagent`, because depth is the cap and that is what MAX_DEPTH
 * exists for: a reader consulting another reader is ordinary. And a reader
 * holds a confined shell, because "a shell is a write tool" predated ambient
 * confinement — the classifier refuses write-effect commands for a read-only
 * holder AND the kernel write profile scopes it to scratch space, so the
 * shell reads while unable to write the tree. pi's `edit`/`write` stay
 * withheld: they write in-process, where the sandbox cannot see them.
 *
 * Deliberately minimal beyond those two: no commands, no ask transport, no
 * reporter. A reader's caller is blocked on it — its only channel is the
 * answer it returns — so there is nothing to dial and nobody to ask.
 */
export function startReadOnlyAgent(
	pi: { registerTool(tool: unknown): void },
	launch: ReadOnlyLaunchOptions,
): void {
	const registry: ToolRegistry = ToolRegistry.declare(
		declareAgentTools({
			// No `confirm`, same as the worker: a reader runs unattended, so a
			// command that needs a human is refused rather than left prompting
			// into a void.
			bash: createBashTool({
				holder: "read-only",
				cwd: process.cwd(),
				// Fixed at plan — read-only cwd, safeguards on. A reader has no
				// seat whose posture could change under it, and safeguards never
				// propagate anyway.
				mode: () => mode("plan"),
				policy: () => readExecutionPolicySettings(process.cwd()),
			}),
			// No `commit`, no `remove`: both are write tools, and the classifier's
			// read-only branch refuses the commands that would be redirected to
			// them before any redirect can name them.
			reporter: () => {
				// Unreachable: `finish` is declared with every registry — the
				// declaration is shared — but granted to workers only, and this
				// process registers the read-only grant. A reader reports to its
				// caller by returning, not to a maestro.
				throw new Error("a read-only agent has no maestro to report to");
			},
			subagent: subagentDepsFor({
				depth: () => currentDepth(),
				launch,
				registry: () => registry,
			}).deps,
			// No shutdown hook here: this minimal host has no event surface, and
			// a reader's held children die with it — the process tree reaps.
		}),
	);

	for (const tool of registry.definitionsFor("read-only"))
		pi.registerTool(tool);
}

export interface SeatHost {
	registerTool(tool: unknown): void;
	registerCommand(name: string, spec: unknown): void;
	sendUserMessage(text: string, opts?: unknown): unknown;
	on?(event: "session_shutdown", handler: () => void): void;
}

/** The slice of `ask.v1` the seat uses: one blocking question, one answer. */
export interface HumanAsker {
	ask(questions: Questionnaire): Promise<Answers>;
}

export interface WorkflowPlanRunnerLoaderInput {
	readonly coordinatedRunRoot: string;
	readonly maestroStateRoot: string;
	readonly coordinatedRepositoryRoots: readonly string[];
	/** Normalized plan bound to the same repository roots. */
	readonly plan: Plan;
}

export interface LoadedWorkflowPlanRunner {
	run(input: WorkflowPlanRunnerInput): Promise<WorkflowPlanRunnerResult>;
}

/** Kill switch for the workflow-native execution path. */
export const WORKFLOW_CUTOVER_FLAG = "workflowCutover";

/**
 * Put one question to the human, and report who actually answered.
 *
 * `ask.v1` has an idle autopilot whose answers carry `source: "maestro-auto"`,
 * and a blocking question can be deferred. Both come back as an answer, and
 * neither is a human ruling — so the attribution is read off the answer rather
 * than assumed from the fact that we asked.
 */
export function askThroughCapability(asker: HumanAsker): (
	question: string,
) => Promise<{
	readonly answer: string;
	readonly from: "maestro" | "human";
}> {
	return async (question) => {
		const answers = await asker.ask([
			{ id: "maestro", question, allowFreeText: true, blocking: true },
		]);
		const answer = answers[0];
		if (!answer || answer.deferred || answer.skipped || !answer.value.trim())
			return {
				answer:
					"nobody answered this. Decide for yourself and say in your hand-off what you assumed.",
				from: "maestro",
			};
		return {
			answer: answer.value,
			from: answer.source === "human" ? "human" : "maestro",
		};
	};
}

function planOnlyPullRequestCopy(plan: Plan, repositoryKey: string) {
	const deliverables = plan.deliverables.filter(
		(deliverable) => (deliverable.repo ?? plan.repos[0]?.key) === repositoryKey,
	);
	const rationale = deliverables
		.flatMap((deliverable) => [
			deliverable.body,
			...deliverable.tasks.filter((task) => !task.by).map((task) => task.body),
		])
		.filter((body): body is string => Boolean(body?.trim()));
	const changes = deliverables.flatMap((deliverable) =>
		deliverable.tasks.filter((task) => !task.by).map((task) => task.title),
	);
	if (rationale.length === 0)
		throw new Error(
			`plan \`${plan.slug}\` has no authored rationale for ${repositoryKey}; refusing to invent pull-request rationale`,
		);
	if (changes.length === 0)
		throw new Error(
			`plan \`${plan.slug}\` has no implementation changes for ${repositoryKey}`,
		);
	return {
		title: plan.title,
		intent: `Implement the approved \`${plan.slug}\` plan in ${repositoryKey}.`,
		rationale: rationale.join("\n\n"),
		changes,
	};
}

/**
 * Register the seat tools and the commands a human drives it with.
 *
 * The seat is built on first use, not at load. Constructing it reads the
 * repository to find a base branch, and an extension that does that at load
 * time is an extension that fails to load outside a repository.
 */
export function startSeat<WorkflowCoordinator = never>(
	pi: SeatHost,
	options: {
		readonly cwd?: string;
		readonly agentDir?: string;
		readonly asker?: HumanAsker;
		/**
		 * Where a worker's question goes. Resolved lazily: the inbox is
		 * registered by `packages/ask`, and load order is not ours to depend on.
		 */
		readonly inbox?: () => AskInboxV1 | undefined;
		/**
		 * Coordinator inspection seam for the workflow-native path. It is
		 * loaded lazily so depth>0 processes never import the supervisor graph.
		 */
		readonly workflowCutover?: boolean;
		readonly loadWorkflowCoordinator?: () => Promise<WorkflowCoordinator>;
		/** Fully composed depth-zero production authority, constructed per run. */
		readonly loadWorkflowPlanRunner?: (
			input: WorkflowPlanRunnerLoaderInput,
		) => Promise<LoadedWorkflowPlanRunner>;
	} = {},
): {
	seat(): Seat;
	currentMode(): ModeName;
	workflowCoordinator(): Promise<WorkflowCoordinator | undefined>;
} {
	const cwd = options.cwd ?? process.cwd();
	let built: Seat | undefined;
	let workflowCoordinator: Promise<WorkflowCoordinator> | undefined;
	const workflowRunners = new Map<string, Promise<LoadedWorkflowPlanRunner>>();

	const seat = (): Seat => {
		if (built) return built;
		const base = resolveBase(cwd);
		built = createSeat({
			narrator: {
				// Narration reaches the maestro's own model as a follow-up. That is
				// also how it learns what its fleet did — there is no HUD, and a
				// seat that cannot see its workers cannot answer for them.
				say: (line) =>
					pi.sendUserMessage(`[maestro] ${line}`, { deliverAs: "followUp" }),
				ask: (prompt) => pi.sendUserMessage(prompt, { deliverAs: "followUp" }),
			},
			extensions: agentExtensions(),
			cwd,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
			...(base ? { base } : {}),
			// The hook that was declared and never supplied. Without it the seat
			// told itself there was nobody to ask, which was false — it has a
			// human, and a worker's escalated question had nowhere to go.
			...(options.asker
				? { askHuman: askThroughCapability(options.asker) }
				: {}),
			...(options.inbox ? { inbox: options.inbox } : {}),
		});
		for (const tool of built.tools.definitionsFor("maestro"))
			pi.registerTool(tool);
		return built;
	};

	const runWorkflowPlan = async (
		slug: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		if (!options.loadWorkflowPlanRunner)
			throw new Error(
				"workflow cutover is enabled but no production workflow plan runner is installed",
			);
		if (!options.asker)
			throw new Error(
				"workflow execution needs the ask-user-question package for plan approval",
			);
		const authoredPlan = seat().store.loadPlan(slug);
		if (!authoredPlan) throw new Error(`no stored plan named \`${slug}\``);
		// Authored paths are relative to the seat, not to the per-run worktree
		// umbrella. Bind one normalized clone and use it for both authorization
		// and compilation so those two identities cannot drift.
		const plan = {
			...authoredPlan,
			repos: authoredPlan.repos.map((repository) => ({
				...repository,
				path: resolve(cwd, repository.path),
			})),
		};
		const current = ctx.model;
		if (!current?.provider || !current.id)
			throw new Error(
				"workflow execution needs a concrete current seat model (provider/model)",
			);
		const implementationModel = `${current.provider}/${current.id}`;
		const authoredDigest = workflowCommandAuthoredDigest({
			plan,
			implementationModel,
			decisionModel: implementationModel,
		});
		const agentDir = options.agentDir ?? getAgentDir();
		const root = maestroRoot(agentDir);
		const maestroStateRoot = join(root, "workflow-state");
		const commandRun = loadOrCreateWorkflowCommandRun({
			maestroStateRoot,
			coordinatedRunsRoot: join(root, "workflow-runs"),
			planSlug: plan.slug,
			authoredDigest,
		});
		let result: WorkflowPlanRunnerResult;
		try {
			const loaded =
				workflowRunners.get(commandRun.runId) ??
				options.loadWorkflowPlanRunner({
					coordinatedRunRoot: commandRun.coordinatedRunRoot,
					maestroStateRoot,
					coordinatedRepositoryRoots: plan.repos.map(({ path }) => path),
					plan,
				});
			workflowRunners.set(commandRun.runId, loaded);
			result = await (await loaded).run({
				runId: commandRun.runId,
				coordinatedRunRoot: commandRun.coordinatedRunRoot,
				plan,
				implementationModel,
				decisionModel: implementationModel,
				asker: options.asker,
				onApproved: () => {
					if (seat().runtime.mode().name !== "auto") seat().setMode("auto");
				},
			});
		} catch (error) {
			releaseUnapprovedWorkflowCommandRun({
				maestroStateRoot,
				coordinatedRunsRoot: join(root, "workflow-runs"),
				planSlug: plan.slug,
				runId: commandRun.runId,
			});
			workflowRunners.delete(commandRun.runId);
			throw error;
		}
		if (result.status === "refused") {
			releaseWorkflowCommandRun({
				maestroStateRoot,
				planSlug: plan.slug,
				runId: commandRun.runId,
			});
			workflowRunners.delete(commandRun.runId);
			ctx.ui.notify(
				`Plan \`${plan.slug}\` was not approved; mode remains ${seat().runtime.mode().name}.`,
				"warning",
			);
			return;
		}
		releaseWorkflowCommandRun({
			maestroStateRoot,
			planSlug: plan.slug,
			runId: commandRun.runId,
		});
		workflowRunners.delete(commandRun.runId);
		ctx.ui.notify(
			`Workflow \`${plan.slug}\` completed as ${result.launchResult.runId}.`,
			"info",
		);
	};

	// Hygiene, not the mechanism: the seat's held readers are child processes
	// of this one and die with it. Only a BUILT seat can hold any — building
	// one here just to stop nothing would defeat the lazy construction above.
	pi.on?.("session_shutdown", () => {
		void built?.subagents.stopAll();
	});

	pi.registerCommand("mode", {
		description: `Switch posture. /mode [${MODE_NAMES.join("|")}]`,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const wanted = args.trim().toLowerCase();
			if (!wanted) {
				ctx.ui.notify(`Mode is ${seat().runtime.mode().name}.`, "info");
				return;
			}
			if (!MODE_NAMES.includes(wanted as ModeName)) {
				ctx.ui.notify(
					`Unknown mode \`${wanted}\` — one of ${MODE_NAMES.join(", ")}.`,
					"warning",
				);
				return;
			}
			if (
				options.workflowCutover &&
				wanted === "auto" &&
				seat().runtime.mode().name === "plan"
			) {
				const selected = seat().store.list()[0];
				if (!selected) {
					ctx.ui.notify(
						"No stored plan is available to approve and run; mode remains plan.",
						"warning",
					);
					return;
				}
				try {
					await runWorkflowPlan(selected.slug, ctx);
				} catch (error) {
					ctx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"warning",
					);
				}
				return;
			}
			const mode = seat().setMode(wanted as ModeName);
			ctx.ui.notify(
				`Mode ${mode.name}: ${mode.cwd === "write" ? "can write" : "read-only"}, safeguards ${mode.safeguards}.`,
				"info",
			);
		},
	});

	pi.registerCommand("run", {
		description: "Run a stored plan. /run <slug>, or /run to list them.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const slug = args.trim();
			try {
				if (!slug) {
					const plans = seat().store.list();
					ctx.ui.notify(
						plans.length === 0
							? "No plans stored yet."
							: plans
									.map((p) => `${p.slug} — ${p.title} (${p.deliverables})`)
									.join("\n"),
						"info",
					);
					return;
				}
				if (options.workflowCutover) {
					if (seat().runtime.mode().name !== "auto")
						throw new Error(
							"workflow plans run only in auto mode; use `/mode auto` to preview and approve the most recent plan",
						);
					await runWorkflowPlan(slug, ctx);
				} else await seat().run(slug, ctx as unknown as ExtensionContext);
			} catch (error) {
				// Refusals here are ordinary and legible — no such plan, plan mode
				// cannot run one, a plan already running. They belong in front of
				// the human, not in a stack trace.
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"warning",
				);
			}
		},
	});

	pi.registerCommand("stop", {
		description: "Halt the running plan. /stop [why]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (options.workflowCutover) {
				ctx.ui.notify(
					"Workflow runs are autonomous and recover by rerunning `/run <slug>`; `/stop` is unavailable during the workflow cutover.",
					"warning",
				);
				return;
			}
			const reason = args.trim() || "stopped from the seat";
			try {
				const run = await seat().runtime.stop(reason);
				ctx.ui.notify(
					run
						? `Stopped \`${run.slug}\`. Run it again to pick up where it left off.`
						: "No plan is running.",
					run ? "info" : "warning",
				);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"warning",
				);
			}
		},
	});

	return {
		seat,
		currentMode: () => built?.runtime.mode().name ?? "plan",
		workflowCoordinator: () => {
			if (!options.workflowCutover) return Promise.resolve(undefined);
			if (!options.loadWorkflowCoordinator)
				return Promise.reject(
					new Error(
						"workflow cutover is enabled but no seat coordinator composition is installed",
					),
				);
			workflowCoordinator ??= options.loadWorkflowCoordinator();
			return workflowCoordinator;
		},
	};
}

export default defineExtension(
	{
		name: "maestro",
		path: "packages/maestro/src/extension.ts",
		doc: "Plans as a DAG of deliverables, workers that build them, and the maestro that owns both ends.",
	},
	async (pi, maestro) => {
		// DEPTH decides, not the presence of wiring. A read-only agent is spawned
		// with a depth and deliberately WITHOUT a socket or token — it has nobody
		// to dial — so "no wiring" and "this is the seat" are not the same thing.
		// Reading them as the same gave every reviewer the maestro's own surface,
		// commands and all.
		if (currentDepth() > 0) {
			const wiring = readWiring();
			// A worker dials home. A read-only agent answers its caller — nothing
			// to dial — and registers exactly two tools of ours: the gated shell
			// and `subagent`. Its launched `--tools` allowlist is what lets it
			// call them.
			if (wiring)
				void startWorker(
					pi,
					wiring,
					{ extensions: agentExtensions() },
					maestro.capabilities,
				);
			else startReadOnlyAgent(pi, { extensions: agentExtensions() });
			return;
		}
		const asker = maestro.capabilities.get(CAPABILITIES.ask) as
			| HumanAsker
			| undefined;
		const workflowCutover = maestro.flags.enabled(WORKFLOW_CUTOVER_FLAG, true);
		const agentDir = getAgentDir();
		const seatEntry = startSeat(pi, {
			agentDir,
			...(asker ? { asker } : {}),
			// Workflow-native execution is the default. The flag remains a temporary
			// rollback switch while the legacy executor is still checked in.
			workflowCutover,
			...(workflowCutover
				? {
						loadWorkflowCoordinator: async () => {
							const usage = maestro.capabilities.get(CAPABILITIES.usage);
							return (
								await import("./workflow/coordinator.js")
							).createWorkflowCoordinator({
								...(usage ? { usage } : {}),
							});
						},
						loadWorkflowPlanRunner: async (input) => {
							if (input.plan.preflight.length > 0)
								throw new Error(
									"workflow cutover does not yet support autonomous preflight seat tasks",
								);
							if (input.plan.postflight.length > 0)
								throw new Error(
									"workflow cutover does not yet support autonomous postflight seat tasks",
								);
							for (const repository of input.plan.repos)
								planOnlyPullRequestCopy(input.plan, repository.key);
							const [production, runtime] = await Promise.all([
								import("./workflow/production-plan-runner.js"),
								import("./workflow/host-runtime-resolver.js"),
							]);
							const usage = maestro.capabilities.get(CAPABILITIES.usage);
							return production.createProductionWorkflowPlanRunner({
								...input,
								runtimeResolver: new runtime.HostWorkflowPhaseRuntimeResolver({
									cwd: process.cwd(),
									agentDir,
								}),
								pullRequestCopyProducer: {
									produce: ({ plan, repository }) =>
										planOnlyPullRequestCopy(plan, repository.key),
								},
								...(usage ? { usage } : {}),
							}).runner;
						},
					}
				: {}),
			// Read at question time, not now: `packages/ask` may register after
			// us, and a seat that resolved this at boot would silently have no
			// inbox depending on extension load order.
			inbox: () => maestro.capabilities.get(CAPABILITIES.askInbox),
		});
		const { installMaestroObservability } = await import("./observability.js");
		installMaestroObservability(pi, maestro, seatEntry.currentMode);
	},
);
