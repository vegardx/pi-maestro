// Execution seam. Runtime code depends on ExecutionHandle only — never on
// the concrete adapter — so the execution internals (provisioner, supervisor,
// rpc-router) can be completed behind this interface.

import type { Answers } from "@vegardx/pi-contracts";
import type { GroupExecutor } from "../group-executor.js";
import type { PendingQuestion } from "../question-queue.js";
import {
	ExecutionAdapter,
	type ExecutionAdapterOpts,
} from "./execution-adapter.js";

export {
	ExecutionAdapter,
	type ExecutionAdapterOpts,
} from "./execution-adapter.js";
export {
	type ParsedVerdict,
	parseVerdict,
	VERDICT_INSTRUCTION,
	type Verdict,
} from "./verdicts.js";

export interface ExecutionAgentTokens {
	readonly input: number;
	readonly output: number;
	readonly turns: number;
}

export interface ExecutionAgentSnapshot {
	readonly status: string;
	readonly startedAt: number;
	readonly tokens: ExecutionAgentTokens;
	/** First-turn cacheRead/(cacheRead+input) — cache-prefix hit efficiency. */
	readonly cacheRatio?: number;
}

export interface ExecutionGroupSnapshot {
	/** Review→fix round counter. 0 = initial implementation. */
	readonly round: number;
	/** Set when the fix loop stopped without converging. */
	readonly blocked?: string;
}

/**
 * What the runtime needs from execution. Derived from how runtime code uses
 * the adapter today; later phases extend the implementation, not the callers.
 */
export interface ExecutionHandle {
	/** Pending agent questions awaiting a user /answer. */
	readonly questionQueue: {
		all(): readonly PendingQuestion[];
		/** Resolve an agent's entry and dequeue it (never resolve() directly). */
		answer(agentId: string, answers: Answers): void;
	};
	/** Start the RPC server and prepare the plan dir. */
	start(): Promise<void>;
	/** Advance the executor; returns the number of newly activated groups. */
	tick(): Promise<number>;
	/** Send guidance to a group agent (default: the worker). False if absent. */
	steer(groupId: string, guidance: string, agentName?: string): boolean;
	/** Current per-agent status/tokens and per-group round/blocked view. */
	snapshot(): {
		agents: Map<string, ExecutionAgentSnapshot>;
		groups: Map<string, ExecutionGroupSnapshot>;
	};
	/** Resolve an agent key, group id, agent or session name to a tmux session. */
	resolveSessionName(target: string): string | undefined;
	/** The underlying executor (for recap/state rendering). */
	getExecutor(): GroupExecutor;
	/** Mark an agent finished and re-evaluate the group. */
	markAgentDone(groupId: string, name: string): Promise<void>;
	/** Whether a group's worker has completed all gating tasks. */
	isWorkerDone(groupId: string): boolean;
	/** Tmux session names for worker agents (for /watch panes). */
	getWorkerSessions(): string[];
	/** Tear down agents, tmux sessions, and the RPC server. */
	destroy(): Promise<void>;
}

export type CreateExecutionOptions = ExecutionAdapterOpts;

/** Composition root: build the execution seam for a plan run. */
export function createExecution(opts: CreateExecutionOptions): ExecutionHandle {
	return new ExecutionAdapter(opts);
}
