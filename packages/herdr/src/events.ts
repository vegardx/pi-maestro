// Event subscription client for herdr's Unix socket API.
// Maintains a long-lived connection and yields events as they arrive.

import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import type { HerdrEvent, Subscription } from "./types.js";

/**
 * Resolve the herdr socket path.
 * Priority: HERDR_SOCKET_PATH env → default session socket → named session socket.
 */
export function resolveSocketPath(): string | undefined {
	if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;

	const configDir = process.env.XDG_CONFIG_HOME
		? join(process.env.XDG_CONFIG_HOME, "herdr")
		: join(process.env.HOME ?? "", ".config", "herdr");

	// Named session?
	const session = process.env.HERDR_SESSION;
	if (session) {
		const path = join(configDir, "sessions", session, "herdr.sock");
		return existsSync(path) ? path : undefined;
	}

	// Default session.
	const path = join(configDir, "herdr.sock");
	return existsSync(path) ? path : undefined;
}

export interface EventClientOptions {
	readonly socketPath?: string;
	readonly reconnectMs?: number;
}

/**
 * Long-lived event subscription client.
 * Connects to herdr's socket, sends events.subscribe, and yields events.
 */
export class HerdrEventClient {
	private socket: Socket | undefined;
	private buffer = "";
	private closed = false;
	private listeners = new Set<(event: HerdrEvent) => void>();
	private readonly socketPath: string;
	private readonly reconnectMs: number;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private subscriptions: Subscription[] = [];

	constructor(options?: EventClientOptions) {
		const path = options?.socketPath ?? resolveSocketPath();
		if (!path) throw new Error("herdr socket not found");
		this.socketPath = path;
		this.reconnectMs = options?.reconnectMs ?? 2000;
	}

	/**
	 * Subscribe to herdr events. Each event matching the subscriptions
	 * is emitted to all registered listeners.
	 */
	subscribe(subscriptions: Subscription[]): void {
		this.subscriptions = subscriptions;
		this.connect();
	}

	/** Register a listener for events. Returns unsubscribe function. */
	on(listener: (event: HerdrEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Close the connection and stop reconnecting. */
	close(): void {
		this.closed = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.socket?.destroy();
		this.socket = undefined;
		this.listeners.clear();
	}

	private connect(): void {
		if (this.closed) return;

		const socket = createConnection(this.socketPath);
		this.socket = socket;

		socket.on("connect", () => {
			const request = {
				id: `sub_${Date.now()}`,
				method: "events.subscribe",
				params: { subscriptions: this.subscriptions },
			};
			socket.write(`${JSON.stringify(request)}\n`);
		});

		socket.on("data", (chunk) => {
			this.buffer += chunk.toString();
			const lines = this.buffer.split("\n");
			// Keep incomplete last line in buffer.
			this.buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line);
					// Skip the initial subscription ack (has result.type === "subscribed").
					if (parsed.result) continue;
					// Emit events (have a type field at top level or in event wrapper).
					const event = parsed.event ?? parsed;
					if (event.type) {
						for (const listener of this.listeners) {
							listener(event as HerdrEvent);
						}
					}
				} catch {
					// Ignore unparseable lines.
				}
			}
		});

		socket.on("error", () => this.scheduleReconnect());
		socket.on("close", () => this.scheduleReconnect());
	}

	private scheduleReconnect(): void {
		if (this.closed) return;
		this.socket = undefined;
		this.buffer = "";
		this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
	}
}
