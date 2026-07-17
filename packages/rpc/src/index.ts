import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type {
	HelloIdentity,
	MaestroRpcClientEvents,
	MaestroRpcClientOptions,
} from "./client.js";
export { MaestroRpcClient } from "./client.js";
export type {
	AgentMessage,
	AgentMessageHandlers,
	AgentRole,
	AnswersMessage,
	DebugProposalMessage,
	DebugRecoveryProposalWire,
	DebugResultMessage,
	DoneAckMessage,
	DoneMessage,
	ErrorMessage,
	HandlerTable,
	HelloAckMessage,
	HelloMessage,
	InterruptAckMessage,
	InterruptMessage,
	LedgerEntryWire,
	LedgerFindingWire,
	LedgerSeverity,
	MaestroMessage,
	MaestroMessageHandlers,
	PanelReadMessage,
	PanelReadResponseMessage,
	PanelReviewerSpec,
	PanelVerdict,
	PanelVerdictEntry,
	PanelVerdictMessage,
	PingMessage,
	PlanMutateMessage,
	PlanMutateResultMessage,
	PlanReadMessage,
	PlanReadResponseMessage,
	PongMessage,
	QuestionsMessage,
	RequestMessage,
	ResponseFor,
	ReviewLedgerWire,
	RpcErrorCode,
	RpcMessage,
	ShutdownMessage,
	StatusMessage,
	SteerMessage,
	SummarizeMessage,
	SummaryMessage,
	TokenSnapshot,
	TokensMessage,
} from "./protocol.js";
export { PROTOCOL_VERSION, RPC_SCHEMA_VERSION } from "./protocol.js";
export type {
	AgentConnection,
	MaestroRpcServerEvents,
} from "./server.js";
export { MaestroRpcServer } from "./server.js";

/**
 * Resolve the maestro socket path for a given plan directory.
 * Uses a short hash under /tmp to avoid the 104-byte Unix socket path limit.
 */
export function createSocketPath(planDir: string): string {
	const hash = createHash("sha256").update(planDir).digest("hex").slice(0, 12);
	return join(tmpdir(), `maestro-${hash}.sock`);
}
