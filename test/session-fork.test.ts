import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createSessionFileAt,
	parseSessionFile,
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

	describe("createSessionFileAt", () => {
		it("writes the header eagerly and returns an append-ready manager", () => {
			const path = join(root, "nested", "boot.jsonl");
			const sm = createSessionFileAt(path, "/work/tree", { id: "boot-1" });
			// The file must exist on disk immediately — agents are spawned with
			// `pi --session <file>` before any assistant turn runs.
			expect(existsSync(path)).toBe(true);

			sm.appendCustomEntry("test.state", { mode: "agent" });
			sm.appendCustomMessageEntry("test.seed", "# Your Tasks", true);

			const { header, entries } = parseSessionFile(path);
			expect(header.type).toBe("session");
			expect(header.id).toBe("boot-1");
			expect(header.cwd).toBe("/work/tree");
			expect(header.parentSession).toBeUndefined();

			expect(entries).toHaveLength(2);
			const [state, seed] = entries as any[];
			expect(state.type).toBe("custom");
			expect(state.customType).toBe("test.state");
			expect(state.parentId).toBeNull();
			expect(seed.type).toBe("custom_message");
			expect(seed.content).toBe("# Your Tasks");
			expect(seed.display).toBe(true);
			expect(seed.parentId).toBe(state.id);
		});

		it("defaults to a fresh UUID id and honours a version override", () => {
			const a = createSessionFileAt(join(root, "a.jsonl"), "/w");
			const b = createSessionFileAt(join(root, "b.jsonl"), "/w");
			expect(a.getSessionId()).not.toBe(b.getSessionId());

			createSessionFileAt(join(root, "v.jsonl"), "/w", { version: 3 });
			const { header } = parseSessionFile(join(root, "v.jsonl"));
			expect(header.version).toBe(3);
		});

		it("keeps the header cwd verbatim even when the directory does not exist", () => {
			const path = join(root, "ghost.jsonl");
			createSessionFileAt(path, "/nope/nowhere");
			expect(parseSessionFile(path).header.cwd).toBe("/nope/nowhere");
			expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
		});
	});
});
