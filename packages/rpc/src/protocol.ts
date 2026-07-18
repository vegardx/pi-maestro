// ─── RPC protocol v6 ─────────────────────────────────────────────────────────
//
// Requests carry `id: string`; responses echo it. Fire-and-forget messages
// omit `id`. Every inbound type must have a handler; unknown types answer
// `error{code:"unsupported"}` — never a silent drop.

import type {
	AgentKind,
	Answers,
	ChildRunProjection,
	InterruptOutcome,
	Questionnaire,
	ResolvedAgentAssignment,
	StopRecord,
	TokenSnapshot,
	UsageCheckpoint,
	WorkflowStage,
	WorkItemKind,
} from "@vegardx/pi-contracts";

export type { TokenSnapshot } from "@vegardx/pi-contracts";

export const PROTOCOL_VERSION = 6;
export const RPC_SCHEMA_VERSION = PROTOCOL_VERSION;

export type AgentRole = "agent";

export type RpcErrorCode =
	| "unsupported"
	| "cancelled"
	| "timeout"
	| "badRequest"
	| "internal";

// ─── Agent → Maestro ─────────────────────────────────────────────────────────

/** First message on connect; maestro answers with helloAck. */
export interface HelloMessage {
	readonly type: "hello";
	readonly id: string;
	/** Protocol version (PROTOCOL_VERSION). */
	readonly v: number;
	readonly agentId: string;
	readonly role: AgentRole;
	readonly kind: AgentKind;
	readonly generation: number;
	readonly assignment: ResolvedAgentAssignment;
	/** Run token (PI_MAESTRO_TOKEN); prevents wire-crossing between maestros. */
	readonly token: string;
	readonly pid: number;
	/** True when reconnecting after a respawn/resume. */
	readonly resumed?: boolean;
}

export interface StatusMessage {
	readonly type: "status";
	readonly status: "working" | "idle" | "stopping" | "stopped" | "error";
	readonly workflowStage?: WorkflowStage;
	readonly completedAt?: number;
	readonly stop?: StopRecord;
	readonly detail?: string;
}

export interface TokensMessage {
	readonly type: "tokens";
	/** Monotonic revision of this process-generation cumulative checkpoint. */
	readonly revision: number;
	readonly snapshot: TokenSnapshot;
}

/**
 * Retry-safe cumulative child state. `reconcile` replaces the owner's known
 * set for this generation; ordinary updates only upsert newer revisions.
 */
export interface ChildRunSyncMessage {
	readonly type: "childRunSync";
	readonly id: string;
	readonly ownerGeneration: number;
	readonly reconcile: boolean;
	readonly runs: readonly ChildRunProjection[];
}

export interface ChildRunSyncAckMessage {
	readonly type: "childRunSyncAck";
	readonly id: string;
	readonly ownerGeneration: number;
	readonly accepted: ReadonlyArray<{
		readonly runId: string;
		readonly revision: number;
	}>;
}

export type ChildRunControlAction = "steer" | "interrupt" | "capture" | "stop";

export interface ChildRunControlMessage {
	readonly type: "childRunControl";
	readonly id: string;
	readonly ownerGeneration: number;
	readonly runId: string;
	readonly action: ChildRunControlAction;
	readonly guidance?: string;
	readonly reason?: string;
	readonly lines?: number;
}

export interface ChildRunControlResultMessage {
	readonly type: "childRunControlResult";
	readonly id: string;
	readonly ownerGeneration: number;
	readonly runId: string;
	readonly action: ChildRunControlAction;
	readonly ok: boolean;
	readonly outcome?: InterruptOutcome;
	readonly content?: string;
	readonly error?: string;
}

/** Cumulative usage for a worker-owned child run. */
export interface UsageCheckpointMessage {
	readonly type: "usageCheckpoint";
	readonly checkpoint: UsageCheckpoint;
}

/** Agent requests current plan state from maestro. */
export interface PlanReadMessage {
	readonly type: "planRead";
	readonly id: string;
}

