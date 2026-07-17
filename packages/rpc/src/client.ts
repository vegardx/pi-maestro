import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
	type AgentMessage,
	type HelloMessage,
	type MaestroMessage,
	PROTOCOL_VERSION,
} from "./protocol.js";

export interface MaestroRpcClientEvents {
	connected: [];
	disconnected: [];
	message: [msg: MaestroMessage];
	error: [err: Error];
}

/** Identity fields for the hello sent on (re)connect. */
export type HelloIdentity = Omit<
	HelloMessage,
	"type" | "id" | "v" | "kind" | "generation" | "assignment"
> &
	Partial<Pick<HelloMessage, "kind" | "generation" | "assignment">>;

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
	private identity: HelloIdentity | undefined;
	private buffer = "";
	// Decodes UTF-8 across chunk boundaries; reset per connection in connect().
	private decoder = new StringDecoder("utf8");
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
	 * Connect to the maestro socket and send hello.
	 */
	connect(socketPath: string, identity: HelloIdentity): void {
		this.socketPath = socketPath;
		this.identity = identity;
		this.closed = false;
		this.attemptConnect();
	}

	/**
	 * Send a message to the maestro.
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
		if (this.closed || !this.socketPath || !this.identity) return;
		const identity = this.identity;

		const socket = connect(this.socketPath);
		this.socket = socket;

		socket.on("connect", () => {
			this.retryDelay = this.initialRetryDelay;
			this.buffer = "";
			this.decoder = new StringDecoder("utf8");
			// Send hello immediately
			const hello: HelloMessage = {
				type: "hello",
				id: randomUUID(),
				v: PROTOCOL_VERSION,
				kind: identity.kind ?? "worker",
				generation: identity.generation ?? 0,
				assignment: identity.assignment ?? defaultAssignment(identity.agentId),
				...identity,
			};
			socket.write(`${JSON.stringify(hello)}\n`);
			this.emit("connected");
		});

		socket.on("data", (chunk) => {
			this.buffer += this.decoder.write(chunk);
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
			const msg = JSON.parse(line) as MaestroMessage;
			this.emit("message", msg);
		} catch {
			// Ignore malformed lines
		}
	}
}

function defaultAssignment(agentId: string): HelloMessage["assignment"] {
	return {
		agentId,
		kind: "worker",
		presetId: "worker",
		modelSetId: "session",
		optionId: "session",
		modelId: "session",
		runtime: {
			mode: "full",
			transport: "tmux",
			tools: {},
			session: "persistent",
			isolation: "host",
		},
		focus: "Execute the assigned deliverable.",
		rationale: "RPC compatibility assignment.",
		inputContracts: [],
		outputContracts: [],
		provenance: {
			source: "session",
			presetId: "worker",
			modelSetId: "session",
			optionId: "session",
			resolvedAt: new Date().toISOString(),
		},
		resolvedAt: new Date().toISOString(),
		source: "session",
	};
}
