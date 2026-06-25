// @vegardx/pi-subagents — the single run transport and service that powers
// both delegate-style focused agents and modes' deliverable workers.
//
// Shipped so far:
//   * persistence substrate — RunStore, RunBus, persistRunBus, retention;
//   * profiles + invocation mapping — the structured spawn API, mapped to a
//     child invocation (pi-native config → args, enablement/kills → env,
//     computed explicitly per spawn);
//   * SubagentService — the subagents.v1 capability (spawn/get/list/steer/stop)
//     over an injected AgentRunner;
//   * runners + concurrency — an RpcClient-backed AgentRunner that maps a
//     child's event stream onto the run-bus, gated by a shared FIFO semaphore.
//
// The supervisor protocol, the delegate tool surface, and agent definitions
// land in the final child deliverable.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { createRunBus } from "./bus.js";
import { currentDepth } from "./invocation.js";
import { runsRoot } from "./paths.js";
import { persistRunBus } from "./persist.js";
import { DEFAULT_RETENTION, pruneRuns } from "./retention.js";
import { createAgentRunner } from "./runners.js";
import { createSemaphore } from "./semaphore.js";
import { type AgentRunner, SubagentService } from "./service.js";
import { createRunStore } from "./store.js";

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

		const rebuild = (ctx: ExtensionContext) => {
			const store = createRunStore(runsRoot(ctx.cwd));
			persistRunBus(bus, store);
			service = new SubagentService({
				bus,
				store,
				runner,
				repoRoot: ctx.cwd,
				spawnerCwd: ctx.cwd,
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

		pi.on("session_start", (_e, ctx: ExtensionContext) => rebuild(ctx));

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
	},
);
