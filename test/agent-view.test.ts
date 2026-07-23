// The live agent-view building blocks: rendering session transcript entries to
// display lines, and tailing a JSONL session file (the headless replacement for
// a tmux pane). The TUI component itself is exercised live; these lock the pure
// data path.

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	renderSessionEntry,
	SessionTail,
} from "../packages/modes/src/runtime/agent-view.js";

const plain = { width: 200, dim: (t: string) => t };

describe("renderSessionEntry", () => {
	it("renders assistant text, thinking, tool calls and results", () => {
		const lines = renderSessionEntry(
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "reasoning here\nmore" },
						{ type: "text", text: "Creating src/stats.ts." },
						{
							type: "toolCall",
							name: "write",
							arguments: { path: "src/stats.ts" },
						},
					],
				},
			},
			plain,
		);
		expect(lines).toContain("· reasoning here");
		expect(lines).toContain("Creating src/stats.ts.");
		expect(
			lines.some(
				(l) => l.includes("→ write") && l.includes("path=src/stats.ts"),
			),
		).toBe(true);
	});

	it("renders a tool result as a ← line", () => {
		const lines = renderSessionEntry(
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [
						{
							type: "tool_result",
							content: [{ type: "text", text: "2 passing\nok" }],
						},
					],
				},
			},
			plain,
		);
		expect(lines.some((l) => l.includes("← 2 passing"))).toBe(true);
	});

	it("renders the kickoff/custom_message as a » task line", () => {
		const lines = renderSessionEntry(
			{ type: "custom_message", content: "Implement the stats module." },
			plain,
		);
		expect(lines[0]).toBe("» Implement the stats module.");
	});

	it("ignores non-message meta entries", () => {
		expect(renderSessionEntry({ type: "model_change" }, plain)).toEqual([]);
		expect(renderSessionEntry({ type: "session" }, plain)).toEqual([]);
	});
});

describe("SessionTail", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-view-"));
		file = join(dir, "s.jsonl");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const entry = (text: string) =>
		`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
	const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

	it("delivers existing entries on start, then newly-appended ones", async () => {
		writeFileSync(file, entry("first"));
		const got: unknown[] = [];
		const tail = new SessionTail(file, (es) => got.push(...es), 10);
		tail.start(); // synchronous initial poll
		expect(got).toHaveLength(1);

		appendFileSync(file, entry("second"));
		await settle(40);
		expect(got).toHaveLength(2);
		tail.stop();
	});

	it("carries a torn (partial) line until it completes", async () => {
		writeFileSync(file, entry("whole"));
		const got: unknown[] = [];
		const tail = new SessionTail(file, (es) => got.push(...es), 10);
		tail.start();
		expect(got).toHaveLength(1);

		// A partial JSON line (mid-write) must not be delivered yet.
		const partial = entry("partial");
		appendFileSync(file, partial.slice(0, 20));
		await settle(30);
		expect(got).toHaveLength(1);

		// Completing the line delivers it.
		appendFileSync(file, partial.slice(20));
		await settle(30);
		expect(got).toHaveLength(2);
		tail.stop();
	});

	it("no-ops on a missing file until it appears", async () => {
		const got: unknown[] = [];
		const tail = new SessionTail(file, (es) => got.push(...es), 10);
		tail.start(); // file does not exist yet
		expect(got).toHaveLength(0);
		writeFileSync(file, entry("late"));
		await settle(30);
		expect(got).toHaveLength(1);
		tail.stop();
	});
});
