import { EventEmitter } from "node:events";
import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { AgentMessage, HelloMessage, MaestroMessage } from "./protocol.js";

export interface AgentConnection {
	readonly agentId: string;
	readonly socket: Socket;
}

export interface MaestroRpcServerEvents {
	connected: [agentId: string, hello: HelloMessage];
	disconnected: [agentId: string];
	message: [agentId: string, msg: AgentMessage];
	error: [err: Error];
}

export class MaestroRpcServer extends EventEmitter<MaestroRpcServerEvents> {
	private server: Server | undefined;
	private agents = new Map<string, AgentConnection>();
	private pending = new Set<Socket>();
	private socketPath: string | undefined;

	/**
	 * Start listening on the given Unix socket path.
	 * Removes stale socket file if present (EADDRINUSE).
	 */
	async listen(socketPath: string): Promise<void> {
		this.socketPath = socketPath;

		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}

		return new Promise((resolve, reject) => {
			const server = createServer((socket) => this.handleConnection(socket));
			server.on("error", (err) => {
				this.emit("error", err);
				reject(err);
			});
			server.listen(socketPath, () => {
				this.server = server;
				resolve();
			});
		});
	}

	/**
	 * Send a message to a specific agent by ID.
	 * Returns false if the agent is not connected.
	 */
	send(agentId: string, msg: MaestroMessage): boolean {
		const conn = this.agents.get(agentId);
		if (!conn) return false;
		conn.socket.write(`${JSON.stringify(msg)}\n`);
		return true;
	}

	/** Force-close one authenticated agent connection and reject buffered traffic. */
	disconnect(agentId: string): boolean {
		const conn = this.agents.get(agentId);
		if (!conn) return false;
		this.agents.delete(agentId);
		conn.socket.destroy();
		this.emit("disconnected", agentId);
		return true;
	}

	/**
	 * Broadcast a message to all connected agents.
	 */
	broadcast(msg: MaestroMessage): void {
		const line = `${JSON.stringify(msg)}\n`;
		for (const conn of this.agents.values()) {
			conn.socket.write(line);
		}
	}

	/**
	 * Close the server and all connections. Cleans up socket file.
	 */
	async close(): Promise<void> {
		for (const conn of this.agents.values()) {
			conn.socket.destroy();
		}
		for (const socket of this.pending) {
			socket.destroy();
		}
		this.agents.clear();
		this.pending.clear();

		return new Promise((resolve) => {
			if (!this.server) {
				this.cleanupSocketFile();
				resolve();
				return;
			}
			this.server.close(() => {
				this.cleanupSocketFile();
				resolve();
			});
			this.server = undefined;
		});
	}

	/**
	 * Number of currently connected agents.
	 */
	get size(): number {
		return this.agents.size;
	}

	/**
	 * Check if an agent is connected.
	 */
	has(agentId: string): boolean {
		return this.agents.has(agentId);
	}

	private handleConnection(socket: Socket): void {
		this.pending.add(socket);
		let buffer = "";

		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			let newlineIdx = buffer.indexOf("\n");
			while (newlineIdx !== -1) {
				const line = buffer.slice(0, newlineIdx);
				buffer = buffer.slice(newlineIdx + 1);
				this.handleLine(socket, line);
				newlineIdx = buffer.indexOf("\n");
			}
		});

		socket.on("close", () => {
			this.pending.delete(socket);
			for (const [id, conn] of this.agents) {
				if (conn.socket === socket) {
					this.agents.delete(id);
					this.emit("disconnected", id);
					break;
				}
			}
		});

		socket.on("error", () => {
			socket.destroy();
		});
	}

	private handleLine(socket: Socket, line: string): void {
		let msg: AgentMessage;
		try {
			msg = JSON.parse(line) as AgentMessage;
		} catch {
			return;
		}

		if (msg.type === "hello") {
			this.pending.delete(socket);
			const existing = this.agents.get(msg.agentId);
			if (existing) {
				existing.socket.destroy();
			}
			this.agents.set(msg.agentId, { agentId: msg.agentId, socket });
			this.emit("connected", msg.agentId, msg);
			return;
		}

		// Route message to the agent ID that owns this socket
		for (const [id, conn] of this.agents) {
			if (conn.socket === socket) {
				this.emit("message", id, msg);
				return;
			}
		}
	}

	private cleanupSocketFile(): void {
		if (this.socketPath && existsSync(this.socketPath)) {
			unlinkSync(this.socketPath);
		}
	}
}
