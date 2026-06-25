// @vegardx/pi-subagents — the single run transport and service that powers
// both delegate-style focused agents and modes' deliverable workers.
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

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import {
	CAPABILITIES,
	EVENTS,
	type RunId,
	type SupervisorDecision,
	type SupervisorDecisionRequest,
} from "@vegardx/pi-contracts";
import { defineExtension, type MaestroContext } from "@vegardx/pi-core";
import { type AgentDefinition, discoverAgents } from "./agents.js";
import { createRunBus } from "./bus.js";
import { currentDepth } from "./invocation.js";
import { runsRoot } from "./paths.js";
import { persistRunBus } from "./persist.js";
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
import { createSubagentTool } from "./tool.js";

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
export { createRunStore, type RunStore } from "./store.js";
export {
	attachSupervisor,
	createSupervisorTool,
	needDecisionMessage,
	RUN_ID_ENV,
	type SupervisorProjectorDeps,
	type SupervisorToolOptions,
} from "./supervisor.js";
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
function resolveCliPath(): string | undefined {
	const entry = process.argv[1];
	if (!entry || entry.startsWith("/$bunfs/")) return undefined;
	return entry;
}

const DEFAULT_CONCURRENCY = 3;

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
		let agents: Record<string, AgentDefinition> = {};

		const rebuild = (next: ExtensionContext) => {
			ctx = next;
			agents = discoverAgents(`${next.cwd}/.pi/agents`);
			const store = createRunStore(runsRoot(next.cwd));
			persistRunBus(bus, store);
			service = new SubagentService({
				bus,
				store,
				runner,
				repoRoot: next.cwd,
				spawnerCwd: next.cwd,
				ownDepth: currentDepth(),
			});
			if (maestro.flags.enabled("retention")) {
				try {
					pruneRuns(store, DEFAULT_RETENTION);
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

		maestro.capabilities.register(CAPABILITIES.subagents, {
			spawn: (prompt, profile) => requireService().spawn(prompt, profile),
			get: (runId) => requireService().get(runId),
			list: () => requireService().list(),
			steer: (runId, guidance) => requireService().steer(runId, guidance),
			stop: (runId, reason) => requireService().stop(runId, reason),
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
			}
		});

		// Parent-side supervisor projector: relay needDecision to the human and
		// steer the answer back to the child.
		attachSupervisor({
			bus,
			decide: makeDecider(maestro, () => ctx),
			steer: (runId, guidance) => requireService().steer(runId, guidance),
		});

		// The main agent's delegate surface.
		pi.registerTool(
			createSubagentTool({
				capability: () => maestro.capabilities.get(CAPABILITIES.subagents),
				agents: () => agents,
			}),
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
