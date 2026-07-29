// A scripted model for the rebuilt maestro's vocabulary.
//
// It speaks Anthropic Messages SSE and drives real `pi` sessions with no API
// key and no cassette, keyed on STRUCTURE rather than prompt wording: which
// tools a session holds tells you what it is. A session holding `finish`
// reports to a maestro, so it is a worker. A session holding `flight` is the
// seat. Nothing here matches on phrasing, so rewording a persona cannot
// silently change what the drive tests.
//
// The worker's turns are a state machine over how many tool-use turns have
// already happened, because pi runs a turn's tool calls concurrently — writing
// and committing in one turn would race.

import { createServer, type Server } from "node:http";

export interface RunningModel {
	readonly url: string;
	readonly calls: () => number;
	close(): Promise<void>;
}

interface ToolCall {
	readonly name: string;
	readonly input: Record<string, unknown>;
}

const BUILT_FILE = "built.txt";

function textOf(system: unknown, messages: unknown[]): string {
	const parts: string[] = [];
	const walk = (value: unknown): void => {
		if (typeof value === "string") parts.push(value);
		else if (Array.isArray(value)) for (const item of value) walk(item);
		else if (value && typeof value === "object")
			for (const item of Object.values(value)) walk(item);
	};
	walk(system);
	walk(messages);
	return parts.join("\n");
}

/** How many assistant turns already used a tool. */
function toolTurns(messages: unknown[]): number {
	let count = 0;
	for (const message of messages as { role?: string; content?: unknown }[]) {
		if (message.role !== "assistant") continue;
		const content = Array.isArray(message.content) ? message.content : [];
		if (content.some((c) => (c as { type?: string }).type === "tool_use"))
			count += 1;
	}
	return count;
}

/** The deliverable this session was briefed on, from its assignment heading. */
function deliverableOf(text: string): string {
	return text.match(/# Deliverable ([a-z0-9-]+)/)?.[1] ?? "unknown";
}

function decide(
	tools: Set<string>,
	system: unknown,
	messages: unknown[],
): { text?: string; toolCalls?: ToolCall[] } {
	const text = textOf(system, messages);

	// A worker: it holds the tool for reporting to a maestro.
	if (tools.has("finish")) {
		const id = deliverableOf(text);
		switch (toolTurns(messages)) {
			case 0:
				return {
					toolCalls: [
						{
							name: "write",
							input: { path: BUILT_FILE, content: `${id} was built here\n` },
						},
					],
				};
			case 1:
				// No commit tool exists in this vocabulary, so committing is
				// ordinary shell work — which is also what the worker persona
				// tells it to do.
				return {
					toolCalls: [
						{
							name: "bash",
							input: {
								command: `git add ${BUILT_FILE} && git commit -q -m "build ${id}"`,
							},
						},
					],
				};
			default: {
				// Echo back what the brief said this deliverable inherits. The
				// drive asserts on it, which is how "reads carries a hand-off to
				// the next worker" gets proved from the worker's own side rather
				// than from the maestro that sent it.
				const inherited = text.match(/### From `([a-z0-9-]+)`/)?.[1];
				return {
					toolCalls: [
						{
							name: "finish",
							input: {
								outcome: "succeeded",
								handoff: inherited
									? `${id} wrote ${BUILT_FILE}, having inherited from ${inherited}.`
									: `${id} wrote ${BUILT_FILE}; it exports nothing yet.`,
							},
						},
					],
				};
			}
		}
	}

	// The seat, answering a plan preflight or postflight it was handed.
	if (tools.has("flight"))
		return { toolCalls: [{ name: "flight", input: { outcome: "done" } }] };

	// A read-only agent.
	return { text: "Nothing worth changing that I can demonstrate." };
}

function sse(chunks: string[]): string {
	return chunks.join("");
}

function event(type: string, data: unknown): string {
	return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Render one decision as valid Anthropic streaming SSE.
 *
 * Tool arguments ride an `input_json_delta`: `content_block_stop` re-parses the
 * accumulated partial JSON, so arguments placed only in `content_block_start`
 * are discarded.
 */
function render(decision: { text?: string; toolCalls?: ToolCall[] }): string {
	const chunks = [
		event("message_start", {
			type: "message_start",
			message: {
				id: "msg_mock",
				type: "message",
				role: "assistant",
				model: "mock",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 10 },
			},
		}),
	];

	let index = 0;
	if (decision.text) {
		chunks.push(
			event("content_block_start", {
				type: "content_block_start",
				index,
				content_block: { type: "text", text: "" },
			}),
			event("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "text_delta", text: decision.text },
			}),
			event("content_block_stop", { type: "content_block_stop", index }),
		);
		index += 1;
	}

	for (const call of decision.toolCalls ?? []) {
		chunks.push(
			event("content_block_start", {
				type: "content_block_start",
				index,
				content_block: {
					type: "tool_use",
					id: `toolu_${index}`,
					name: call.name,
					input: {},
				},
			}),
			event("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: {
					type: "input_json_delta",
					partial_json: JSON.stringify(call.input),
				},
			}),
			event("content_block_stop", { type: "content_block_stop", index }),
		);
		index += 1;
	}

	chunks.push(
		event("message_delta", {
			type: "message_delta",
			delta: {
				stop_reason: decision.toolCalls?.length ? "tool_use" : "end_turn",
			},
			usage: { output_tokens: 10 },
		}),
		event("message_stop", { type: "message_stop" }),
	);
	return sse(chunks);
}

export async function startScriptedModel(): Promise<RunningModel> {
	let calls = 0;
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			calls += 1;
			let parsed: {
				system?: unknown;
				messages?: unknown[];
				tools?: { name: string }[];
			} = {};
			try {
				parsed = JSON.parse(body);
			} catch {
				// An unparseable body is a bug in the harness, not a model turn.
			}
			const tools = new Set((parsed.tools ?? []).map((t) => t.name));
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			res.end(render(decide(tools, parsed.system, parsed.messages ?? [])));
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		url: `http://127.0.0.1:${port}`,
		calls: () => calls,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}
