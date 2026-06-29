import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import type { AgentMessage, OrchestratorMessage } from "./protocol.js";

export interface MaestroRpcClientEvents {
	connected: [];
	disconnected: [];
	message: [msg: OrchestratorMessage];
	error: [err: Error];
}

export interface MaestroRpcClientOptions {
	/** Retry connection on failure. Default: true */
	reconnect?: boolean;
	/** Initial retry delay in ms. Default: 500 */
	retryDelayMs?: number;
	/** Max retry delay in ms. Default: 5000 */
	maxRetryDelayMs?: number;
}

export class MaestroRpcClient extends EventEmitter<MaestroRpcClientEvents> {
	private socket: Socket | undefined;
	private socketPath: string | undefined;
	private agentId: string | undefined;
	private buffer = "";
	private closed = false;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryDelay: number;
	private readonly reconnect: boolean;
	private readonly initialRetryDelay: number;
	private readonly maxRetryDelay: number;

	constructor(options: MaestroRpcClientOptions = {}) {
		super();
		this.reconnect = options.reconnect ?? true;
		this.initialRetryDelay = options.retryDelayMs ?? 500;
		this.maxRetryDelay = options.maxRetryDelayMs ?? 5000;
		this.retryDelay = this.initialRetryDelay;
	}

	/**
	 * Connect to the orchestrator socket and send hello.
	 */
	connect(socketPath: string, agentId: string): void {
		this.socketPath = socketPath;
		this.agentId = agentId;
		this.closed = false;
		this.attemptConnect();
	}

	/**
	 * Send a message to the orchestrator.
	 */
	send(msg: AgentMessage): boolean {
		if (!this.socket || this.socket.destroyed) return false;
		this.socket.write(`${JSON.stringify(msg)}\n`);
		return true;
	}

	/**
	 * Gracefully close the connection. Stops reconnect attempts.
	 */
	close(): void {
		this.closed = true;
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		if (this.socket) {
			this.socket.destroy();
			this.socket = undefined;
		}
	}

	/**
	 * Whether the client has an active connection.
	 */
	get connected(): boolean {
		return !!this.socket && !this.socket.destroyed;
	}

	private attemptConnect(): void {
		if (this.closed || !this.socketPath || !this.agentId) return;

		const socket = connect(this.socketPath);
		this.socket = socket;

		socket.on("connect", () => {
			this.retryDelay = this.initialRetryDelay;
			this.buffer = "";
			// Send hello immediately
			socket.write(
				`${JSON.stringify({ type: "hello", agentId: this.agentId })}\n`,
			);
			this.emit("connected");
		});

		socket.on("data", (chunk) => {
			this.buffer += chunk.toString();
			let newlineIdx = this.buffer.indexOf("\n");
			while (newlineIdx !== -1) {
				const line = this.buffer.slice(0, newlineIdx);
				this.buffer = this.buffer.slice(newlineIdx + 1);
				this.handleLine(line);
				newlineIdx = this.buffer.indexOf("\n");
			}
		});

		socket.on("close", () => {
			this.socket = undefined;
			if (!this.closed) {
				this.emit("disconnected");
				this.scheduleRetry();
			}
		});

		socket.on("error", (err) => {
			if (!this.closed) {
				this.emit("error", err);
			}
			socket.destroy();
		});
	}

	private scheduleRetry(): void {
		if (!this.reconnect || this.closed) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
			this.attemptConnect();
		}, this.retryDelay);
	}

	private handleLine(line: string): void {
		try {
			const msg = JSON.parse(line) as OrchestratorMessage;
			this.emit("message", msg);
		} catch {
			// Ignore malformed lines
		}
	}
}
