// The scripted driving mock (Phase 1). An HTTP server speaking Anthropic
// Messages SSE that DRIVES real pi sessions deterministically: per request it
// classifies the actor (from tools + the seed) and emits the tool-call turns
// that advance the lifecycle — no API key, no cassette, robust to prompt wording
// because it keys on structure (tool set, deliverable id, taskIds in the seed),
// not a request-body hash.
//
// Actors:
//   • plan-review reviewer (read-only) → a trivial pass (the gate clears on the
//     ruling regardless).
//   • worker (has write/commit) → write the deliverable's files, commit, toggle
//     every task (postflight last, with a summary), then idle.
//   • other read-only reviewer (security-audit) → a benign no-blocking report.
//
// It emits VALID Anthropic streaming SSE: tool_use args ride an input_json_delta
// (content_block_stop re-parses partialJson, so args in content_block_start
// alone are discarded — see pi-ai/dist/api/anthropic-messages.js).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

export interface ScriptedModelOptions {
	readonly logPath?: string;
	/** If set, each raw request body is written to `<bodyDir>/<seq>.json`. */
	readonly bodyDir?: string;
}

export interface RunningScriptedModel {
	readonly url: string;
	readonly port: number;
	readonly seq: () => number;
	close(): Promise<void>;
}

interface ToolCall {
	readonly name: string;
	readonly input: Record<string, unknown>;
}

// ─── deliverable file contents (keyed on the src file named in the seed) ──────

interface Deliverable {
	readonly id: string;
	readonly src: string;
	readonly srcBody: string;
	readonly test: string;
	readonly testBody: string;
	readonly commit: string;
}

const DELIVERABLES: readonly Deliverable[] = [
	{
		id: "add-statistics-module",
		src: "src/stats.ts",
		srcBody: `export function mean(numbers: number[]): number {
	if (numbers.length === 0) throw new Error("mean: empty input");
	return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

export function median(numbers: number[]): number {
	if (numbers.length === 0) throw new Error("median: empty input");
	const sorted = [...numbers].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}
`,
		test: "tests/stats.test.ts",
		testBody: `import { test } from "node:test";
import assert from "node:assert/strict";
import { mean, median } from "../src/stats.ts";

test("mean averages", () => assert.equal(mean([1, 2, 3]), 2));
test("mean throws on empty", () => assert.throws(() => mean([])));
test("median odd", () => assert.equal(median([3, 1, 2]), 2));
test("median even", () => assert.equal(median([1, 2, 3, 4]), 2.5));
`,
		commit: "feat(stats): add mean and median",
	},
	{
		id: "add-validation-utilities",
		src: "src/validate.ts",
		srcBody: `export function isPositive(n: number): boolean {
	return Number.isFinite(n) && n > 0;
}

export function assertInRange(n: number, min: number, max: number): void {
	if (!Number.isFinite(n) || n < min || n > max) {
		throw new RangeError(\`value \${n} is out of range [\${min}, \${max}]\`);
	}
}
`,
		test: "tests/validate.test.ts",
		testBody: `import { test } from "node:test";
import assert from "node:assert/strict";
import { isPositive, assertInRange } from "../src/validate.ts";

test("isPositive", () => {
	assert.equal(isPositive(1), true);
	assert.equal(isPositive(0), false);
	assert.equal(isPositive(Number.NaN), false);
});
test("assertInRange throws out of range", () =>
	assert.throws(() => assertInRange(5, 0, 3), RangeError));
test("assertInRange ok in range", () =>
	assert.doesNotThrow(() => assertInRange(2, 0, 3)));
`,
		commit: "feat(validate): add isPositive and assertInRange",
	},
	{
		id: "add-advanced-math",
		src: "src/advanced.ts",
		srcBody: `import { mean } from "./stats.ts";
import { assertInRange } from "./validate.ts";

export function standardDeviation(numbers: number[]): number {
	if (numbers.length === 0) throw new Error("standardDeviation: empty input");
	const m = mean(numbers);
	return Math.sqrt(mean(numbers.map((n) => (n - m) ** 2)));
}

export function clampToRange(value: number, min: number, max: number): number {
	const clamped = Math.min(Math.max(value, min), max);
	assertInRange(clamped, min, max);
	return clamped;
}
`,
		test: "tests/advanced.test.ts",
		testBody: `import { test } from "node:test";
import assert from "node:assert/strict";
import { standardDeviation, clampToRange } from "../src/advanced.ts";

test("standardDeviation", () =>
	assert.equal(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]), 2));
test("clampToRange", () => {
	assert.equal(clampToRange(5, 0, 3), 3);
	assert.equal(clampToRange(2, 0, 3), 2);
});
`,
		commit: "feat(advanced): add standardDeviation and clampToRange",
	},
];

// ─── request parsing ──────────────────────────────────────────────────────────

function flatten(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.map((b) =>
				b && typeof b === "object" && "text" in b ? String(b.text) : "",
			)
			.join("\n");
	return "";
}

function allText(system: unknown, messages: unknown[]): string {
	const sys = Array.isArray(system) ? flatten(system) : String(system ?? "");
	const msgs = messages
		.map((m) =>
			m && typeof m === "object"
				? flatten((m as { content?: unknown }).content)
				: "",
		)
		.join("\n");
	return `${sys}\n${msgs}`;
}

function assistantToolTurns(messages: unknown[]): number {
	return messages.filter(
		(m) =>
			m &&
			typeof m === "object" &&
			(m as { role?: string }).role === "assistant" &&
			Array.isArray((m as { content?: unknown }).content) &&
			((m as { content: unknown[] }).content as unknown[]).some(
				(b) =>
					b &&
					typeof b === "object" &&
					(b as { type?: string }).type === "tool_use",
			),
	).length;
}

