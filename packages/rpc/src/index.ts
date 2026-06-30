import { join } from "node:path";

export type {
	MaestroRpcClientEvents,
	MaestroRpcClientOptions,
} from "./client.js";
export { MaestroRpcClient } from "./client.js";
export type {
	AgentMessage,
	DoneMessage,
	HelloMessage,
	OrchestratorMessage,
	PingMessage,
	PongMessage,
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
 */
export function createSocketPath(planDir: string): string {
	return join(planDir, "orchestrator.sock");
}