/** Agent requests a plan mutation from maestro (absorbs the old taskComplete). */
export interface PlanMutateMessage {
	readonly type: "planMutate";
	readonly id: string;
	readonly action: "toggleTask" | "addTask" | "updateTask";
	readonly deliverableId: string;
	readonly params: {
		readonly taskId?: string;
		readonly title?: string;
		readonly body?: string;
		readonly kind?: WorkItemKind;
		/** Toggle of the postflight task: the deliverable's downstream handoff. */
		readonly summary?: string;
	};
}

/** Agent asks the maestro one or more questions; blocks for answers. */
export interface QuestionsMessage {
	readonly type: "questions";
	readonly id: string;
	readonly questions: Questionnaire;
}

/** Agent reports completion; maestro answers with doneAck. */
export interface DoneMessage {
	readonly type: "done";
	readonly id: string;
	readonly summary?: string;
	readonly commits?: string[];
}

/** Agent answers a summarize request. */
export interface SummaryMessage {
	readonly type: "summary";
	readonly id: string;
	readonly content: string;
}

export interface DebugRecoveryProposalWire {
	readonly kind:
		| "steer"
		| "retry-activation"
		| "restart-resume"
		| "restart-fresh"
		| "repair"
		| "none";
	readonly targetDeliverableId?: string;
	readonly expectedGeneration?: number;
	readonly basePlanFingerprint?: string;
	readonly guidance?: string;
	readonly repairReason?: string;
	readonly repairOperations?: readonly unknown[];
	readonly continuation?:
		| "retry-activation"
		| "restart-resume"
		| "restart-fresh"
		| "none";
	readonly confidence: number;
	readonly rationale: string;
}

/** A worker's bounded diagnosis proposal. Maestro validates and owns action. */
export interface DebugProposalMessage {
	readonly type: "debugProposal";
	readonly id: string;
	readonly proposalId: string;
	readonly agentId: string;
	readonly generation: number;
	readonly planFingerprint: string;
	readonly observed: readonly string[];
	readonly likelyCause: string;
	readonly recovery?: DebugRecoveryProposalWire;
}

/** Agent answers a ping. */
export interface PongMessage {
	readonly type: "pong";
	readonly id: string;
}

export type AgentMessage =
	| HelloMessage
	| StatusMessage
	| TokensMessage
	| ChildRunSyncMessage
	| ChildRunControlResultMessage
	| UsageCheckpointMessage
	| PlanReadMessage
	| PlanMutateMessage
	| DebugProposalMessage
	| QuestionsMessage
	| DoneMessage
	| SummaryMessage
	| InterruptAckMessage
	| PrepareStopAckMessage
	| PongMessage;

// ─── Maestro → Agent ─────────────────────────────────────────────────────────

/** Maestro accepts or rejects a hello (token mismatch → ok:false). */
export interface HelloAckMessage {
	readonly type: "helloAck";
	readonly id?: string;
	readonly ok: boolean;
	readonly planSlug?: string;
	readonly error?: string;
}

/** Maestro requests a forward-looking summary from the agent. */
export interface SummarizeMessage {
	readonly type: "summarize";
	readonly id: string;
	/** Who the summary is written for (the next consumers). */
	readonly consumer: string;
	readonly preamble: string;
	/** Hard token budget for the summary. */
	readonly budget: number;
}

export interface InterruptMessage {
	readonly type: "interrupt";
	readonly id: string;
	readonly turnId?: string;
	readonly reason?: string;
}

export interface InterruptAckMessage {
	readonly type: "interruptAck";
	readonly id: string;
	readonly turnId?: string;
	readonly outcome:
		| "accepted"
		| "already-idle"
		| "already-interrupting"
		| "disconnected";
}

export interface SteerMessage {
	readonly type: "steer";
	readonly content: string;
}

/** Maestro routes control to a child owned by this authenticated worker. */
export type ChildRunControlRequestMessage = ChildRunControlMessage;

/** Maestro returns answers to a prior QuestionsMessage. */
export interface AnswersMessage {
	readonly type: "answers";
	readonly id: string;
	readonly answers: Answers;
}

