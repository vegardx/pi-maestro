// @vegardx/pi-subagents — the single run transport and service that powers
// both delegate-style focused agents and modes' deliverable agents.
//
// The full stack:
//   * persistence substrate — RunStore, RunBus, persistRunBus, retention;
//   * profiles + invocation mapping — the structured spawn API, mapped to a
//     child invocation (pi-native config → args, enablement/kills → env,
//     computed explicitly per spawn);
//   * SubagentService — the subagents.v1 capability (spawn/get/list/steer/stop)
//     over an injected AgentRunner;
//   * runners + concurrency — an RpcClient-backed AgentRunner that maps a
//     child's event stream onto the run-bus, gated by a shared FIFO semaphore;
//   * supervisor protocol — contact_supervisor (child) emits needDecision; the
//     parent projects it to the human/ship gate and steers the answer back;
//   * delegate surface — the `subagent` tool (spawn/status/steer/stop) plus
//     agent definitions discovered from .pi/agents over the built-ins;
//   * the run-bus is bridged onto the typed maestro event bus so modes and the
//     UI observe status/progress/needDecision without importing this package.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import {
	CAPABILITIES,
	EVENTS,
	type ModelRole,
	type RunId,
	type SupervisorDecision,
	type SupervisorDecisionRequest,
} from "@vegardx/pi-contracts";
import { defineExtension, type MaestroContext } from "@vegardx/pi-core";
import { resolveExactModelSelection } from "@vegardx/pi-models";
import {
	getConfigStringArray,
	readLayeredExtensionConfig,
} from "@vegardx/pi-settings";
import { createAgentsCapability, createAgentTool } from "./agent-tool.js";
import { createRunBus } from "./bus.js";
import { resolveDelegateSelection } from "./catalog.js";
import { currentDepth } from "./invocation.js";
import { runsRoot } from "./paths.js";
import { persistRunBus } from "./persist.js";
import {
	killAndVerifyTmuxSession,
	reconcileOrphanedRuns,
} from "./reconcile.js";
import { createBuiltinAgentRegistries } from "./registry.js";
import { DEFAULT_RETENTION, pruneRuns } from "./retention.js";
import { createAgentRunner } from "./runners.js";
import { createSemaphore } from "./semaphore.js";
import { type AgentRunner, SubagentService } from "./service.js";
import { createRunStore } from "./store.js";
import {
	attachSupervisor,
	createSupervisorTool,
	RUN_ID_ENV,
} from "./supervisor.js";
import { createTmuxAgentRunner } from "./tmux-runner.js";

export {
	createAgentsCapability,
	createAgentTool,
	type ExactAgentSelection,
	type UnifiedAgentDeps,
} from "./agent-tool.js";

export {
	type AgentDefinition,
	BUILTIN_AGENTS,
	discoverAgents,
	parseAgentDefinition,
	parseFrontmatter,
} from "./agents.js";
export {
	createRunBus,
	msgRunId,
	type RunBus,
	type RunBusHandler,
} from "./bus.js";
export {
	type ChildInvocation,
	currentDepth,
	DEPTH_ENV,
	mapProfileToInvocation,
	type SpawnContext,
} from "./invocation.js";
export { runsRoot } from "./paths.js";
export { persistRunBus } from "./persist.js";
export {
	BUILTIN_PROFILES,
	type ProfileDefaults,
	type ResolvedProfile,
	resolveProfile,
} from "./profiles.js";
export {
	killAndVerifyTmuxSession,
	type ReconcileOptions,
	type ReconcileResult,
	reconcileOrphanedRuns,
} from "./reconcile.js";
export {
	type AgentRegistries,
	AgentRegistry,
	type AgentRuntimeRegistries,
	BUILTIN_AGENT_KINDS,
	createBuiltinAgentRegistries,
	DuplicateRegistryEntryError,
	resolveRuntimePolicy,
	validateKindRegistry,
} from "./registry.js";
export {
	DEFAULT_RETENTION,
	type PruneResult,
	pruneRuns,
	type RetentionPolicy,
} from "./retention.js";
export {
	type ClientFactory,
	createAgentRunner,
	type RpcLike,
	type RunnerOptions,
} from "./runners.js";
export { createSemaphore, type Semaphore } from "./semaphore.js";
export {
	type AgentRunner,
	type LaunchRequest,
	type RunnerController,
	SubagentService,
	type SubagentServiceOptions,
} from "./service.js";
export {
	assertTransition,
	canTransition,
	isActive,
	isTerminal,
} from "./state-machine.js";
export {
	createRunStore,
	type RunStore,
	UnsupportedRunStateError,
} from "./store.js";
export {
	attachSupervisor,
	createSupervisorTool,
	needDecisionMessage,
	RUN_ID_ENV,
	type SupervisorProjectorDeps,
	type SupervisorToolOptions,
} from "./supervisor.js";
export {
	createTmuxAgentRunner,
	type TmuxRunnerOptions,
} from "./tmux-runner.js";
export { createSubagentTool, type SubagentToolDeps } from "./tool.js";

