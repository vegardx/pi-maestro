// ─── Token snapshot (compatible with SessionTailer) ─────────────────────────

export interface TokenSnapshot {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: number;
	readonly turns: number;
}

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
}

export interface PongMessage {
	readonly type: "pong";
}

export type AgentMessage =
	| HelloMessage
	| StatusMessage
	| TokensMessage
	| DoneMessage
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

export type OrchestratorMessage = SteerMessage | ShutdownMessage | PingMessage;

// ─── Union of all messages ──────────────────────────────────────────────────

export type RpcMessage = AgentMessage | OrchestratorMessage;
