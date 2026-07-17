// RPC router: declarative {type → handler} dispatch over MaestroRpcServer.
// Owns the hello token gate, outbound request/response correlation with
// timeouts, and the no-silent-drop rule: every inbound message either hits a
// handler, resolves a pending request, or is answered with an explicit error.

import type {
	AgentMessage,
	ChildRunControlMessage,
	HelloMessage,
	InterruptMessage,
	MaestroMessage,
	MaestroRpcServer,
	PingMessage,
	PrepareStopMessage,
	ResponseFor,
	SummarizeMessage,
} from "@vegardx/pi-rpc";
import { PROTOCOL_VERSION } from "@vegardx/pi-rpc";

/** Agent messages routed through the handler table (hello is router-owned). */
export type RoutedAgentMessage = Exclude<AgentMessage, HelloMessage>;

/**
 * Partial handler table over the routable agent-message union. Each handler
 * receives the sending agent's id alongside the message. Types absent from
 * the table are answered with error{code:"unsupported"} automatically.
 */
export type RpcRouterHandlers = {
	readonly [T in RoutedAgentMessage["type"]]?: (
		agentId: string,
		msg: Extract<RoutedAgentMessage, { type: T }>,
	) => void | Promise<void>;
};

/** Maestro→agent messages that expect a correlated response. */
export type MaestroRequestMessage =
	| SummarizeMessage
	| InterruptMessage
	| ChildRunControlMessage
	| PrepareStopMessage
	| PingMessage;

/** Response `type` expected for each outbound request `type`. */
const RESPONSE_TYPE = {
	summarize: "summary",
	interrupt: "interruptAck",
	childRunControl: "childRunControlResult",
	prepareStop: "prepareStopAck",
	ping: "pong",
} as const satisfies Record<MaestroRequestMessage["type"], string>;

/** Typed rejection for request() timeouts. */
export class RpcRequestTimeoutError extends Error {
	readonly code = "timeout" as const;

	constructor(agentId: string, requestType: string, timeoutMs: number) {
		super(`${requestType} to ${agentId} timed out after ${timeoutMs}ms`);
		this.name = "RpcRequestTimeoutError";
	}
}

/** Typed rejection for requests that cannot complete (disconnect, no agent). */
export class RpcRequestCancelledError extends Error {
	readonly code = "cancelled" as const;

	constructor(agentId: string, requestType: string, reason: string) {
		super(`${requestType} to ${agentId} cancelled: ${reason}`);
		this.name = "RpcRequestCancelledError";
	}
}

export interface RpcRouterOptions {
	server: MaestroRpcServer;
	/** Run token; hellos carrying a different token are rejected. */
	token: string;
	handlers: RpcRouterHandlers;
	/** Observability hook for messages answered with error{unsupported}. */
	onUnhandled?: (agentId: string, msg: RoutedAgentMessage) => void;
	/** Called when an agent passes the hello gate. */
	onConnect?: (agentId: string, hello: HelloMessage) => void;
	onDisconnect?: (agentId: string) => void;
}

export interface RpcRouter {
	/**
	 * Send a request and await the correlated response (matched by id and
	 * expected type). Rejects with RpcRequestTimeoutError after timeoutMs, or
	 * RpcRequestCancelledError if the agent is absent or disconnects.
	 */
	request<T extends MaestroRequestMessage>(
		agentId: string,
		msg: T,
		timeoutMs: number,
	): Promise<ResponseFor<T>>;
	/** Fire-and-forget passthrough; false if the agent is not connected. */
	send(agentId: string, msg: MaestroMessage): boolean;
	/** Whether an agent's hello was rejected by the gate. */
	isRejected(agentId: string): boolean;
	/** Detach from the server and cancel all pending requests. */
	dispose(): void;
}

interface PendingRequest {
	readonly agentId: string;
	readonly responseType: string;
	readonly timer: ReturnType<typeof setTimeout>;
	resolve(msg: AgentMessage): void;
	reject(err: Error): void;
}

