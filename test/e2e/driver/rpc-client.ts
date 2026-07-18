// A thin, external RPC client for `pi --mode rpc`. This is the *driver* side of
// the wire: it speaks the documented JSONL protocol (see the pi docs `rpc.md`)
// to a real `pi` subprocess running the maestro extensions. It is deliberately
// standalone — it does NOT import pi's internal client — because the whole point
// of the full-stack e2e is to treat the harness as a black box driven only
// through its public control surface.
//
// Three classes of inbound line (one JSON object per line):
//   • `type: "response"`      — the reply to a command, correlated by `id`.
//   • `type: "extension_ui_request"` — the maestro asking a question; routed to
//                                an `Answerer`, which produces the value we send
//                                back as an `extension_ui_response`.
//   • anything else           — an agent event; recorded and streamed.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type {
	Answerer,
	ConfirmAnswer,
	SelectAnswer,
	TextAnswer,
	UiDialogRequest,
} from "./answerer.js";

type DialogAnswer = SelectAnswer | ConfirmAnswer | TextAnswer;

/** A streamed agent event (everything that isn't a response or a UI request). */
export interface RpcEvent {
	readonly type: string;
	readonly [key: string]: unknown;
}

interface RpcResponse {
	readonly type: "response";
	readonly id?: string;
	readonly command: string;
	readonly success: boolean;
	readonly data?: unknown;
	readonly error?: string;
}

type StreamingBehavior = "steer" | "followUp";

interface Pending {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
	command: string;
}

export interface RpcClientOptions {
	/** Answers `extension_ui_request` dialogs (scripted rules or a live agent). */
	readonly answerer: Answerer;
	/** Optional path to append every inbound line to, for post-hoc debugging. */
	readonly transcriptPath?: string;
	/** Notified for each streamed event (in addition to the recorded buffer). */
	readonly onEvent?: (event: RpcEvent) => void;
}

export class RpcClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly answerer: Answerer;
	private readonly transcriptPath?: string;
	private readonly onEvent?: (event: RpcEvent) => void;
	private readonly decoder = new StringDecoder("utf8");
	private readonly pending = new Map<string, Pending>();
	private readonly recorded: RpcEvent[] = [];
	private seq = 0;
	private buffer = "";
	private closed = false;

	constructor(child: ChildProcessWithoutNullStreams, opts: RpcClientOptions) {
		this.child = child;
		this.answerer = opts.answerer;
		this.transcriptPath = opts.transcriptPath;
		this.onEvent = opts.onEvent;
		this.child.stdout.on("data", (chunk: Buffer) => this.onChunk(chunk));
		this.child.on("exit", () => this.onExit());
	}

	// --- commands -----------------------------------------------------------

	/** Send a prompt. If the agent is streaming, `behavior` is required. */
	prompt(message: string, behavior?: StreamingBehavior): Promise<unknown> {
		return this.send("prompt", {
			message,
			...(behavior ? { streamingBehavior: behavior } : {}),
		});
	}

	steer(message: string): Promise<unknown> {
		return this.send("steer", { message });
	}

	followUp(message: string): Promise<unknown> {
		return this.send("follow_up", { message });
	}

	abort(): Promise<unknown> {
		return this.send("abort", {});
	}

	getState(): Promise<Record<string, unknown>> {
		return this.send("get_state", {}) as Promise<Record<string, unknown>>;
	}

	getMessages(): Promise<{ messages: unknown[] }> {
		return this.send("get_messages", {}) as Promise<{ messages: unknown[] }>;
	}

	/** Low-level: send an arbitrary command and await its correlated response. */
	send(type: string, fields: Record<string, unknown>): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(
				new Error(`rpc client closed; cannot send ${type}`),
			);
		}
		const id = `d-${++this.seq}`;
		const line = `${JSON.stringify({ id, type, ...fields })}\n`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, command: type });
			this.child.stdin.write(line, (err) => {
				if (err) {
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	// --- events -------------------------------------------------------------

	/** All events recorded so far (a stable snapshot copy). */
	events(): RpcEvent[] {
		return [...this.recorded];
	}

	/** Events recorded since `cursor`, plus the next cursor. For polling drivers. */
	eventsSince(cursor: number): { events: RpcEvent[]; cursor: number } {
		const from = Math.max(0, cursor);
		return { events: this.recorded.slice(from), cursor: this.recorded.length };
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.child.stdin.end();
		} catch {
			// stdin may already be gone; nothing to do.
		}
	}

	// --- wire plumbing ------------------------------------------------------

	private onChunk(chunk: Buffer): void {
		// Strict JSONL: accumulate, split on LF only, keep the trailing partial.
		// A generic line reader (node `readline`) is NOT protocol-compliant here
		// because it also splits on U+2028/U+2029, which are valid in JSON strings.
		this.buffer += this.decoder.write(chunk);
		let nl = this.buffer.indexOf("\n");
		while (nl !== -1) {
			const raw = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			// Accept optional CRLF by stripping a lone trailing CR.
			this.onLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
			nl = this.buffer.indexOf("\n");
		}
	}

	private onLine(line: string): void {
		if (line.trim() === "") return;
		if (this.transcriptPath) {
			try {
				appendFileSync(this.transcriptPath, `${line}\n`);
			} catch {
				// Transcript is best-effort; never let it break the run.
			}
		}
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return; // non-JSON stdout noise (e.g. a stray log line) — ignore.
		}
		switch (msg.type) {
			case "response":
				this.onResponse(msg as unknown as RpcResponse);
				return;
			case "extension_ui_request":
				void this.onUiRequest(msg as unknown as UiDialogRequest);
				return;
			default: {
				const event = msg as RpcEvent;
				this.recorded.push(event);
				this.onEvent?.(event);
			}
		}
	}

	private onResponse(res: RpcResponse): void {
		if (!res.id) return; // uncorrelated response; nothing awaiting it.
		const waiter = this.pending.get(res.id);
		if (!waiter) return;
		this.pending.delete(res.id);
		if (res.success) {
			waiter.resolve(res.data);
		} else {
			waiter.reject(
				new Error(`command ${res.command} failed: ${res.error ?? "unknown"}`),
			);
		}
	}

	private async onUiRequest(req: UiDialogRequest): Promise<void> {
		// Fire-and-forget methods emit a request but expect no response; record
		// them as events so a driver can observe notifications/status changes.
		if (
			req.method === "notify" ||
			req.method === "setStatus" ||
			req.method === "setWidget" ||
			req.method === "setTitle" ||
			req.method === "set_editor_text"
		) {
			const event = req as unknown as RpcEvent;
			this.recorded.push(event);
			this.onEvent?.(event);
			return;
		}
		let payload: DialogAnswer;
		try {
			switch (req.method) {
				case "select":
					payload = await this.answerer.select(req);
					break;
				case "confirm":
					payload = await this.answerer.confirm(req);
					break;
				case "input":
					payload = await this.answerer.input(req);
					break;
				case "editor":
					payload = await this.answerer.editor(req);
					break;
				default:
					payload = { cancelled: true };
			}
		} catch {
			payload = { cancelled: true };
		}
		this.writeUiResponse(req.id, payload);
	}

	private writeUiResponse(id: string, payload: DialogAnswer): void {
		if (this.closed) return;
		const line = `${JSON.stringify({ type: "extension_ui_response", id, ...payload })}\n`;
		this.child.stdin.write(line);
	}

	private onExit(): void {
		this.closed = true;
		const err = new Error("pi rpc process exited");
		for (const [, waiter] of this.pending) waiter.reject(err);
		this.pending.clear();
	}
}
