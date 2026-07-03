import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendToSession,
	buildCustomEntry,
	buildCustomMessageEntry,
	forkSessionAt,
	parseSessionFile,
	pathToEntry,
} from "../packages/modes/src/session-fork.js";

function makeSession(
	entries: Array<{ id: string; parentId: string | null; [k: string]: unknown }>,
	cwd = "/repo",
): string {
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: "sess-001",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd,
	});
	const lines = [
		header,
		...entries.map((e) =>
			JSON.stringify({
				type: "message",
				timestamp: "2026-01-01T00:00:01.000Z",
				...e,
			}),
		),
	];
	return `${lines.join("\n")}\n`;
}

describe("session-fork primitives", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "session-fork-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	describe("parseSessionFile", () => {
		it("parses a valid multi-line session", () => {
			const file = join(root, "test.jsonl");
			writeFileSync(
				file,
				makeSession([
					{ id: "a", parentId: null, message: { role: "user", text: "hi" } },
					{
						id: "b",
						parentId: "a",
						message: { role: "assistant", text: "hello" },
					},
				]),
			);
			const { header, entries } = parseSessionFile(file);
			expect(header.type).toBe("session");
			expect(header.id).toBe("sess-001");
			expect(header.cwd).toBe("/repo");
			expect(entries).toHaveLength(2);
			expect(entries[0].id).toBe("a");
			expect(entries[1].id).toBe("b");
		});

		it("skips empty lines and malformed JSON", () => {
			const file = join(root, "messy.jsonl");
			const content = [
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s1",
					timestamp: "t",
					cwd: "/x",
				}),
				"",
				"not valid json {{{",
				JSON.stringify({
					type: "message",
					id: "a",
					parentId: null,
					timestamp: "t",
					message: {},
				}),
				"",
			].join("\n");
			writeFileSync(file, content);
			const { header, entries } = parseSessionFile(file);
			expect(header.id).toBe("s1");
			expect(entries).toHaveLength(1);
			expect(entries[0].id).toBe("a");
		});

		it("throws on empty file", () => {
			const file = join(root, "empty.jsonl");
			writeFileSync(file, "");
			expect(() => parseSessionFile(file)).toThrow("Empty session file");
		});

		it("throws if first line is not type session", () => {
			const file = join(root, "bad.jsonl");
			writeFileSync(file, `${JSON.stringify({ type: "message", id: "x" })}\n`);
			expect(() => parseSessionFile(file)).toThrow("first line must be type");
		});
	});

	describe("pathToEntry", () => {
		it("returns linear path to target", () => {
			const entries = [
				{ type: "message", id: "a", parentId: null, timestamp: "t" },
				{ type: "message", id: "b", parentId: "a", timestamp: "t" },
				{ type: "message", id: "c", parentId: "b", timestamp: "t" },
			] as any[];
			const path = pathToEntry(entries, "c");
			expect(path.map((e) => e.id)).toEqual(["a", "b", "c"]);
		});

		it("returns single entry when target has no parent", () => {
			const entries = [
				{ type: "message", id: "root", parentId: null, timestamp: "t" },
			] as any[];
			const path = pathToEntry(entries, "root");
			expect(path).toHaveLength(1);
			expect(path[0].id).toBe("root");
		});

		it("handles tree (skips sibling branches)", () => {
			const entries = [
				{ type: "message", id: "a", parentId: null, timestamp: "t" },
				{ type: "message", id: "b1", parentId: "a", timestamp: "t" },
				{ type: "message", id: "b2", parentId: "a", timestamp: "t" },
				{ type: "message", id: "c", parentId: "b2", timestamp: "t" },
			] as any[];
			const path = pathToEntry(entries, "c");
			expect(path.map((e) => e.id)).toEqual(["a", "b2", "c"]);
		});

		it("throws if target not found", () => {
			const entries = [
				{ type: "message", id: "a", parentId: null, timestamp: "t" },
			] as any[];
			expect(() => pathToEntry(entries, "nonexistent")).toThrow(
				"Entry not found",
			);
		});
	});

	describe("forkSessionAt", () => {
		it("creates a forked session file with path to target", () => {
			const source = join(root, "source.jsonl");
			writeFileSync(
				source,
				makeSession([
					{ id: "a", parentId: null },
					{ id: "b", parentId: "a" },
					{ id: "c", parentId: "b" },
				]),
			);

			const outDir = join(root, "forks");
			const forked = forkSessionAt(source, "b", outDir);

			expect(forked).toContain("fork_");
			expect(forked).toContain(outDir);

			const { header, entries } = parseSessionFile(forked);
			expect(header.parentSession).toBe("sess-001");
			expect(header.cwd).toBe("/repo");
			expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
		});

		it("overrides cwd when specified", () => {
			const source = join(root, "source.jsonl");
			writeFileSync(source, makeSession([{ id: "a", parentId: null }]));

			const outDir = join(root, "forks");
			const forked = forkSessionAt(source, "a", outDir, { cwd: "/new/path" });

			const { header } = parseSessionFile(forked);
			expect(header.cwd).toBe("/new/path");
		});

		it("uses custom id when specified", () => {
			const source = join(root, "source.jsonl");
			writeFileSync(source, makeSession([{ id: "a", parentId: null }]));

			const outDir = join(root, "forks");
			const forked = forkSessionAt(source, "a", outDir, { id: "custom-id" });

			const { header } = parseSessionFile(forked);
			expect(header.id).toBe("custom-id");
		});
	});

	describe("appendToSession", () => {
		it("appends entries without corrupting existing content", () => {
			const file = join(root, "append.jsonl");
			writeFileSync(file, makeSession([{ id: "a", parentId: null }]));

			const entry = buildCustomEntry("test.type", { key: "value" }, "a");
			appendToSession(file, [entry]);

			const { entries } = parseSessionFile(file);
			expect(entries).toHaveLength(2);
			expect(entries[0].id).toBe("a");
			expect(entries[1].type).toBe("custom");
			expect((entries[1] as any).customType).toBe("test.type");
			expect((entries[1] as any).data).toEqual({ key: "value" });
		});

		it("appends multiple entries", () => {
			const file = join(root, "multi.jsonl");
			writeFileSync(file, makeSession([{ id: "a", parentId: null }]));

			const e1 = buildCustomEntry("t1", null, "a");
			const e2 = buildCustomMessageEntry("t2", "hello context", e1.id);
			appendToSession(file, [e1, e2]);

			const { entries } = parseSessionFile(file);
			expect(entries).toHaveLength(3);
			expect((entries[2] as any).content).toBe("hello context");
		});
	});

	describe("buildCustomEntry", () => {
		it("produces a valid custom entry", () => {
			const entry = buildCustomEntry("my.type", { x: 1 }, "parent-1");
			expect(entry.type).toBe("custom");
			expect(entry.customType).toBe("my.type");
			expect(entry.data).toEqual({ x: 1 });
			expect(entry.parentId).toBe("parent-1");
			expect(entry.id).toHaveLength(8);
			expect(entry.timestamp).toBeTruthy();
		});
	});

	describe("buildCustomMessageEntry", () => {
		it("produces a valid custom message entry", () => {
			const entry = buildCustomMessageEntry(
				"lens.persona",
				"Review this diff",
				null,
				{ display: true },
			);
			expect(entry.type).toBe("custom_message");
			expect(entry.customType).toBe("lens.persona");
			expect(entry.content).toBe("Review this diff");
			expect(entry.display).toBe(true);
			expect(entry.parentId).toBeNull();
		});

		it("defaults display to false", () => {
			const entry = buildCustomMessageEntry("x", "y", null);
			expect(entry.display).toBe(false);
		});
	});
});