/** The worker's cwd ends in its deliverable id; the seed lists its taskIds. */
function deliverableId(text: string): string | undefined {
	const m = text.match(/Current working directory:.*?\/([^/\n]+)\s*$/m);
	return m?.[1];
}

function taskIds(text: string): string[] {
	const ids: string[] = [];
	const re = /taskId:\s*`([^`]+)`/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
	while ((m = re.exec(text)) !== null) ids.push(m[1]);
	return ids;
}

function deliverableFor(id: string): Deliverable | undefined {
	return DELIVERABLES.find((d) => d.id === id);
}

// ─── the decision ──────────────────────────────────────────────────────────────

function decide(
	tools: Set<string>,
	system: unknown,
	messages: unknown[],
): { text?: string; toolCalls?: ToolCall[] } {
	const text = allText(system, messages);
	const isWriter = tools.has("write") || tools.has("commit");

	if (isWriter) {
		// Worker. pi runs a turn's tool calls concurrently, so write→commit must
		// span turns (else commit races ahead of the file). Drive it as a state
		// machine keyed on how many tool-use turns already happened:
		//   0 → write the files;  1 → commit + toggle every task;  2+ → idle.
		const turns = assistantToolTurns(messages);
		if (turns >= 2) return { text: "All tasks complete; worktree clean." };
		const id = deliverableId(text) ?? "";
		const deliverable = deliverableFor(id);
		if (!deliverable || !id) return { text: "ok" };
		if (turns === 0)
			return {
				toolCalls: [
					{
						name: "write",
						input: { path: deliverable.src, content: deliverable.srcBody },
					},
					{
						name: "write",
						input: { path: deliverable.test, content: deliverable.testBody },
					},
				],
			};
		// turns === 1: files exist now; commit them and toggle the tasks.
		const calls: ToolCall[] = [
			{
				name: "commit",
				input: {
					message: deliverable.commit,
					paths: [deliverable.src, deliverable.test],
				},
			},
		];
		for (const taskId of taskIds(text)) {
			const call: ToolCall = {
				name: "task",
				input: { action: "toggle", deliverableId: id, taskId },
			};
			if (taskId === "lifecycle-postflight")
				call.input.summary = `Implemented ${deliverable.src} and ${deliverable.test}; committed. Public exports are stable and covered by tests.`;
			calls.push(call);
		}
		return { toolCalls: calls };
	}

	// Read-only actors: the plan-review gate and node reviewers (security-audit).
	if (/canonical structured plan/i.test(text))
		return {
			text: "The plan is coherent: deliverables, sequencing, and review coverage look sound. No blocking gaps.",
		};
	return {
		text: "Reviewed the diff. Checked NaN/Infinity edge paths and input validation; no blocking findings.",
	};
}

// ─── Anthropic SSE emission ─────────────────────────────────────────────────────

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function render(
	model: string,
	decision: { text?: string; toolCalls?: ToolCall[] },
): string {
	const parts: string[] = [];
	parts.push(
		sse("message_start", {
			type: "message_start",
			message: {
				id: "msg_mock",
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		}),
	);
	if (decision.toolCalls?.length) {
		decision.toolCalls.forEach((call, i) => {
			parts.push(
				sse("content_block_start", {
					type: "content_block_start",
					index: i,
					content_block: {
						type: "tool_use",
						id: `toolu_${i}`,
						name: call.name,
						input: {},
					},
				}),
			);
			parts.push(
				sse("content_block_delta", {
					type: "content_block_delta",
					index: i,
					delta: {
						type: "input_json_delta",
						partial_json: JSON.stringify(call.input),
					},
				}),
			);
			parts.push(
				sse("content_block_stop", { type: "content_block_stop", index: i }),
			);
		});
		parts.push(
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 1 },
			}),
		);
	} else {
		const text = decision.text ?? "ok";
		parts.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		);
		parts.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			}),
		);
		parts.push(
			sse("content_block_stop", { type: "content_block_stop", index: 0 }),
		);
		parts.push(
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			}),
		);
	}
	parts.push(sse("message_stop", { type: "message_stop" }));
	return parts.join("");
}

export function startScriptedModel(
	opts: ScriptedModelOptions = {},
): Promise<RunningScriptedModel> {
	let seq = 0;
	if (opts.bodyDir) mkdirSync(opts.bodyDir, { recursive: true });
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const thisSeq = seq++;
			if (opts.bodyDir) {
				try {
					writeFileSync(join(opts.bodyDir, `${thisSeq}.json`), body);
				} catch {
					// best-effort
				}
			}
			let model = "mock-1";
			let decision: { text?: string; toolCalls?: ToolCall[] } = { text: "ok" };
			try {
				const parsed = JSON.parse(body.toString("utf8")) as {
					model?: string;
					system?: unknown;
					messages?: unknown[];
					tools?: { name?: string }[];
				};
				model = parsed.model ?? "mock-1";
				const tools = new Set((parsed.tools ?? []).map((t) => t.name ?? ""));
				decision = decide(tools, parsed.system, parsed.messages ?? []);
			} catch {
				// fall through with the default text turn
			}
			if (opts.logPath) {
				try {
					appendFileSync(
						opts.logPath,
						`${JSON.stringify({ seq: thisSeq, model, kind: decision.toolCalls ? decision.toolCalls.map((c) => c.name).join("+") : "text" })}\n`,
					);
				} catch {
					// best-effort
				}
			}
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			res.end(render(model, decision));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({
				url: `http://127.0.0.1:${port}`,
				port,
				seq: () => seq,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}
