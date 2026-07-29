// The two ends of the wire.
//
// Newline-delimited JSON over a Unix socket, with a `StringDecoder` so a
// multibyte character split across two `data` events cannot corrupt into
// replacement characters before reassembly. That much is ordinary.
//
// What is not ordinary is the exit. `AgentLink.done()` returns a promise that
// resolves when maestro sends `release`, and nothing else resolves it. An agent
// that has reported its result is still running, still connected, and still
// collectable until maestro decides otherwise. The alternative — an agent that
// reports and leaves — is what lost the output of all five nodes on one run,
// and no amount of care at the collection site can close a window that the
// protocol leaves open.

import { EventEmitter } from "node:events";
import { existsSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { TokenSnapshot } from "@vegardx/pi-contracts";
import {
	type AgentMessage,
	checkDone,
	type Done,
	type Hello,
	type MaestroMessage,
	PROTOCOL_VERSION,
	type Status,
	verifyHello,
} from "./protocol.js";

/** Read newline-delimited frames off a socket. Returns a detach function. */
function readFrames(socket: Socket, onFrame: (line: string) => void): void {
	let buffer = "";
	const decoder = new StringDecoder("utf8");
	socket.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		let at = buffer.indexOf("\n");
		while (at !== -1) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			if (line.length > 0) onFrame(line);
			at = buffer.indexOf("\n");
		}
	});
}

function write(socket: Socket, message: unknown): boolean {
	if (socket.destroyed) return false;
	socket.write(`${JSON.stringify(message)}\n`);
	return true;
}

// ─── Maestro side ────────────────────────────────────────────────────────────

export interface ConnectedAgent {
	readonly agentId: string;
	readonly hello: Hello;
	readonly socket: Socket;
	/** Set once it has reported. Until released, it is still alive. */
	done?: Done;
}

export interface MaestroLinkEvents {
	connected: [agentId: string, hello: Hello];
	status: [agentId: string, status: Status];
	tokens: [agentId: string, snapshot: TokenSnapshot];
	done: [agentId: string, done: Done];
	agentError: [agentId: string, message: string];
	/**
	 * `awaitingRelease` distinguishes an agent that vanished while waiting to be
	 * let go — a crash, whose result maestro already has — from one that
	 * disappeared mid-work, whose deliverable failed.
	 */
	disconnected: [agentId: string, awaitingRelease: boolean];
	rejected: [reason: string];
	error: [error: Error];
}

export interface MaestroLinkOptions {
	/** The run token every agent must present. */
	readonly token: string;
	readonly version?: number;
}

export class MaestroLink extends EventEmitter<MaestroLinkEvents> {
	private server: Server | undefined;
	private socketPath: string | undefined;
	private readonly agents = new Map<string, ConnectedAgent>();
	private readonly pending = new Set<Socket>();

	constructor(private readonly options: MaestroLinkOptions) {
		super();
	}

	async listen(socketPath: string): Promise<void> {
		this.socketPath = socketPath;
		// A socket file left by a crashed maestro is stale by definition: the
		// process that owned it is gone.
		if (existsSync(socketPath)) unlinkSync(socketPath);

		return new Promise((resolve, reject) => {
			const server = createServer((socket) => this.accept(socket));
			server.on("error", (error) => {
				this.emit("error", error);
				reject(error);
			});
			server.listen(socketPath, () => {
				this.server = server;
				resolve();
			});
		});
	}

	/** Let an agent exit. The only thing that resolves its `done()`. */
	release(agentId: string): boolean {
		const agent = this.agents.get(agentId);
		if (!agent) return false;
		return write(agent.socket, { type: "release" } satisfies MaestroMessage);
	}

	shutdown(agentId: string, reason: string): boolean {
		const agent = this.agents.get(agentId);
		if (!agent) return false;
		return write(agent.socket, {
			type: "shutdown",
			reason,
		} satisfies MaestroMessage);
	}

	/** Everyone who has reported and is waiting to be let go. */
	awaitingRelease(): string[] {
		return [...this.agents.values()]
			.filter((a) => a.done !== undefined)
			.map((a) => a.agentId);
	}

	has(agentId: string): boolean {
		return this.agents.has(agentId);
	}

	get size(): number {
		return this.agents.size;
	}

	async close(): Promise<void> {
		for (const agent of this.agents.values()) agent.socket.destroy();
		for (const socket of this.pending) socket.destroy();
		this.agents.clear();
		this.pending.clear();
		const server = this.server;
		this.server = undefined;
		return new Promise((resolve) => {
			const finish = () => {
				if (this.socketPath && existsSync(this.socketPath))
					unlinkSync(this.socketPath);
				resolve();
			};
			if (!server) return finish();
			server.close(finish);
		});
	}

	private accept(socket: Socket): void {
		this.pending.add(socket);
		readFrames(socket, (line) => this.onFrame(socket, line));
		socket.on("close", () => this.onClose(socket));
		socket.on("error", () => socket.destroy());
	}

	private onFrame(socket: Socket, line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}

		if (this.pending.has(socket)) {
			this.onHello(socket, message);
			return;
		}

