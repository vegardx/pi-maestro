// ─── RPC protocol v4 ─────────────────────────────────────────────────────────
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

export const PROTOCOL_VERSION = 4;

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
	readonly model?: string;
	readonly modelJustification?: string;
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
	/**
	 * The persisted review ledger, when one exists — a respawned worker
	 * rehydrates its review episode from this instead of starting blind.
	 */
	readonly ledger?: ReviewLedgerWire;
	/**
	 * Canonical finding ids the human has waived — the worker and verifier
	 * must not re-litigate these; they no longer hold the gate.
	 */
	readonly waivedFindingIds?: readonly string[];
}

// ─── Review ledger (wire mirror of modes' exec/findings.ts) ─────────────────
// Structural duplicate on purpose: rpc is a library package that modes depends
// on, so the canonical types (which live with the ledger logic in modes)
// cannot be imported here. Same pattern as PanelReviewerSpec ↔ SubAgentSpec.

export type LedgerSeverity = "critical" | "major" | "minor";

export interface LedgerFindingWire {
	readonly id: string;
	readonly severity: LedgerSeverity;
	readonly category: string;
	readonly file?: string;
	readonly line?: number;
	readonly task?: string;
	readonly claim?: string;
	readonly actual: string;
}

export interface LedgerEntryWire {
	readonly finding: LedgerFindingWire;
	readonly reviewer: string;
	readonly resolution?: {
		readonly id: string;
		readonly status: "fixed" | "wont-fix" | "disputed" | "duplicateOf";
		readonly note: string;
		readonly canonical?: string;
		readonly at: string;
	};
	readonly check?: {
		readonly id: string;
		readonly result: "verified" | "still-open";
		readonly note?: string;
		readonly at: string;
	};
	readonly duplicates?: readonly string[];
	readonly disputes?: number;
}

export interface ReviewLedgerWire {
	readonly round: number;
	readonly cycle: number;
	readonly entries: readonly LedgerEntryWire[];
	readonly participants?: ReadonlyArray<{
		readonly name: string;
		readonly ok: boolean;
	}>;
	/**
	 * The round currently settling behind the worker's review tool — the
	 * crash marker. Persisted at round START (roundKind "round-started") so a
	 * respawned worker reattaches to the recorded runs instead of spawning a
	 * duplicate round; the settled round's report clears it.
	 */
	readonly pendingRound?: {
		readonly kind: "panel" | "repair" | "verification";
		readonly runs: ReadonlyArray<{
			readonly name: string;
			readonly runId: string;
		}>;
		readonly startedAt: string;
	};
	readonly updatedAt: string;
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
	readonly model?: string;
	readonly effort?: ThinkingLevel;
	/**
	 * The reviewer's findings report (clipped at the sender). Carried so the
	 * maestro can show the HUMAN what is holding the gate — without it, the
	 * gate-decision question asks for an override/send-back blind.
	 */
	readonly report?: string;
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
	/**
	 * What kind of run this reports: a full persona panel round, or a scoped
	 * verification of claimed fixes. Absent on messages from older workers
	 * (treated as "panel"). "round-started" is the crash marker: NO verdicts
	 * yet — it only carries the ledger with `pendingRound` set, so the
	 * executor persists the in-flight round (and arms its completion
	 * deferral) before any reviewer settles. It never touches the verdict
	 * cache of the last real round.
	 */
	readonly roundKind?: "panel" | "verification" | "round-started";
	/** The review ledger after this run — the executor persists it on the plan. */
	readonly ledger?: ReviewLedgerWire;
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
	| PlanReadMessage
	| PlanMutateMessage
	| PanelReadMessage
	| PanelVerdictMessage
	| DebugProposalMessage
	| QuestionsMessage
	| DoneMessage
	| SummaryMessage
	| InterruptAckMessage
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
	| AnswersMessage
	| PlanReadResponseMessage
	| PanelReadResponseMessage
	| PlanMutateResultMessage
	| DebugResultMessage
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
	readonly debugProposal: DebugResultMessage;
	readonly summarize: SummaryMessage;
	readonly interrupt: InterruptAckMessage;
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