export function createRpcRouter(opts: RpcRouterOptions): RpcRouter {
	const { server, token, handlers } = opts;
	const rejected = new Set<string>();
	const pending = new Map<string, PendingRequest>(); // "agentId\nid" → request

	const pendingKey = (agentId: string, id: string) => `${agentId}\n${id}`;

	const sendError = (
		agentId: string,
		id: string | undefined,
		code: "unsupported" | "cancelled" | "internal",
		message: string,
	) => {
		server.send(agentId, {
			type: "error",
			...(id ? { id } : {}),
			code,
			message,
		});
	};

	const messageId = (msg: AgentMessage): string | undefined =>
		"id" in msg && typeof msg.id === "string" ? msg.id : undefined;

	const onConnected = (agentId: string, hello: HelloMessage) => {
		if (hello.v !== PROTOCOL_VERSION) {
			rejected.add(agentId);
			server.send(agentId, {
				type: "helloAck",
				id: hello.id,
				ok: false,
				error: `protocol version mismatch: got ${hello.v}, want ${PROTOCOL_VERSION}`,
			});
			return;
		}
		if (hello.token !== token) {
			rejected.add(agentId);
			server.send(agentId, {
				type: "helloAck",
				id: hello.id,
				ok: false,
				error: "token mismatch",
			});
			return;
		}
		rejected.delete(agentId);
		server.send(agentId, { type: "helloAck", id: hello.id, ok: true });
		opts.onConnect?.(agentId, hello);
	};

	const onMessage = (agentId: string, msg: AgentMessage) => {
		const id = messageId(msg);

		if (rejected.has(agentId)) {
			sendError(agentId, id, "cancelled", "connection rejected at hello");
			return;
		}

		// Correlate responses to outbound requests before table dispatch.
		if (id) {
			const key = pendingKey(agentId, id);
			const req = pending.get(key);
			if (req && req.responseType === msg.type) {
				pending.delete(key);
				clearTimeout(req.timer);
				req.resolve(msg);
				return;
			}
		}

		// Hello is intercepted by the server (emitted as `connected`); anything
		// arriving here is a routable type.
		const routed = msg as RoutedAgentMessage;
		const handler = handlers[routed.type] as
			| ((agentId: string, msg: RoutedAgentMessage) => void | Promise<void>)
			| undefined;
		if (!handler) {
			opts.onUnhandled?.(agentId, routed);
			sendError(agentId, id, "unsupported", `no handler for "${routed.type}"`);
			return;
		}

		try {
			const result = handler(agentId, routed);
			if (result instanceof Promise) {
				result.catch((err) => {
					sendError(agentId, id, "internal", errorText(err));
				});
			}
		} catch (err) {
			sendError(agentId, id, "internal", errorText(err));
		}
	};

	const onDisconnected = (agentId: string) => {
		rejected.delete(agentId);
		for (const [key, req] of pending) {
			if (req.agentId !== agentId) continue;
			pending.delete(key);
			clearTimeout(req.timer);
			req.reject(
				new RpcRequestCancelledError(agentId, req.responseType, "disconnected"),
			);
		}
		opts.onDisconnect?.(agentId);
	};

	server.on("connected", onConnected);
	server.on("message", onMessage);
	server.on("disconnected", onDisconnected);

	return {
		request<T extends MaestroRequestMessage>(
			agentId: string,
			msg: T,
			timeoutMs: number,
		): Promise<ResponseFor<T>> {
			return new Promise((resolve, reject) => {
				const key = pendingKey(agentId, msg.id);
				const timer = setTimeout(() => {
					pending.delete(key);
					reject(new RpcRequestTimeoutError(agentId, msg.type, timeoutMs));
				}, timeoutMs);
				pending.set(key, {
					agentId,
					responseType: RESPONSE_TYPE[msg.type],
					timer,
					resolve: (response) => resolve(response as ResponseFor<T>),
					reject,
				});
				if (!server.send(agentId, msg)) {
					pending.delete(key);
					clearTimeout(timer);
					reject(
						new RpcRequestCancelledError(agentId, msg.type, "not connected"),
					);
				}
			});
		},

		send(agentId: string, msg: MaestroMessage): boolean {
			return server.send(agentId, msg);
		},

		isRejected(agentId: string): boolean {
			return rejected.has(agentId);
		},

		dispose(): void {
			server.off("connected", onConnected);
			server.off("message", onMessage);
			server.off("disconnected", onDisconnected);
			for (const [key, req] of pending) {
				pending.delete(key);
				clearTimeout(req.timer);
				req.reject(
					new RpcRequestCancelledError(
						req.agentId,
						req.responseType,
						"router disposed",
					),
				);
			}
		},
	};
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
