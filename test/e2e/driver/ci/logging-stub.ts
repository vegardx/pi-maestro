// A logging stub model server for Phase 0 enumeration. Speaks just enough of the
// Anthropic Messages API to (a) LOG every request the drive makes — which actor
// (fingerprinted from the system prompt), which resolved model, which tools —
// and (b) return a minimal valid SSE text turn so the drive keeps progressing
// and more actors get to make their first call.
//
// It is NOT a driving mock (it never emits tool calls, so workers do no work).
// Its only job is to enumerate the model-call catalog the scripted mock (Phase
// 1) must answer. Point the CI profile's mock provider baseUrl here.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

export interface LoggingStubOptions {
	/** JSONL file to append one record per model request. */
	readonly logPath: string;
	/** If set, each raw request body is written to `<bodyDir>/<seq>.json`. */
	readonly bodyDir?: string;
}

export interface RunningLoggingStub {
	readonly url: string;
	readonly port: number;
	/** Requests seen so far (also written to logPath). */
	readonly records: RequestRecord[];
	close(): Promise<void>;
}

export interface RequestRecord {
	readonly seq: number;
	/** The resolved model id the client asked for — tells us role→model routing. */
	readonly model: string;
	/** First slice of the system prompt: the actor fingerprint. */
	readonly systemHead: string;
	readonly systemLen: number;
	/** Tool names offered on the request, sorted. */
	readonly tools: string[];
	readonly messageCount: number;
	readonly lastRole: string;
	readonly lastHead: string;
	readonly path: string;
}

/** Anthropic `system` is a string or an array of text blocks. Flatten to text. */
function systemText(system: unknown): string {
	if (typeof system === "string") return system;
	if (Array.isArray(system))
		return system
			.map((b) =>
				b && typeof b === "object" && "text" in b ? String(b.text) : "",
			)
			.join("\n");
	return "";
}

/** A message's content is a string or an array of blocks; take a readable head. */
function messageHead(message: unknown): { role: string; head: string } {
	if (!message || typeof message !== "object") return { role: "?", head: "" };
	const m = message as { role?: string; content?: unknown };
	let head = "";
	if (typeof m.content === "string") head = m.content;
	else if (Array.isArray(m.content)) {
		const first = m.content.find(
			(b) => b && typeof b === "object" && ("text" in b || "content" in b),
		) as { text?: string; content?: unknown } | undefined;
		head =
			typeof first?.text === "string"
				? first.text
				: typeof first?.content === "string"
					? first.content
					: JSON.stringify(m.content).slice(0, 200);
	}
	return { role: m.role ?? "?", head: head.slice(0, 200) };
}

const SSE_TEXT_TURN = (model: string): string =>
	[
		`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}`,
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
		`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
		"",
		"",
	].join("\n\n");

export function startLoggingStub(
	opts: LoggingStubOptions,
): Promise<RunningLoggingStub> {
	const records: RequestRecord[] = [];
	let seq = 0;
	if (opts.bodyDir) mkdirSync(opts.bodyDir, { recursive: true });
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const thisSeq = seq;
			if (opts.bodyDir) {
				try {
					writeFileSync(join(opts.bodyDir, `${thisSeq}.json`), body);
				} catch {
					// best-effort
				}
			}
			let model = "?";
			let record: RequestRecord | undefined;
			try {
				const parsed = JSON.parse(body.toString("utf8")) as {
					model?: string;
					system?: unknown;
					messages?: unknown[];
					tools?: { name?: string }[];
				};
				model = parsed.model ?? "?";
				const sys = systemText(parsed.system);
				const messages = parsed.messages ?? [];
				const last = messageHead(messages[messages.length - 1]);
				record = {
					seq: seq++,
					model,
					systemHead: sys.slice(0, 300),
					systemLen: sys.length,
					tools: (parsed.tools ?? []).map((t) => t.name ?? "?").sort(),
					messageCount: messages.length,
					lastRole: last.role,
					lastHead: last.head,
					path: req.url ?? "/",
				};
			} catch {
				record = {
					seq: seq++,
					model,
					systemHead: "(unparseable body)",
					systemLen: 0,
					tools: [],
					messageCount: 0,
					lastRole: "?",
					lastHead: body.toString("utf8").slice(0, 120),
					path: req.url ?? "/",
				};
			}
			records.push(record);
			try {
				appendFileSync(opts.logPath, `${JSON.stringify(record)}\n`);
			} catch {
				// best-effort
			}
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			res.end(SSE_TEXT_TURN(model));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({
				url: `http://127.0.0.1:${port}`,
				port,
				records,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}
