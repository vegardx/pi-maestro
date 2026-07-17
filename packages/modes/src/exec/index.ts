// Execution seam. Runtime code depends on ExecutionHandle only — never on
// the concrete adapter — so the execution internals (provisioner, supervisor,
// rpc-router) can be completed behind this interface.

import type {
	Answers,
	InterruptResult,
	RunId,
	RunRecord,
	UsageCheckpoint,
} from "@vegardx/pi-contracts";
import type { DeliverableExecutor } from "../deliverable-executor.js";
import type { PendingQuestion } from "../question-queue.js";
import {
	ExecutionAdapter,
	type ExecutionAdapterOpts,
} from "./execution-adapter.js";

export {
	ExecutionAdapter,
	type ExecutionAdapterOpts,
	type ExecutionEvent,
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
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly promptTokens?: number;
	readonly totalTokens?: number;
	readonly cost?: number;
}

export interface ExecutionAgentSnapshot {
	readonly status: string;
	readonly startedAt: number;
	readonly tokens: ExecutionAgentTokens;
	/** First-turn prefix warmth; distinct from cumulative cache hit rate. */
	readonly prefixCacheHitRate?: number;
	/** Short model name for telemetry (e.g. "fable-5"). */
	readonly model?: string;
	/** Thinking effort level. */
	readonly effort?: string;
	/** True when the model uses adaptive thinking → renders "A/<level>". */
	readonly adaptive?: boolean;
}

export interface ExecutionDeliverableSnapshot {
	/** Set when the deliverable can't proceed (e.g. a blocked ship gate). */
	readonly blocked?: string;
}

/**
 * What the runtime needs from execution. Derived from how runtime code uses
 * the adapter today; later phases extend the implementation, not the callers.
 */
export interface ExecutionHandle {
	/** Install the maestro-owned worker debug proposal receiver. */
	setDebugProposalHandler?(
		handler: (
			agentId: string,
			proposal: import("@vegardx/pi-rpc").DebugProposalMessage,
		) => Promise<import("@vegardx/pi-rpc").DebugResultMessage>,
	): void;
	/** Pending agent questions awaiting a user /answer. */
	readonly questionQueue: {
		all(): readonly PendingQuestion[];
		/** Preserve partial questionnaire progress without resolving the agent. */
		saveDraft(agentId: string, draft: Answers): void;
		/** Resolve an agent's entry and dequeue it (never resolve() directly). */
		answer(agentId: string, answers: Answers): void;
	};
	/** Start the RPC server and prepare the plan dir. */
	start(): Promise<void>;
	/** Advance the executor; returns the number of newly activated deliverables. */
	tick(deliverableIds?: readonly string[]): Promise<number>;
	/** Send guidance to a deliverable agent (default: the worker). False if absent. */
	steer(deliverableId: string, guidance: string, agentName?: string): boolean;
	/** Abort only the current turn; the worker process/session/worktree survive. */
	interrupt?(
		deliverableId: string,
		agentName?: string,
	): Promise<InterruptResult>;
	/** Capture a worker tmux pane when available. */
	capture?(
		deliverableId: string,
		agentName?: string,
		lines?: number,
	): Promise<string | undefined>;
	/** Stop a worker process/session. */
	stop?(
		deliverableId: string,
		agentName?: string,
		reason?: string,
	): Promise<boolean>;
	/** Required reviewers currently holding a deliverable's ship gate. */
	failingRequiredReviewers(deliverableId: string): string[];
	/**
	 * Latest panel round's verdicts with their (clipped) findings reports —
	 * what the human reads before deciding an override/send-back.
	 */
	reviewerFindings(deliverableId: string): ReadonlyArray<{
		readonly name: string;
		readonly verdict: string;
		readonly required: boolean;
		readonly report?: string;
	}>;
	/**
	 * Record a HUMAN override as a reviewer's latest verdict (gate-decision
	 * answer flow only — deliberately not reachable from any model tool).
	 */
	overrideReviewerVerdict(
		deliverableId: string,
		reviewer: string,
		reason: string,
	): void;
	/**
	 * Reopen a gate-blocked deliverable and respawn its worker with the
	 * review findings (the gate-decision "send back" route). Resumes the
	 * worker's own session when possible. False when nothing to send back to.
	 */
	sendBackToWorker(deliverableId: string, kickoff: string): Promise<boolean>;
	/** Preview read-only validation for explicit worker replacement. */
	previewWorkerRestart?(
		deliverableId: string,
		mode: "resume" | "fresh",
	): import("./execution-adapter.js").WorkerRestartPreview;
	/** Replace the worker process while retaining its current JSONL. */
	restartWorkerResume?(
		deliverableId: string,
	): Promise<import("./execution-adapter.js").WorkerRestartResult>;
	/** Replace worker process and JSONL while preserving the validated workspace. */
	restartWorkerFresh?(
		deliverableId: string,
	): Promise<import("./execution-adapter.js").WorkerRestartResult>;
	/**
	 * Kill a worker and park its deliverable in the /recover-able restart
	 * shape, suppressing the crash-respawn loop. False when nothing to fail.
	 */
	forceFailWorker?(deliverableId: string, reason: string): Promise<boolean>;
	/** Current per-agent status/tokens and per-deliverable round/blocked view. */
	snapshot(): {
		agents: Map<string, ExecutionAgentSnapshot>;
		deliverables: Map<string, ExecutionDeliverableSnapshot>;
	};
	/** Worker-owned child runs projected durably into the host. */
	projectedRuns?(): readonly RunRecord[];
	steerProjectedRun?(runId: RunId, guidance: string): boolean;
	interruptProjectedRun?(
		runId: RunId,
		reason?: string,
	): Promise<InterruptResult>;
	captureProjectedRun?(
		runId: RunId,
		lines?: number,
	): Promise<string | undefined>;
	stopProjectedRun?(runId: RunId, reason?: string): boolean;
	/** Resolve an agent key, deliverable id, agent or session name to a tmux session. */
	resolveSessionName(target: string): string | undefined;
	/** The underlying executor (for recap/state rendering). */
	getExecutor(): DeliverableExecutor;
	/** Mark an agent finished and re-evaluate the deliverable. */
	markAgentDone(deliverableId: string, name: string): Promise<void>;
	/** Whether a deliverable's worker has completed all gating tasks. */
	isWorkerDone(deliverableId: string): boolean;
	/** Tmux session names for worker agents (for /watch panes). */
	getWorkerSessions(): string[];
	/** Freeze scheduling and cooperatively stop the fleet behind one deadline. */
	prepareStop?(
		reason?: string,
	): Promise<import("./execution-adapter.js").ExecutionStopResult>;
	/** Tear down agents, tmux sessions, and the RPC server. */
	destroy(): Promise<void>;
}

export type CreateExecutionOptions = ExecutionAdapterOpts;

export interface AgentUsageCheckpoint {
	readonly agentId: string;
	readonly generation: number;
	readonly checkpoint: UsageCheckpoint;
}

/** Composition root: build the execution seam for a plan run. */
export function createExecution(opts: CreateExecutionOptions): ExecutionHandle {
	return new ExecutionAdapter(opts);
}