// Relay a supervisor request to the human: ask.v1 when present, else the bare
// UI confirm/select. Returns the chosen answer string.
function makeDecider(
	maestro: MaestroContext,
	getCtx: () => ExtensionContext | undefined,
) {
	return async (
		_runId: RunId,
		request: SupervisorDecisionRequest,
	): Promise<SupervisorDecision> => {
		const ask = maestro.capabilities.get(CAPABILITIES.ask);
		if (ask) {
			const answers = await ask.ask([
				{
					id: "supervisor",
					question: request.question,
					context: request.context,
					options: request.options?.map((o) => ({ label: o })),
					allowFreeText: true,
				},
			]);
			return { answer: answers[0]?.value ?? "" };
		}
		const ctx = getCtx();
		if (ctx?.hasUI && request.options?.length) {
			const choice = await ctx.ui.select(request.question, [
				...request.options,
			]);
			return { answer: choice ?? "" };
		}
		if (ctx?.hasUI) {
			const typed = await ctx.ui.input(request.question);
			return { answer: typed ?? "" };
		}
		return { answer: "" };
	};
}

// CLI entry point for spawned children, mirroring pi's subagent example: the
// path pi itself was launched from. undefined in a bundled binary — the runner
// then relies on RpcClient's own default discovery.
/**
 * The process-wide spawn transport default. pi-maestro REQUIRES tmux (workers
 * have always lived in tmux sessions), so inspectable tmux runs are the
 * default with no silent degradation — a missing tmux is surfaced loudly at
 * startup, not papered over with headless spawns. PI_MAESTRO_TRANSPORT is the
 * explicit escape hatch (debugging, harness runs).
 */
function resolveDefaultTransport(): "tmux" | "headless" {
	const forced = process.env.PI_MAESTRO_TRANSPORT;
	if (forced === "headless" || forced === "tmux") return forced;
	return "tmux";
}

function resolveCliPath(): string | undefined {
	const entry = process.argv[1];
	if (!entry || entry.startsWith("/$bunfs/")) return undefined;
	return entry;
}

// Bounded, but set high on purpose — the goal is to explore how wide we can
// fan out (persona panels, research rounds). Ceiling raiseable with hardware.
const DEFAULT_CONCURRENCY = 50;

/**
 * The childExtensions passthrough set (extensionConfig.modes.childExtensions,
 * toggled in /maestro). Vanished paths are dropped — a missing -e path would
 * kill every child at startup.
 */
function readChildExtensionPaths(cwd: string): string[] {
	try {
		const { merged } = readLayeredExtensionConfig(cwd);
		return getConfigStringArray(merged, "modes", "childExtensions", []).filter(
			(p) => existsSync(p),
		);
	} catch {
		return [];
	}
}

