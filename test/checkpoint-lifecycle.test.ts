import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ANALYZE_CHECKPOINT_TYPE,
	checkpointForDeliverable,
	planAnalyzePhases,
	runAnalyzePhase,
	shouldRefreshAnalyze,
} from "../packages/modes/src/analyze.js";
import {
	resolveCompactedFile,
	runLensFromFork,
} from "../packages/modes/src/lens-fork.js";
import type { SpawnResult } from "../packages/modes/src/lenses/index.js";
import type { Deliverable, Plan } from "../packages/modes/src/schema.js";
import {
	appendToSession,
	buildCustomEntry,
	forkSessionAt,
	parseSessionFile,
} from "../packages/modes/src/session-fork.js";
import { MAESTRO_ENV } from "../packages/modes/src/settings.js";

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

describe("full checkpoint lifecycle (integration)", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "checkpoint-lifecycle-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("analyze → fork worker → fork lens: end-to-end", async () => {
		const plan = makePlan(
			[
				{ id: "api", title: "API layer", repo: "backend" },
				{ id: "ui", title: "UI components", repo: "frontend" },
			],
			{
				repoPath: "/repo",
				repos: [
					{ key: "backend", path: "/backend" },
					{ key: "frontend", path: "/frontend" },
				],
			},
		);

		// ---- Phase 1: Plan analyze phases ----
		const phases = planAnalyzePhases(plan);
		expect(phases.length).toBeGreaterThanOrEqual(2);
		expect(checkpointForDeliverable(phases, "api")).toBe("backend");
		expect(checkpointForDeliverable(phases, "ui")).toBe("frontend");

		// ---- Phase 2: Run analyze (mocked spawn) ----
		const sessionDir = join(root, "sessions");
		const compactDir = join(root, "compact");

		const spawn = async (opts: {
			sessionFile: string;
			env?: Record<string, string>;
		}) => {
			// Verify env
			expect(opts.env?.PI_MAESTRO_PHASE).toBe("analyze");

			// Write session with checkpoints for both repos
			const header = JSON.stringify({
				type: "session",
				version: 3,
				id: "analyze-sess",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/backend",
			});
			const entries = [
				JSON.stringify({
					type: "message",
					id: "explore-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: {
						role: "assistant",
						text: "Explored backend: Express, PostgreSQL, jest tests.",
					},
				}),
				JSON.stringify({
					type: "custom",
					customType: ANALYZE_CHECKPOINT_TYPE,
					data: { label: "backend" },
					id: "cp-backend",
					parentId: "explore-1",
					timestamp: "2026-01-01T00:00:02.000Z",
				}),
				JSON.stringify({
					type: "message",
					id: "explore-2",
					parentId: "cp-backend",
					timestamp: "2026-01-01T00:00:03.000Z",
					message: {
						role: "assistant",
						text: "Explored frontend: React, Vite, vitest.",
					},
				}),
				JSON.stringify({
					type: "custom",
					customType: ANALYZE_CHECKPOINT_TYPE,
					data: { label: "frontend" },
					id: "cp-frontend",
					parentId: "explore-2",
					timestamp: "2026-01-01T00:00:04.000Z",
				}),
			];
			writeFileSync(opts.sessionFile, `${[header, ...entries].join("\n")}\n`);
		};

		// Mock compact: creates a simplified session for each checkpoint
		const compact = async (opts: {
			rawSessionFile: string;
			checkpointEntryId: string;
			outputDir: string;
		}) => {
			mkdirSync(opts.outputDir, { recursive: true });
			const out = join(
				opts.outputDir,
				`compact_${opts.checkpointEntryId}.jsonl`,
			);
			const header = JSON.stringify({
				type: "session",
				version: 3,
				id: `compact-${opts.checkpointEntryId}`,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/repo",
			});
			const context = JSON.stringify({
				type: "custom_message",
				customType: "maestro.analyze.context",
				content: `Compacted context for checkpoint ${opts.checkpointEntryId}`,
				display: false,
				id: `ctx-${opts.checkpointEntryId}`,
				parentId: null,
				timestamp: "2026-01-01T00:00:05.000Z",
			});
			writeFileSync(out, `${header}\n${context}\n`);
			return out;
		};

		const analyzeResult = await runAnalyzePhase(plan, {
			sessionDir,
			compactDir,
			spawn,
			compact,
		});

		expect(analyzeResult.checkpoints.size).toBe(2);
		expect(analyzeResult.compactedFiles.size).toBe(2);
		expect(analyzeResult.coveredDeliverableIds).toEqual(new Set(["api", "ui"]));

		// ---- Phase 3: Fork worker session ----
		const backendCompact = analyzeResult.compactedFiles.get("backend")!;
		const workerDir = join(root, "worker-sessions");
		mkdirSync(workerDir, { recursive: true });

		const { entries: compactEntries } = parseSessionFile(backendCompact);
		const lastEntry = compactEntries[compactEntries.length - 1];

		const forkedWorker = forkSessionAt(
			backendCompact,
			lastEntry.id,
			workerDir,
			{
				cwd: "/backend/worktree",
			},
		);

		// Append modes state + seed (simulating what buildSessionFile does)
		const modesState = buildCustomEntry(
			"maestro.modes.state",
			{
				version: 2,
				mode: "auto",
				execution: { stage: "executing", deliverableId: "api" },
			},
			lastEntry.id,
		);
		const seed = buildCustomEntry(
			"maestro-execution-seed",
			{ content: "Plan seed text", deliverableId: "api" },
			modesState.id,
		);
		appendToSession(forkedWorker, [modesState, seed]);

		// Verify forked worker session content
		const workerParsed = parseSessionFile(forkedWorker);
		expect(workerParsed.header.cwd).toBe("/backend/worktree");
		expect(workerParsed.header.parentSession).toBeDefined();
		expect(workerParsed.entries).toHaveLength(3); // context + modes state + seed
		expect(workerParsed.entries[0].type).toBe("custom_message");
		expect(workerParsed.entries[1].type).toBe("custom");
		expect(workerParsed.entries[2].type).toBe("custom");

		// ---- Phase 4: Fork lens session (from analyze, NOT worker) ----
		const frontendCompact = resolveCompactedFile(analyzeResult, "frontend");
		expect(frontendCompact).toBeDefined();

		const lensResult = await runLensFromFork({
			lens: "review",
			situation: "diff",
			analyzeSessionFile: frontendCompact!,
			input: "--- a/Component.tsx\n+++ b/Component.tsx\n+// new code",
			cwd: root,
			spawnFn: async (args): Promise<SpawnResult> => {
				// Verify the session file contains context but NO worker state
				const sessIdx = args.indexOf("--session");
				const sessFile = args[sessIdx + 1];
				const content = readFileSync(sessFile, "utf8");

				// Has analyze context
				expect(content).toContain("maestro.analyze.context");
				// Has lens persona
				expect(content).toContain("maestro.lens.persona");
				expect(content).toContain("ROLE OVERRIDE");
				expect(content).toContain("Component.tsx");
				// Does NOT have worker execution state
				expect(content).not.toContain("maestro.modes.state");
				expect(content).not.toContain("maestro-execution-seed");

				return {
					stdout: JSON.stringify({
						message: {
							role: "assistant",
							content: "[]",
							usage: { input: 800, output: 50 },
						},
					}),
					exitCode: 0,
				};
			},
		});

		expect(lensResult.findings).toEqual([]);
		expect(lensResult.error).toBeUndefined();

		// ---- Phase 5: Verify refresh logic ----
		expect(shouldRefreshAnalyze(plan, analyzeResult)).toBe(false);

		// Add new deliverable → should trigger refresh
		const updatedPlan = makePlan(
			[
				{ id: "api", title: "API", repo: "backend", status: "active" },
				{ id: "ui", title: "UI", repo: "frontend", status: "active" },
				{ id: "docs", title: "Documentation", status: "planned" },
			],
			{
				repoPath: "/repo",
				repos: [
					{ key: "backend", path: "/backend" },
					{ key: "frontend", path: "/frontend" },
				],
			},
		);
		// Force stale
		const staleResult = {
			...analyzeResult,
			createdAt: Date.now() - 6 * 60 * 1000,
		};
		expect(shouldRefreshAnalyze(updatedPlan, staleResult)).toBe(true);

		// ---- Phase 6: Fallback path ----
		const fallbackResult = resolveCompactedFile(undefined, "nonexistent");
		expect(fallbackResult).toBeUndefined();
	});

	it("MAESTRO_ENV reads all env vars from centralized config", () => {
		const original = {
			MAESTRO_ANALYZE_MODEL: process.env.MAESTRO_ANALYZE_MODEL,
			MAESTRO_AGENT_MODEL: process.env.MAESTRO_AGENT_MODEL,
			MAESTRO_LENS_MODEL: process.env.MAESTRO_LENS_MODEL,
			MAESTRO_CLASSIFIER_MODEL: process.env.MAESTRO_CLASSIFIER_MODEL,
			MAESTRO_MAX_REVIEW_CYCLES: process.env.MAESTRO_MAX_REVIEW_CYCLES,
			MAESTRO_LENS_DISABLED: process.env.MAESTRO_LENS_DISABLED,
		};

		try {
			process.env.MAESTRO_ANALYZE_MODEL = "analyze-model";
			process.env.MAESTRO_AGENT_MODEL = "agent-model";
			process.env.MAESTRO_LENS_MODEL = "lens-model";
			process.env.MAESTRO_CLASSIFIER_MODEL = "classifier-model";
			process.env.MAESTRO_MAX_REVIEW_CYCLES = "5";
			process.env.MAESTRO_LENS_DISABLED = "1";

			expect(MAESTRO_ENV.analyzeModel).toBe("analyze-model");
			expect(MAESTRO_ENV.agentModel).toBe("agent-model");
			expect(MAESTRO_ENV.lensModel).toBe("lens-model");
			expect(MAESTRO_ENV.classifierModel).toBe("classifier-model");
			expect(MAESTRO_ENV.maxReviewCycles).toBe(5);
			expect(MAESTRO_ENV.lensDisabled).toBe(true);
		} finally {
			for (const [key, val] of Object.entries(original)) {
				if (val === undefined) delete process.env[key];
				else process.env[key] = val;
			}
		}
	});

	it("MAESTRO_ENV returns defaults when env vars unset", () => {
		const original = {
			MAESTRO_ANALYZE_MODEL: process.env.MAESTRO_ANALYZE_MODEL,
			MAESTRO_MAX_REVIEW_CYCLES: process.env.MAESTRO_MAX_REVIEW_CYCLES,
			MAESTRO_LENS_DISABLED: process.env.MAESTRO_LENS_DISABLED,
		};

		try {
			delete process.env.MAESTRO_ANALYZE_MODEL;
			delete process.env.MAESTRO_MAX_REVIEW_CYCLES;
			delete process.env.MAESTRO_LENS_DISABLED;

			expect(MAESTRO_ENV.analyzeModel).toBeUndefined();
			expect(MAESTRO_ENV.maxReviewCycles).toBe(2);
			expect(MAESTRO_ENV.lensDisabled).toBe(false);
		} finally {
			for (const [key, val] of Object.entries(original)) {
				if (val === undefined) delete process.env[key];
				else process.env[key] = val;
			}
		}
	});
});