/** Maestro returns rendered plan state in response to planRead. */
export interface PlanReadResponseMessage {
	readonly type: "planReadResponse";
	readonly id: string;
	readonly content: string;
}

/** Maestro returns the result of a plan mutation. */
export interface PlanMutateResultMessage {
	readonly type: "planMutateResult";
	readonly id: string;
	readonly success: boolean;
	readonly taskId?: string;
	readonly error?: string;
}

/** Maestro acknowledges a done message. */
export interface DoneAckMessage {
	readonly type: "doneAck";
	readonly id: string;
}

export interface DebugResultMessage {
	readonly type: "debugResult";
	readonly id: string;
	readonly proposalId: string;
	readonly accepted: boolean;
	readonly episodeId?: string;
	readonly recovery?: {
		readonly action: DebugRecoveryProposalWire["kind"];
		readonly ok: boolean;
		readonly detail: string;
	};
	readonly error?: string;
}

export interface PrepareStopMessage {
	readonly type: "prepareStop";
	readonly id: string;
	readonly requestedAt: number;
	readonly deadlineAt: number;
	readonly reason?: string;
}

/** Acknowledges only after the worker has persisted/flushed and requested shutdown. */
export interface PrepareStopAckMessage {
	readonly type: "prepareStopAck";
	readonly id: string;
	readonly completedAt: number;
	readonly children: number;
	readonly usageRevision: number;
	readonly outcome: "cooperative";
}

export interface ShutdownMessage {
	readonly type: "shutdown";
	readonly reason?: string;
}

export interface PingMessage {
	readonly type: "ping";
	readonly id: string;
}

/** Explicit failure for a request (or a connection-level fault when id is absent). */
export interface ErrorMessage {
	readonly type: "error";
	readonly id?: string;
	readonly code: RpcErrorCode;
	readonly message: string;
}

export type MaestroMessage =
	| HelloAckMessage
	| SummarizeMessage
	| InterruptMessage
	| SteerMessage
	| ChildRunSyncAckMessage
	| ChildRunControlRequestMessage
	| AnswersMessage
	| PlanReadResponseMessage
	| PlanMutateResultMessage
	| DebugResultMessage
	| DoneAckMessage
	| PrepareStopMessage
	| ShutdownMessage
	| PingMessage
	| ErrorMessage;

// ─── Union of all messages ───────────────────────────────────────────────────

export type RpcMessage = AgentMessage | MaestroMessage;

// ─── Request/response correlation ────────────────────────────────────────────

/** Maps each request type to its response type. */
interface ResponseByRequestType {
	readonly hello: HelloAckMessage;
	readonly childRunSync: ChildRunSyncAckMessage;
	readonly childRunControl: ChildRunControlResultMessage;
	readonly planRead: PlanReadResponseMessage;
	readonly planMutate: PlanMutateResultMessage;
	readonly questions: AnswersMessage;
	readonly done: DoneAckMessage;
	readonly debugProposal: DebugResultMessage;
	readonly summarize: SummaryMessage;
	readonly interrupt: InterruptAckMessage;
	readonly prepareStop: PrepareStopAckMessage;
	readonly ping: PongMessage;
}

/** Messages that expect a correlated response echoing their id. */
export type RequestMessage = Extract<
	RpcMessage,
	{ type: keyof ResponseByRequestType }
>;

/** The response type paired with a given request message. */
export type ResponseFor<T extends RequestMessage> =
	ResponseByRequestType[T["type"]];

// ─── Dispatch tables ─────────────────────────────────────────────────────────

/**
 * Exhaustive handler table over a message union: one handler per `type`.
 * Declaring a table `satisfies HandlerTable<AgentMessage, R>` makes the
 * compiler reject missing or unknown message types.
 */
export type HandlerTable<M extends { type: string }, R = void> = {
	readonly [T in M["type"]]: (msg: Extract<M, { type: T }>) => R;
};

/** Handler table for everything an agent can send the maestro. */
export type AgentMessageHandlers<R = void> = HandlerTable<AgentMessage, R>;

/** Handler table for everything the maestro can send an agent. */
export type MaestroMessageHandlers<R = void> = HandlerTable<MaestroMessage, R>;
