import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ANALYZE_CHECKPOINT_TYPE,
	type AnalyzeResult,
	checkpointForDeliverable,
	planAnalyzePhases,
	runAnalyzePhase,
	shouldRefreshAnalyze,
} from "../packages/modes/src/analyze.js";
import type { Deliverable, Plan } from "../packages/modes/src/schema.js";

function makePlan(
	delivs: Array<Partial<Deliverable> & { id: string; title: string }>,
	opts?: { repoPath?: string; repos?: Plan["repos"] },
): Plan {
	return {
		slug: "test",
		title: "Test",
		repoPath: opts?.repoPath ?? "/repo",
		repos: opts?.repos,
		nodes: delivs.map((d) => ({
			type: "deliverable" as const,
			id: d.id,
			title: d.title,
			body: d.body ?? "",
			status: d.status ?? "planned",
			children: [],
			dependsOn: d.dependsOn,
			repo: d.repo,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		})),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("planAnalyzePhases", () => {
	it("produces a single core phase for single-repo plan", () => {
		const plan = makePlan([
			{ id: "a", title: "Feature A" },
			{ id: "b", title: "Feature B" },
		]);
		const phases = planAnalyzePhases(plan);
		expect(phases).toHaveLength(1);
		expect(phases[0].label).toBe("core");
		expect(phases[0].deliverableIds).toEqual(["a", "b"]);
		expect(phases[0].repoPath).toBe("/repo");
	});

	it("groups deliverables by repo and orders default first", () => {
		const plan = makePlan(
			[
				{ id: "a", title: "A", repo: "frontend" },
				{ id: "b", title: "B" },
				{ id: "c", title: "C", repo: "frontend" },
			],
			{
				repos: [{ key: "frontend", path: "/frontend" }],
			},
		);
		const phases = planAnalyzePhases(plan);
		expect(phases).toHaveLength(2);
		expect(phases[0].label).toBe("core");
		expect(phases[0].deliverableIds).toEqual(["b"]);
		expect(phases[1].label).toBe("frontend");
		expect(phases[1].deliverableIds).toEqual(["a", "c"]);
		expect(phases[1].repoPath).toBe("/frontend");
	});

	it("skips abandoned deliverables", () => {
		const plan = makePlan([
			{ id: "a", title: "A", status: "abandoned" },
			{ id: "b", title: "B" },
		]);
		const phases = planAnalyzePhases(plan);
		expect(phases).toHaveLength(1);
		expect(phases[0].deliverableIds).toEqual(["b"]);
	});

	it("returns empty for empty plan", () => {
		const plan = makePlan([]);
		expect(planAnalyzePhases(plan)).toEqual([]);
	});

	it("orders repos with more dependents first (after default)", () => {
		const plan = makePlan(
			[
				{ id: "a", title: "A", repo: "lib" },
				{ id: "b", title: "B", repo: "app", dependsOn: ["a"] },
				{ id: "c", title: "C", repo: "app", dependsOn: ["a"] },
			],
			{
				repos: [
					{ key: "lib", path: "/lib" },
					{ key: "app", path: "/app" },
				],
			},
		);
		const phases = planAnalyzePhases(plan);
		// lib has 2 dependents, app has 0 → lib comes first (after default if any)
		const labels = phases.map((p) => p.label);
		expect(labels.indexOf("lib")).toBeLessThan(labels.indexOf("app"));
	});
});

describe("checkpointForDeliverable", () => {
	it("resolves to the correct phase label", () => {
		const phases = [
			{
				label: "core",
				deliverableIds: ["a", "b"],
				explorationGoal: "",
				repoKey: "default",
				repoPath: "/repo",
			},
			{
				label: "frontend",
				deliverableIds: ["c"],
				explorationGoal: "",
				repoKey: "frontend",
				repoPath: "/fe",
			},
		];
		expect(checkpointForDeliverable(phases, "a")).toBe("core");
		expect(checkpointForDeliverable(phases, "c")).toBe("frontend");
		expect(checkpointForDeliverable(phases, "nonexistent")).toBeUndefined();
	});
});

describe("shouldRefreshAnalyze", () => {
	it("returns true when no result", () => {
		const plan = makePlan([{ id: "a", title: "A" }]);
		expect(shouldRefreshAnalyze(plan)).toBe(true);
	});

	it("returns false when result is fresh", () => {
		const plan = makePlan([{ id: "a", title: "A" }]);
		const result: AnalyzeResult = {
			sessionFile: "/tmp/x.jsonl",
			checkpoints: new Map(),
			compactedFiles: new Map(),
			coveredDeliverableIds: new Set(["a"]),
			createdAt: Date.now(), // fresh
		};
		expect(shouldRefreshAnalyze(plan, result)).toBe(false);
	});

	it("returns true when stale and new planned work exists", () => {
		const plan = makePlan([
			{ id: "a", title: "A", status: "active" },
			{ id: "b", title: "B", status: "planned" },
		]);
		const result: AnalyzeResult = {
			sessionFile: "/tmp/x.jsonl",
			checkpoints: new Map(),
			compactedFiles: new Map(),
			coveredDeliverableIds: new Set(["a"]),
			createdAt: Date.now() - 6 * 60 * 1000, // 6 min ago
		};
		expect(shouldRefreshAnalyze(plan, result)).toBe(true);
	});

	it("returns false when stale but all planned work is covered", () => {
		const plan = makePlan([
			{ id: "a", title: "A", status: "active" },
			{ id: "b", title: "B", status: "planned" },
		]);
		const result: AnalyzeResult = {
			sessionFile: "/tmp/x.jsonl",
			checkpoints: new Map(),
			compactedFiles: new Map(),
			coveredDeliverableIds: new Set(["a", "b"]),
			createdAt: Date.now() - 6 * 60 * 1000,
		};
		expect(shouldRefreshAnalyze(plan, result)).toBe(false);
	});
});

describe("runAnalyzePhase", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "analyze-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("orchestrates spawn + checkpoint parsing + compaction", async () => {
		const plan = makePlan([
			{ id: "a", title: "Feature A" },
			{ id: "b", title: "Feature B" },
		]);

		const sessionDir = join(root, "sessions");
		const compactDir = join(root, "compact");

		// Mock spawn: writes a session with checkpoint entries
		const spawn = async (opts: { sessionFile: string; prompt: string }) => {
			const header = JSON.stringify({
				type: "session",
				version: 3,
				id: "sess-analyze",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/repo",
			});
			const entries = [
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "assistant", text: "exploring..." },
				}),
				JSON.stringify({
					type: "custom",
					customType: ANALYZE_CHECKPOINT_TYPE,
					data: { label: "core" },
					id: "cp-1",
					parentId: "msg-1",
					timestamp: "2026-01-01T00:00:02.000Z",
				}),
			];
			writeFileSync(opts.sessionFile, `${[header, ...entries].join("\n")}\n`);
		};

		// Mock compact: writes a simplified file
		const compact = async (opts: {
			rawSessionFile: string;
			checkpointEntryId: string;
			outputDir: string;
		}) => {
			const out = join(
				opts.outputDir,
				`compact_${opts.checkpointEntryId}.jsonl`,
			);
			const header = JSON.stringify({
				type: "session",
				version: 3,
				id: "compact-1",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/repo",
			});
			const entry = JSON.stringify({
				type: "custom_message",
				customType: "maestro.analyze.context",
				content: "Compacted context here",
				display: false,
				id: "ctx-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:03.000Z",
			});
			writeFileSync(out, `${header}\n${entry}\n`);
			return out;
		};

		const result = await runAnalyzePhase(plan, {
			sessionDir,
			compactDir,
			spawn,
			compact,
		});

		expect(result.sessionFile).toContain("analyze_");
		expect(result.checkpoints.size).toBe(1);
		expect(result.checkpoints.has("core")).toBe(true);
		expect(result.checkpoints.get("core")!.entryId).toBe("cp-1");
		expect(result.compactedFiles.size).toBe(1);
		expect(result.compactedFiles.has("core")).toBe(true);
		expect(result.coveredDeliverableIds).toEqual(new Set(["a", "b"]));
	});

	it("throws when spawn fails", async () => {
		const plan = makePlan([{ id: "a", title: "A" }]);

		const spawn = async () => {
			throw new Error("pi crashed");
		};
		const compact = async () => "/tmp/x.jsonl";

		await expect(
			runAnalyzePhase(plan, {
				sessionDir: join(root, "s"),
				compactDir: join(root, "c"),
				spawn,
				compact,
			}),
		).rejects.toThrow("pi crashed");
	});

	it("throws when plan has no deliverables", async () => {
		const plan = makePlan([]);
		await expect(
			runAnalyzePhase(plan, {
				sessionDir: join(root, "s"),
				compactDir: join(root, "c"),
				spawn: async () => {},
				compact: async () => "",
			}),
		).rejects.toThrow("No deliverables to analyze");
	});

	it("passes env with MAESTRO_ANALYZE_MODEL when set", async () => {
		const plan = makePlan([{ id: "a", title: "A" }]);
		let capturedEnv: Record<string, string> | undefined;

		const originalEnv = process.env.MAESTRO_ANALYZE_MODEL;
		process.env.MAESTRO_ANALYZE_MODEL = "claude-sonnet-4-20250514";

		const spawn = async (opts: {
			sessionFile: string;
			env?: Record<string, string>;
		}) => {
			capturedEnv = opts.env;
			// Write minimal valid session
			writeFileSync(
				opts.sessionFile,
				`${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/repo" })}\n`,
			);
		};

		try {
			await runAnalyzePhase(plan, {
				sessionDir: join(root, "s"),
				compactDir: join(root, "c"),
				spawn,
				compact: async () => "",
			});
		} finally {
			if (originalEnv === undefined) {
				delete process.env.MAESTRO_ANALYZE_MODEL;
			} else {
				process.env.MAESTRO_ANALYZE_MODEL = originalEnv;
			}
		}

		expect(capturedEnv?.PI_MODEL).toBe("claude-sonnet-4-20250514");
		expect(capturedEnv?.PI_MAESTRO_PHASE).toBe("analyze");
	});
});
