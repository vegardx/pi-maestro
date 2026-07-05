// ─── Token snapshot (re-exported from contracts; single source of truth) ────

import type {
	Answers,
	Questionnaire,
	TokenSnapshot,
} from "@vegardx/pi-contracts";

export type { TokenSnapshot } from "@vegardx/pi-contracts";

// ─── Agent → Orchestrator ───────────────────────────────────────────────────

export interface HelloMessage {
	readonly type: "hello";
	readonly agentId: string;
}

export interface StatusMessage {
	readonly type: "status";
	readonly status: "working" | "idle" | "error";
	readonly detail?: string;
}

export interface TokensMessage {
	readonly type: "tokens";
	readonly snapshot: TokenSnapshot;
}

export interface DoneMessage {
	readonly type: "done";
	readonly summary?: string;
	readonly prUrl?: string;
	readonly commits?: string[];
	readonly model?: string;
}

export interface TaskCompleteMessage {
	readonly type: "taskComplete";
	readonly taskId: string;
}

export interface PongMessage {
	readonly type: "pong";
}

/** Agent asks the orchestrator one or more questions; blocks for answers. */
export interface QuestionsMessage {
	readonly type: "questions";
	readonly questions: Questionnaire;
}

/** Agent reports usage from a lens sub-invocation (a child pi process). */
export interface LensUsageMessage {
	readonly type: "lensUsage";
	readonly lens: string;
	readonly snapshot: TokenSnapshot;
}

export type AgentMessage =
	| HelloMessage
	| StatusMessage
	| TokensMessage
	| DoneMessage
	| TaskCompleteMessage
	| QuestionsMessage
	| LensUsageMessage
	| PongMessage;

// ─── Orchestrator → Agent ───────────────────────────────────────────────────

export interface SteerMessage {
	readonly type: "steer";
	readonly content: string;
}

export interface ShutdownMessage {
	readonly type: "shutdown";
	readonly reason?: string;
}

export interface PingMessage {
	readonly type: "ping";
}

/** Orchestrator returns answers to a prior QuestionsMessage. */
export interface AnswersMessage {
	readonly type: "answers";
	readonly answers: Answers;
}

export type OrchestratorMessage =
	| SteerMessage
	| ShutdownMessage
	| AnswersMessage
	| PingMessage;

// ─── Union of all messages ──────────────────────────────────────────────────

export type RpcMessage = AgentMessage | OrchestratorMessage;
