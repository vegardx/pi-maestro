// ─── Token snapshot (re-exported from contracts; single source of truth) ────

import type {
	Answers,
	Questionnaire,
	TokenSnapshot,
	WorkItemKind,
} from "@vegardx/pi-contracts";

export type { TokenSnapshot } from "@vegardx/pi-contracts";

// ─── Agent → Maestro ───────────────────────────────────────────────────

export interface HelloMessage {
	readonly type: "hello";
	readonly agentId: string;
	readonly model?: string;
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

/** Agent asks the maestro one or more questions; blocks for answers. */
export interface QuestionsMessage {
	readonly type: "questions";
	readonly questions: Questionnaire;
}

/** Agent reports usage from a lens sub-invocation (a child pi process). */
export interface LensUsageMessage {
	readonly type: "lensUsage";
	readonly lens: string;
	readonly snapshot: TokenSnapshot;
	readonly findings?: number;
	readonly fixed?: number;
	readonly model?: string;
	readonly effort?: string;
}

/** Agent requests current plan state from maestro. */
export interface PlanReadMessage {
	readonly type: "planRead";
}

/** Agent requests a plan mutation from maestro. */
export interface PlanMutateMessage {
	readonly type: "planMutate";
	readonly action: "toggleTask" | "addTask" | "updateTask";
	readonly deliverableId: string;
	readonly params: {
		readonly taskId?: string;
		readonly title?: string;
		readonly body?: string;
		readonly kind?: WorkItemKind;
	};
}

export type AgentMessage =
	| HelloMessage
	| StatusMessage
	| TokensMessage
	| DoneMessage
	| TaskCompleteMessage
	| QuestionsMessage
	| LensUsageMessage
	| PlanReadMessage
	| PlanMutateMessage
	| PongMessage;

// ─── Maestro → Agent ───────────────────────────────────────────────────

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

/** Maestro returns answers to a prior QuestionsMessage. */
export interface AnswersMessage {
	readonly type: "answers";
	readonly answers: Answers;
}

/** Maestro returns rendered plan state in response to planRead. */
export interface PlanReadResponseMessage {
	readonly type: "planReadResponse";
	readonly content: string;
}

/** Maestro returns the result of a plan mutation. */
export interface PlanMutateResultMessage {
	readonly type: "planMutateResult";
	readonly success: boolean;
	readonly taskId?: string;
	readonly error?: string;
}

export type MaestroMessage =
	| SteerMessage
	| ShutdownMessage
	| AnswersMessage
	| PlanReadResponseMessage
	| PlanMutateResultMessage
	| PingMessage;

// ─── Union of all messages ──────────────────────────────────────────────────

export type RpcMessage = AgentMessage | MaestroMessage;
