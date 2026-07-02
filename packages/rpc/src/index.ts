import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type {
	MaestroRpcClientEvents,
	MaestroRpcClientOptions,
} from "./client.js";
export { MaestroRpcClient } from "./client.js";
export type {
	AgentMessage,
	AnswersMessage,
	DoneMessage,
	HelloMessage,
	OrchestratorMessage,
	PingMessage,
	PongMessage,
	QuestionsMessage,
	RpcMessage,
	ShutdownMessage,
	StatusMessage,
	SteerMessage,
	TaskCompleteMessage,
	TokenSnapshot,
	TokensMessage,
} from "./protocol.js";
export type {
	AgentConnection,
	MaestroRpcServerEvents,
} from "./server.js";
export { MaestroRpcServer } from "./server.js";

/**
 * Resolve the orchestrator socket path for a given plan directory.
 * Uses a short hash under /tmp to avoid the 104-byte Unix socket path limit.
 */
export function createSocketPath(planDir: string): string {
	const hash = createHash("sha256").update(planDir).digest("hex").slice(0, 12);
	return join(tmpdir(), `maestro-${hash}.sock`);
}
