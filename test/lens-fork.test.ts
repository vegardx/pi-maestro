import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnalyzeResult } from "../packages/modes/src/analyze.js";
import {
	buildLensPersonaMessage,
	resolveCompactedFile,
	runLensFromFork,
} from "../packages/modes/src/lens-fork.js";
import type { SpawnResult } from "../packages/modes/src/lenses/index.js";

function makeCompactedSession(dir: string): string {
	const file = join(dir, "compact.jsonl");
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "compact-sess",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/repo",
		}),
		JSON.stringify({
			type: "custom_message",
			customType: "maestro.analyze.context",
			content: "Project uses TypeScript strict, vitest, monorepo structure.",
			display: false,
			id: "ctx-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
		}),
	];
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

describe("buildLensPersonaMessage", () => {
	it("includes role override, lens instructions, and input", () => {
		const msg = buildLensPersonaMessage(
			"review",
			"diff",
			"--- a/file.ts\n+++ b/file.ts",
		);
		expect(msg).toContain("ROLE OVERRIDE");
		expect(msg).toContain("CODE REVIEWER");
		expect(msg).toContain("REVIEW INSTRUCTIONS");
		expect(msg).toContain("--- a/file.ts");
		expect(msg).toContain("JSON array of findings");
	});

	it("uses the correct situation frame", () => {
		const diffMsg = buildLensPersonaMessage("review", "diff", "x");
		expect(diffMsg).toContain("DIFF against the base branch");

		const wtMsg = buildLensPersonaMessage("review", "working-tree", "x");
		expect(wtMsg).toContain("UNCOMMITTED CHANGES");
	});

	it("loads the correct lens instructions", () => {
		const reviewMsg = buildLensPersonaMessage("review", "diff", "x");
		const refineMsg = buildLensPersonaMessage("refine", "diff", "x");
		// They should differ (different .md files loaded)
		expect(reviewMsg).not.toBe(refineMsg);
	});
});

describe("runLensFromFork", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lens-fork-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("creates forked session with persona and returns findings", async () => {
		const compactedFile = makeCompactedSession(root);

		const findings = [
			{
				severity: "MAJOR",
				title: "Missing null check",
				file: "src/foo.ts",
				line: 42,
			},
		];

		const mockSpawn = async (args: string[]): Promise<SpawnResult> => {
			// Verify the session arg is passed
			expect(args).toContain("--session");
			expect(args).toContain("--mode");
			expect(args).toContain("json");

			// Read the forked session file to verify content
			const sessionIdx = args.indexOf("--session");
			const sessionFile = args[sessionIdx + 1];
			const content = readFileSync(sessionFile, "utf8");
			expect(content).toContain("maestro.analyze.context");
			expect(content).toContain("maestro.lens.persona");
			expect(content).toContain("ROLE OVERRIDE");

			// Return a valid lens response
			const response = JSON.stringify({
				message: {
					role: "assistant",
					content: `\`\`\`json\n${JSON.stringify(findings)}\n\`\`\``,
					usage: { input: 1000, output: 200 },
				},
			});
			return { stdout: response, exitCode: 0 };
		};

		const result = await runLensFromFork({
			lens: "review",
			situation: "diff",
			analyzeSessionFile: compactedFile,
			input: "--- a/foo.ts\n+++ b/foo.ts\n@@ -40,3 +40,5 @@",
			cwd: root,
			spawnFn: mockSpawn,
		});

		expect(result.lens).toBe("review");
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].title).toBe("Missing null check");
		expect(result.error).toBeUndefined();
	});

	it("returns error when pi exits non-zero", async () => {
		const compactedFile = makeCompactedSession(root);

		const mockSpawn = async (): Promise<SpawnResult> => ({
			stdout: "",
			exitCode: 1,
		});

		const result = await runLensFromFork({
			lens: "review",
			situation: "diff",
			analyzeSessionFile: compactedFile,
			input: "some diff",
			cwd: root,
			spawnFn: mockSpawn,
		});

		expect(result.error).toContain("pi exited 1");
		expect(result.findings).toEqual([]);
	});

	it("returns error when compacted session is empty", async () => {
		const emptyFile = join(root, "empty.jsonl");
		writeFileSync(
			emptyFile,
			`${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/x" })}\n`,
		);

		const result = await runLensFromFork({
			lens: "review",
			situation: "diff",
			analyzeSessionFile: emptyFile,
			input: "diff",
			cwd: root,
			spawnFn: async () => ({ stdout: "", exitCode: 0 }),
		});

		expect(result.error).toContain("Empty analyze session");
	});

	it("handles non-JSON output gracefully (returns empty findings)", async () => {
		const compactedFile = makeCompactedSession(root);

		const mockSpawn = async (): Promise<SpawnResult> => ({
			stdout: JSON.stringify({
				message: {
					role: "assistant",
					content: "I found some issues but can't format them as JSON",
					usage: { input: 500, output: 100 },
				},
			}),
			exitCode: 0,
		});

		const result = await runLensFromFork({
			lens: "review",
			situation: "diff",
			analyzeSessionFile: compactedFile,
			input: "diff content",
			cwd: root,
			spawnFn: mockSpawn,
		});

		expect(result.findings).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("passes model arg when specified", async () => {
		const compactedFile = makeCompactedSession(root);
		let capturedArgs: string[] = [];

		const mockSpawn = async (args: string[]): Promise<SpawnResult> => {
			capturedArgs = args;
			return {
				stdout: JSON.stringify({
					message: { role: "assistant", content: "[]", usage: {} },
				}),
				exitCode: 0,
			};
		};

		await runLensFromFork({
			lens: "review",
			situation: "diff",
			analyzeSessionFile: compactedFile,
			input: "diff",
			cwd: root,
			model: "claude-sonnet-4-20250514",
			spawnFn: mockSpawn,
		});

		expect(capturedArgs).toContain("--model");
		expect(capturedArgs).toContain("claude-sonnet-4-20250514");
	});
});

describe("resolveCompactedFile", () => {
	it("returns compacted file when result and label match", () => {
		const result: AnalyzeResult = {
			sessionFile: "/tmp/x.jsonl",
			checkpoints: new Map(),
			compactedFiles: new Map([["core", "/tmp/compact_core.jsonl"]]),
			coveredDeliverableIds: new Set(),
			createdAt: Date.now(),
		};
		expect(resolveCompactedFile(result, "core")).toBe(
			"/tmp/compact_core.jsonl",
		);
	});

	it("returns undefined when no result", () => {
		expect(resolveCompactedFile(undefined, "core")).toBeUndefined();
	});

	it("returns undefined when label not found", () => {
		const result: AnalyzeResult = {
			sessionFile: "/tmp/x.jsonl",
			checkpoints: new Map(),
			compactedFiles: new Map([["core", "/tmp/compact_core.jsonl"]]),
			coveredDeliverableIds: new Set(),
			createdAt: Date.now(),
		};
		expect(resolveCompactedFile(result, "frontend")).toBeUndefined();
	});

	it("returns undefined when label is undefined", () => {
		const result: AnalyzeResult = {
			sessionFile: "/tmp/x.jsonl",
			checkpoints: new Map(),
			compactedFiles: new Map(),
			coveredDeliverableIds: new Set(),
			createdAt: Date.now(),
		};
		expect(resolveCompactedFile(result, undefined)).toBeUndefined();
	});
});