export default defineExtension(
	{
		name: "subagents",
		path: "packages/subagents/src/index.ts",
		doc: "Run transport, run store, retention, profiles, runners, supervisor.",
	},
	(pi, maestro) => {
		// One bus + one concurrency semaphore per process; the store is rebound
		// to the active repo on each session_start. The capability delegates to
		// the current service.
		const bus = createRunBus();
		const semaphore = createSemaphore(DEFAULT_CONCURRENCY);
		const runner: AgentRunner = createAgentRunner({
			factory: (options) => new RpcClient(options),
			semaphore,
			cliPath: resolveCliPath(),
		});
		let service: SubagentService | undefined;
		let ctx: ExtensionContext | undefined;

		const rebuild = (next: ExtensionContext) => {
			ctx = next;
			const store = createRunStore(runsRoot(next.cwd));
			persistRunBus(bus, store);
			const tmuxRunner = createTmuxAgentRunner({
				semaphore,
				cliPath: resolveCliPath(),
				runsRoot: store.root,
			});
			const transportRunner: AgentRunner = {
				launch: (request, targetBus) =>
					request.profile.transport === "headless"
						? runner.launch(request, targetBus)
						: tmuxRunner.launch(request, targetBus),
			};
			service = new SubagentService({
				bus,
				store,
				runner: transportRunner,
				repoRoot: next.cwd,
				spawnerCwd: next.cwd,
				ownDepth: currentDepth(),
				// Children run -ne; pass configured infra extensions (custom model
				// providers etc) back through for EVERY caller at this one seam.
				extraExtensions: () => readChildExtensionPaths(next.cwd),
				// Inspectable tmux runs are the default from day one — workers
				// already live in tmux and pi-maestro requires it. Headless is
				// the explicit PI_MAESTRO_TRANSPORT=headless escape hatch only.
				defaultTransport: resolveDefaultTransport(),
			});
			// Reap cross-process orphans BEFORE retention: retention never prunes
			// active records, so a run whose supervising process died would
			// otherwise sit non-terminal (with a live tmux session) forever.
			try {
				reconcileOrphanedRuns(store, {
					killTmuxSession: killAndVerifyTmuxSession,
				});
			} catch {
				// Best-effort, like retention; never block startup on it.
			}
			if (maestro.flags.enabled("retention")) {
				try {
					pruneRuns(store, DEFAULT_RETENTION, Date.now(), {
						killTmuxSession: killAndVerifyTmuxSession,
					});
				} catch {
					// Retention is best-effort; never block startup on it.
				}
			}
		};

		pi.on("session_start", (_e, next: ExtensionContext) => rebuild(next));

		const requireService = (): SubagentService => {
			if (!service) throw new Error("subagents: no active session");
			return service;
		};

		const registries = createBuiltinAgentRegistries();

		maestro.capabilities.register(CAPABILITIES.subagents, {
			spawn: (prompt, profile) => requireService().spawn(prompt, profile),
			get: (runId) => requireService().get(runId),
			list: () => requireService().list(),
			steer: (runId, guidance) => requireService().steer(runId, guidance),
			interrupt: (runId, reason) => requireService().interrupt(runId, reason),
			stop: (runId, reason) => requireService().stop(runId, reason),
			capture: (runId, lines) => requireService().capture(runId, lines),
		});

		// Bridge the in-process run-bus onto the typed maestro event bus so modes
		// and the UI observe runs without importing this package.
		bus.subscribe((message) => {
			if (message.type === "status") {
				maestro.events.emit(EVENTS.runStatus, {
					runId: message.runId,
					status: message.status,
				});
			} else if (message.type === "progress") {
				maestro.events.emit(EVENTS.runProgress, {
					runId: message.runId,
					progress: message.delta,
				});
			} else if (message.type === "needDecision") {
				maestro.events.emit(EVENTS.supervisorNeedDecision, {
					runId: message.runId,
					request: message.request,
				});
			} else if (message.type === "agentEvent") {
				maestro.events.emit(EVENTS.runAgentEvent, {
					runId: message.runId,
					event: message.event,
				});
			}
		});

		// Parent-side supervisor projector: relay needDecision to the human and
		// steer the answer back to the child.
		attachSupervisor({
			bus,
			decide: makeDecider(maestro, () => ctx),
			steer: (runId, guidance) => requireService().steer(runId, guidance),
		});

		const agentsCapability = createAgentsCapability({
			subagents: () => maestro.capabilities.get(CAPABILITIES.subagents),
			registries,
			resolveModel: async (kind, choice) => {
				if (!ctx) throw new Error("Agent model policy is unavailable.");
				const role: ModelRole = kind.modelRole;
				const initial = await resolveExactModelSelection(ctx, {
					role,
				});
				if (!initial.selected) {
					const fallbackRole: ModelRole =
						role === "worker" || role === "verifier"
							? role
							: role === "codebase-research" || role === "web-research"
								? "research"
								: role === "consult" || role === "plan-review"
									? "advisor"
									: role.endsWith("-review")
										? "reviewer"
										: "delegate";
					const fallback = await resolveExactModelSelection(ctx, {
						role: fallbackRole,
					});
					if (fallback.selected) return fallback.selected;
					// Unconfigured installations still route through the established
					// authenticated role pools. This fallback is exact and never silently
					// substitutes an explicit request.
					const legacy = await resolveDelegateSelection(ctx, choice);
					return {
						presetId: "legacy-role-pool",
						modelSetId: role,
						optionId: `${legacy.model}@${legacy.effort ?? "medium"}`,
						modelId: legacy.model,
						effort: legacy.effort ?? "medium",
						source: choice.model || choice.effort ? "explicit" : "preset",
					};
				}
				if (!choice.model && !choice.effort) return initial.selected;
				const candidate = initial.candidates.find(
					(fact) =>
						fact.available &&
						(!choice.model || fact.modelId === choice.model) &&
						(!choice.effort || fact.effort === choice.effort),
				);
				if (!candidate?.modelId)
					throw new Error(
						`No exact ${kind.modelRole} option matches ${choice.model ?? "default model"} @ ${choice.effort ?? "default effort"}`,
					);
				const exact = await resolveExactModelSelection(ctx, {
					role: kind.modelRole,
					assignment: {
						presetId: initial.presetId ?? "session",
						modelSetId: initial.modelSetId ?? "session",
						optionId: candidate.optionId,
						modelId: candidate.modelId,
						effort: candidate.effort,
					},
				});
				if (!exact.selected)
					throw new Error(
						exact.errors.map((error) => error.message).join("; "),
					);
				return { ...exact.selected, source: "explicit" as const };
			},
			researchToolsPath: () =>
				resolve(
					dirname(fileURLToPath(import.meta.url)),
					"../../research-tools/src/index.ts",
				),
		});
		maestro.capabilities.register(CAPABILITIES.agents, agentsCapability);

		// One model-facing spawn/control surface for every semantic agent kind.
		pi.registerTool(
			createAgentTool(() => maestro.capabilities.get(CAPABILITIES.agents)),
		);

		// The child-side supervisor tool. Harmless in a top-level session (it
		// no-ops when PI_MAESTRO_RUN_ID is unset).
		pi.registerTool(
			createSupervisorTool({
				runId: () =>
					(process.env[RUN_ID_ENV] as RunId | undefined) || undefined,
				publish: (msg) => bus.publish(msg),
			}),
		);
	},
);
