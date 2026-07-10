// ─── RPC protocol v2 ─────────────────────────────────────────────────────────
//
// Requests carry `id: string`; responses echo it. Fire-and-forget messages
// omit `id`. Every inbound type must have a handler; unknown types answer
// `error{code:"unsupported"}` — never a silent drop.

import type {
	Answers,
	Questionnaire,
	ThinkingLevel,
	TokenSnapshot,
	WorkItemKind,
} from "@vegardx/pi-contracts";

export type { TokenSnapshot } from "@vegardx/pi-contracts";

export const PROTOCOL_VERSION = 2;

export type AgentRole = "agent" | "delegate";

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
	/** Run token (PI_MAESTRO_TOKEN); prevents wire-crossing between maestros. */
	readonly token: string;
	readonly pid: number;
	/** True when reconnecting after a respawn/resume. */
	readonly resumed?: boolean;
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

/**
 * One reviewer in a deliverable's review panel. Structural mirror of modes'
 * `SubAgentSpec` (rpc must not depend on the modes package); the field types
 * come from pi-contracts so the two are assignment-compatible.
 */
export interface PanelReviewerSpec {
	readonly name: string;
	readonly persona: string;
	readonly focus?: string;
	readonly effort?: ThinkingLevel;
	readonly kind?: "review" | "helper";
	readonly required?: boolean;
}

/** Agent requests its deliverable's review panel (the subAgents to run). */
export interface PanelReadMessage {
	readonly type: "panelRead";
	readonly id: string;
	readonly deliverableId: string;
}

/** Maestro returns the deliverable's live panel. */
export interface PanelReadResponseMessage {
	readonly type: "panelReadResponse";
	readonly id: string;
	readonly panel: readonly PanelReviewerSpec[];
}

/** Verdict of one reviewer in a completed panel round. */
export type PanelVerdict = "approve" | "request-changes" | "none";

export interface PanelVerdictEntry {
	readonly name: string;
	readonly persona: string;
	readonly required: boolean;
	readonly verdict: PanelVerdict;
	/** False when the reviewer failed to run / produced no verdict. */
	readonly ok: boolean;
	/**
	 * Set when a HUMAN overrode this verdict (gate-decision flow): the
	 * human's reason. Surfaces in the PR body and recap for provenance.
	 */
	readonly humanOverride?: string;
}

/**
 * Agent reports a completed panel round's verdicts. Fire-and-forget: it drives
 * the executor's ship gate, which reads the latest round per deliverable. The
 * executor gates independently of the worker's own "done" claim.
 */
export interface PanelVerdictMessage {
	readonly type: "panelVerdict";
	readonly deliverableId: string;
	readonly round: number;
	readonly verdicts: readonly PanelVerdictEntry[];
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
	| PlanReadMessage
	| PlanMutateMessage
	| PanelReadMessage
	| PanelVerdictMessage
	| QuestionsMessage
	| DoneMessage
	| SummaryMessage
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

export interface SteerMessage {
	readonly type: "steer";
	readonly content: string;
}

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
	| SteerMessage
	| AnswersMessage
	| PlanReadResponseMessage
	| PanelReadResponseMessage
	| PlanMutateResultMessage
	| DoneAckMessage
	| ShutdownMessage
	| PingMessage
	| ErrorMessage;

// ─── Union of all messages ───────────────────────────────────────────────────

export type RpcMessage = AgentMessage | MaestroMessage;

// ─── Request/response correlation ────────────────────────────────────────────

/** Maps each request type to its response type. */
interface ResponseByRequestType {
	readonly hello: HelloAckMessage;
	readonly planRead: PlanReadResponseMessage;
	readonly panelRead: PanelReadResponseMessage;
	readonly planMutate: PlanMutateResultMessage;
	readonly questions: AnswersMessage;
	readonly done: DoneAckMessage;
	readonly summarize: SummaryMessage;
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
