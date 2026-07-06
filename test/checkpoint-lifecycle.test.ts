import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	it("analyze → fork agent session: end-to-end", async () => {
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

		// ---- Phase 3: Fork agent session ----
		const backendCompact = analyzeResult.compactedFiles.get("backend")!;
		const agentDir = join(root, "agent-sessions");
		mkdirSync(agentDir, { recursive: true });

		const { entries: compactEntries } = parseSessionFile(backendCompact);
		const lastEntry = compactEntries[compactEntries.length - 1];

		const forkedAgent = forkSessionAt(backendCompact, lastEntry.id, agentDir, {
			cwd: "/backend/worktree",
		});

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
		appendToSession(forkedAgent, [modesState, seed]);

		// Verify forked agent session content
		const agentParsed = parseSessionFile(forkedAgent);
		expect(agentParsed.header.cwd).toBe("/backend/worktree");
		expect(agentParsed.header.parentSession).toBeDefined();
		expect(agentParsed.entries).toHaveLength(3); // context + modes state + seed
		expect(agentParsed.entries[0].type).toBe("custom_message");
		expect(agentParsed.entries[1].type).toBe("custom");
		expect(agentParsed.entries[2].type).toBe("custom");

		// ---- Phase 4: Verify refresh logic ----
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
	});

	it("MAESTRO_ENV reads all env vars from centralized config", () => {
		const original = {
			MAESTRO_ANALYZE_MODEL: process.env.MAESTRO_ANALYZE_MODEL,
			MAESTRO_AGENT_MODEL: process.env.MAESTRO_AGENT_MODEL,
			MAESTRO_CLASSIFIER_MODEL: process.env.MAESTRO_CLASSIFIER_MODEL,
		};

		try {
			process.env.MAESTRO_ANALYZE_MODEL = "analyze-model";
			process.env.MAESTRO_AGENT_MODEL = "agent-model";
			process.env.MAESTRO_CLASSIFIER_MODEL = "classifier-model";

			expect(MAESTRO_ENV.analyzeModel).toBe("analyze-model");
			expect(MAESTRO_ENV.agentModel).toBe("agent-model");
			expect(MAESTRO_ENV.classifierModel).toBe("classifier-model");
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
		};

		try {
			delete process.env.MAESTRO_ANALYZE_MODEL;

			expect(MAESTRO_ENV.analyzeModel).toBeUndefined();
		} finally {
			for (const [key, val] of Object.entries(original)) {
				if (val === undefined) delete process.env[key];
				else process.env[key] = val;
			}
		}
	});
});
