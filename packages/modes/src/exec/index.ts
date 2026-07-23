// Execution seam (v2, post-flip). Runtime code depends on ExecutionHandle
// only — never on the concrete adapter — and the flip swapped the
// implementation to NodeExecutionAdapter over the recursive plan. Agent keys
// ARE node ids: the v1 `${deliverableId}/${agentName}` compound keys are
// gone; handle methods keep an ignored agentName parameter so v1 call sites
// port mechanically.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Answers, RunId, RunRecord } from "@vegardx/pi-contracts";
import type { DebugProposalMessage, DebugResultMessage } from "@vegardx/pi-rpc";
import type { PlanEngineV2 } from "../plan/engine.js";
import {
	type NodeAdapterOptions,
	NodeExecutionAdapter,
} from "../plan/node-adapter.js";
import type { NodeExecutor } from "../plan/node-executor.js";
import type { PendingQuestion } from "../question-queue.js";

// The v1 event vocabulary lives on the v2 adapter now (verbatim shape).
export type { ExecutionEvent } from "../plan/node-adapter.js";
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
	readonly completedAt?: number;
	readonly tokens: ExecutionAgentTokens;
	readonly prefixCacheHitRate?: number;
	readonly model?: string;
	readonly effort?: string;
	readonly adaptive?: boolean;
}

export interface ExecutionDeliverableSnapshot {
	readonly blocked?: string;
}

/** What the runtime needs from execution (v1 surface, node-keyed). */
export interface ExecutionHandle {
	setDebugProposalHandler?(
		handler: (
			agentId: string,
			proposal: DebugProposalMessage,
		) => Promise<DebugResultMessage>,
	): void;
	readonly questionQueue: {
		all(): readonly PendingQuestion[];
		saveDraft(agentId: string, draft: Answers): void;
		answer(agentId: string, answers: Answers): void;
	};
	start(): Promise<void>;
	tick(nodeIds?: readonly string[]): Promise<number>;
	steer(nodeId: string, guidance: string, agentName?: string): boolean;
	interrupt?(
		nodeId: string,
		agentName?: string,
	): Promise<{ ok: boolean; error?: string }>;
	capture?(
		nodeId: string,
		agentName?: string,
		lines?: number,
	): Promise<string | undefined>;
	stop?(nodeId: string, agentName?: string, reason?: string): Promise<boolean>;
	previewWorkerRestart?(
		nodeId: string,
		mode: "resume" | "fresh",
	): ReturnType<NodeExecutionAdapter["previewWorkerRestart"]>;
	restartWorkerResume?(
		nodeId: string,
	): ReturnType<NodeExecutionAdapter["restartWorker"]>;
	restartWorkerFresh?(
		nodeId: string,
	): ReturnType<NodeExecutionAdapter["restartWorker"]>;
	forceFailWorker?(nodeId: string, reason: string): Promise<boolean>;
	snapshot(): {
		agents: Map<string, ExecutionAgentSnapshot>;
		deliverables: Map<string, ExecutionDeliverableSnapshot>;
	};
	// Projected child runs are deferred post-flip (S5a): the optional
	// methods keep v1 call sites compiling; absent implementations fall
	// into their "disconnected" branches at runtime.
	projectedRuns?(): readonly RunRecord[];
	steerProjectedRun?(runId: RunId, guidance: string): boolean;
	interruptProjectedRun?(
		runId: RunId,
		reason?: string,
	): Promise<{ outcome: string } | undefined>;
	captureProjectedRun?(
		runId: RunId,
		lines?: number,
	): Promise<string | undefined>;
	stopProjectedRun?(runId: RunId, reason?: string): Promise<boolean>;
	resolveSessionName(target: string): string | undefined;
	resolveSessionFile(target: string): string | undefined;
	getExecutor(): NodeExecutor;
	markAgentDone(nodeId: string, name?: string): Promise<void>;
	isWorkerDone(nodeId: string): boolean;
	getWorkerSessions(): string[];
	prepareStop?(
		reason?: string,
	): Promise<{ stopped: string[]; unresponsive: string[] }>;
	destroy(): Promise<void>;
}

export interface CreateExecutionOptions
	extends Omit<NodeAdapterOptions, "launcher" | "token" | "socketPath"> {
	readonly launcher?: NodeAdapterOptions["launcher"];
	readonly token?: string;
	readonly socketPath?: string;
	readonly engine: PlanEngineV2;
}

/** Composition root: the v2 execution seam for a plan run. */
export function createExecution(opts: CreateExecutionOptions): ExecutionHandle {
	const adapter = new NodeExecutionAdapter({
		...opts,
		// The real pi-launch command is supplied by the adapter's spawnAgent
		// seam; this launcher only provides liveness/reap/capture. Real callers
		// pass a shared headless spawner so it and spawnAgent see the same
		// processes; the stub default keeps test/embedded callers compiling.
		launcher: opts.launcher ?? {
			spawn: async () => {},
			hasSession: async () => false,
			kill: async () => {},
		},
		token: opts.token ?? randomUUID(),
		socketPath:
			opts.socketPath ??
			join(
				"/tmp",
				`maestro-${opts.engine.get().slug.slice(0, 20)}-${process.pid}.sock`,
			),
	});
	const handle: ExecutionHandle = {
		questionQueue: adapter.questionQueue,
		start: () => adapter.start(),
		tick: async (nodeIds) => (await adapter.tick(nodeIds)).length,
		steer: (nodeId, guidance, agentName) =>
			adapter.steer(nodeId, guidance, agentName),
		interrupt: (nodeId, agentName) => adapter.interrupt(nodeId, agentName),
		capture: (nodeId, agentName, lines) =>
			adapter.capture(nodeId, agentName, lines),
		stop: (nodeId, agentName, reason) =>
			adapter.stop(nodeId, agentName, reason),
		previewWorkerRestart: (nodeId, mode) =>
			adapter.previewWorkerRestart(nodeId, mode),
		restartWorkerResume: (nodeId) => adapter.restartWorker(nodeId, "resume"),
		restartWorkerFresh: (nodeId) => adapter.restartWorker(nodeId, "fresh"),
		forceFailWorker: (nodeId, reason) =>
			adapter.forceFailWorker(nodeId, reason),
		snapshot: () => adapter.snapshot(),
		resolveSessionName: (target) => adapter.resolveSessionName(target),
		resolveSessionFile: (target) => adapter.resolveSessionFile(target),
		getExecutor: () => adapter.getExecutor(),
		markAgentDone: (nodeId, name) => adapter.markAgentDone(nodeId, name),
		isWorkerDone: (nodeId) => adapter.isWorkerDone(nodeId),
		getWorkerSessions: () => adapter.getWorkerSessions(),
		prepareStop: (reason) => adapter.prepareStop(reason),
		destroy: () => adapter.destroy(),
	};
	return handle;
}
