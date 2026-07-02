import { describe, expect, it } from "vitest";
import {
	buildSystemPrompt,
	detectScope,
	type GitInfo,
	parseEventStream,
	parseFindings,
	runLens,
	type SpawnFn,
} from "../packages/modes/src/lenses/index.js";

const git = (o: Partial<GitInfo> = {}): GitInfo => ({
	defaultBranch: "main",
	currentBranch: "feat/x",
	dirty: false,
	...o,
});

describe("detectScope", () => {
	it("explicit paths -> files", () => {
		expect(detectScope("src/a.ts src/b.ts", "auto", git(), false)).toEqual({
			situation: "files",
			paths: ["src/a.ts", "src/b.ts"],
		});
	});
	it("plan mode -> plan", () => {
		expect(detectScope("", "plan", git(), true).situation).toBe("plan");
	});
	it("dirty tree -> working-tree", () => {
		expect(detectScope("", "auto", git({ dirty: true }), false)).toEqual({
			situation: "working-tree",
			range: "HEAD",
		});
	});
	it("feature branch -> diff vs base", () => {
		expect(detectScope("", "auto", git(), false)).toEqual({
			situation: "diff",
			range: "main...HEAD",
		});
	});
	it("default branch clean -> project (guidance)", () => {
		expect(
			detectScope("", "auto", git({ currentBranch: "main" }), false).situation,
		).toBe("project");
	});
});

describe("parseFindings", () => {
	it("parses a fenced json block", () => {
		const text = 'Here:\n```json\n[{"severity":"IMPORTANT","title":"x"}]\n```';
		expect(parseFindings(text)).toEqual([
			{
				severity: "IMPORTANT",
				title: "x",
				file: undefined,
				line: undefined,
				description: undefined,
				suggestedAction: undefined,
			},
		]);
	});
	it("parses a bare array and drops malformed entries", () => {
		const text = '[{"title":"a"},{"nope":1},{"severity":"MINOR","title":"b"}]';
		const f = parseFindings(text);
		expect(f.map((x) => x.title)).toEqual(["a", "b"]);
		expect(f[0].severity).toBe("MINOR"); // default
	});
	it("returns [] on garbage", () => {
		expect(parseFindings("no json here")).toEqual([]);
		expect(parseFindings("[not json]")).toEqual([]);
	});
});

describe("parseEventStream", () => {
	it("extracts the last assistant text and sums usage", () => {
		const lines = [
			JSON.stringify({ type: "turn_start" }),
			JSON.stringify({
				message: {
					role: "assistant",
					content: [{ type: "text", text: "[]" }],
					usage: { input: 10, output: 2, cost: { total: 0.01 } },
				},
			}),
		].join("\n");
		const { text, usage } = parseEventStream(lines);
		expect(text).toBe("[]");
		expect(usage.input).toBe(10);
		expect(usage.cost).toBeCloseTo(0.01);
	});
});

describe("buildSystemPrompt", () => {
	it("composes lensCore with a situation frame", () => {
		const p = buildSystemPrompt("review", "diff");
		expect(p).toContain("CODE REVIEWER");
		expect(p).toContain("DIFF");
	});
});

describe("runLens", () => {
	it("returns findings + usage on success via a mocked spawn", async () => {
		const spawnFn: SpawnFn = async () => ({
			stdout: JSON.stringify({
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: '[{"severity":"MINOR","title":"y"}]' },
					],
					usage: { input: 5, cost: { total: 0.5 } },
				},
			}),
			exitCode: 0,
		});
		const r = await runLens("review", "diff", {
			cwd: process.cwd(),
			input: "diff text",
			spawnFn,
		});
		expect(r.findings).toEqual([
			{
				severity: "MINOR",
				title: "y",
				file: undefined,
				line: undefined,
				description: undefined,
				suggestedAction: undefined,
			},
		]);
		expect(r.usage.cost).toBeCloseTo(0.5);
		expect(r.error).toBeUndefined();
	});

	it("returns an error on non-zero exit", async () => {
		const spawnFn: SpawnFn = async () => ({ stdout: "", exitCode: 1 });
		const r = await runLens("refine", "files", {
			cwd: process.cwd(),
			input: "x",
			spawnFn,
		});
		expect(r.error).toContain("exited 1");
		expect(r.findings).toEqual([]);
	});
});
