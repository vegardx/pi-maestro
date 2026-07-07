// Execution seam. Runtime code depends on ExecutionHandle only — never on
// the concrete adapter — so the execution internals (provisioner, supervisor,
// rpc-router) can be completed behind this interface.

import type { PendingQuestion } from "../question-queue.js";
import {
	ExecutionAdapter,
	type ExecutionAdapterOpts,
} from "./execution-adapter.js";

export {
	ExecutionAdapter,
	type ExecutionAdapterOpts,
} from "./execution-adapter.js";

export interface ExecutionAgentTokens {
	readonly input: number;
	readonly output: number;
	readonly turns: number;
}

export interface ExecutionAgentSnapshot {
	readonly status: string;
	readonly startedAt: number;
	readonly tokens: ExecutionAgentTokens;
}

/**
 * What the runtime needs from execution. Derived from how runtime code uses
 * the adapter today; later phases extend the implementation, not the callers.
 */
export interface ExecutionHandle {
	/** Pending agent questions awaiting a user /answer. */
	readonly questionQueue: { all(): readonly PendingQuestion[] };
	/** Start the RPC server and prepare the plan dir. */
	start(): Promise<void>;
	/** Advance the executor; returns the number of newly activated groups. */
	tick(): Promise<number>;
	/** Send guidance to a group's worker agent. */
	steer(groupId: string, guidance: string): void;
	/** Current per-agent status/tokens view. */
	snapshot(): { agents: Map<string, ExecutionAgentSnapshot> };
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