		const agent = this.owner(socket);
		if (!agent) return;
		this.onAgentMessage(agent, message as AgentMessage);
	}

	private onHello(socket: Socket, message: unknown): void {
		const reason = verifyHello(message, {
			token: this.options.token,
			version: this.options.version ?? PROTOCOL_VERSION,
		});
		if (reason !== null) {
			write(socket, { type: "reject", reason } satisfies MaestroMessage);
			this.pending.delete(socket);
			this.emit("rejected", reason);
			// Destroyed rather than left open: a connection that failed the
			// handshake has nothing further it is allowed to say.
			socket.destroy();
			return;
		}

		const hello = message as Hello;
		this.pending.delete(socket);
		// A second connection under the same id is a resume. The old socket is
		// by definition dead or orphaned, so the new one wins.
		this.agents.get(hello.agentId)?.socket.destroy();
		this.agents.set(hello.agentId, {
			agentId: hello.agentId,
			hello,
			socket,
		});
		write(socket, { type: "welcome" } satisfies MaestroMessage);
		this.emit("connected", hello.agentId, hello);
	}

	private onAgentMessage(agent: ConnectedAgent, message: AgentMessage): void {
		switch (message?.type) {
			case "status":
				this.emit("status", agent.agentId, message);
				return;
			case "tokens":
				this.emit("tokens", agent.agentId, message.snapshot);
				return;
			case "error":
				this.emit("agentError", agent.agentId, message.message);
				return;
			case "done": {
				const wrong = checkDone(message);
				if (wrong !== null) {
					// Not recorded as a result: a report that does not say what
					// happened is not a report. The agent is stopped, and the
					// deliverable fails through the disconnect path with a reason.
					this.emit("agentError", agent.agentId, wrong);
					this.shutdown(agent.agentId, wrong);
					return;
				}
				agent.done = message;
				this.emit("done", agent.agentId, message);
				return;
			}
			default:
				return;
		}
	}

	private owner(socket: Socket): ConnectedAgent | undefined {
		for (const agent of this.agents.values())
			if (agent.socket === socket) return agent;
		return undefined;
	}

	private onClose(socket: Socket): void {
		this.pending.delete(socket);
		const agent = this.owner(socket);
		if (!agent) return;
		this.agents.delete(agent.agentId);
		this.emit("disconnected", agent.agentId, agent.done !== undefined);
	}
}

// ─── Agent side ──────────────────────────────────────────────────────────────

/** Everything an agent needs to identify itself. No kind: see `Hello`. */
export interface AgentIdentity {
	readonly agentId: string;
	readonly token: string;
	readonly resumed?: boolean;
}

export class HandshakeRejected extends Error {
	constructor(readonly reason: string) {
		super(`maestro rejected the connection: ${reason}`);
		this.name = "HandshakeRejected";
	}
}

export interface AgentLinkEvents {
	shutdown: [reason: string];
	disconnected: [];
	error: [error: Error];
}

export class AgentLink extends EventEmitter<AgentLinkEvents> {
	private socket: Socket | undefined;
	private awaitingRelease: (() => void) | undefined;

	/**
	 * Connect and complete the handshake. Resolves on `welcome`, rejects on
	 * `reject` — a rejected agent must stop, not retry, because every reason it
	 * can be rejected for (wrong token, wrong version) will still be true next
	 * time.
	 */
	async connect(socketPath: string, identity: AgentIdentity): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = connect(socketPath);
			this.socket = socket;
			let settled = false;

			const settle = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (error) reject(error);
				else resolve();
			};

			socket.on("error", (error) => {
				settle(error);
				if (settled) this.emit("error", error);
				socket.destroy();
			});

			socket.on("close", () => {
				this.socket = undefined;
				settle(new Error("maestro closed the connection during handshake"));
				// A connection lost while waiting to be released means nobody is
				// coming. Unblocking is the only alternative to hanging forever.
				this.awaitingRelease?.();
				this.awaitingRelease = undefined;
				this.emit("disconnected");
			});

			readFrames(socket, (line) => {
				let message: MaestroMessage;
				try {
					message = JSON.parse(line) as MaestroMessage;
				} catch {
					return;
				}
				switch (message.type) {
					case "welcome":
						settle();
						return;
					case "reject":
						settle(new HandshakeRejected(message.reason));
						socket.destroy();
						return;
					case "release":
						this.awaitingRelease?.();
						this.awaitingRelease = undefined;
						return;
					case "shutdown":
						this.emit("shutdown", message.reason);
						return;
				}
			});

			socket.on("connect", () => {
				const hello: Hello = {
					type: "hello",
					v: PROTOCOL_VERSION,
					agentId: identity.agentId,
					token: identity.token,
					pid: process.pid,
					...(identity.resumed ? { resumed: true } : {}),
				};
				write(socket, hello);
			});
		});
	}

	status(state: Status["state"], detail?: string): boolean {
		return this.send({ type: "status", state, ...(detail ? { detail } : {}) });
	}

	tokens(snapshot: TokenSnapshot): boolean {
		return this.send({ type: "tokens", snapshot });
	}

	error(message: string): boolean {
		return this.send({ type: "error", message });
	}

	/**
	 * Report the result, then wait to be let go.
	 *
	 * The waiting is the point. Returning here without a `release` would put the
	 * agent's exit back under its own control, which is the race this protocol
	 * was rebuilt to remove.
	 */
	async done(result: Omit<Done, "type">): Promise<void> {
		const message: Done = { type: "done", ...result };
		const wrong = checkDone(message);
		if (wrong !== null) throw new Error(`cannot report done: ${wrong}`);
		if (!this.send(message))
			throw new Error("cannot report done: not connected to maestro");
		return new Promise((resolve) => {
			this.awaitingRelease = resolve;
		});
	}

	get connected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed;
	}

	close(): void {
		this.awaitingRelease = undefined;
		this.socket?.destroy();
		this.socket = undefined;
	}

	private send(message: AgentMessage): boolean {
		return this.socket ? write(this.socket, message) : false;
	}
}
