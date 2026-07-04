// Analyze phase: explore the codebase before workers spawn, creating
// compacted checkpoints that workers and lenses fork from. Fails hard
// if exploration fails — no silent fallback.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Plan, PlanRepo } from "./schema.js";
import { deliverables, effectiveDependsOn, repoFor } from "./schema.js";
import { parseSessionFile } from "./session-fork.js";
import { getModeRoleModel, MAESTRO_ENV } from "./settings.js";

// ---- Types ----------------------------------------------------------------

export interface AnalyzePhase {
	/** Human-readable label for this exploration phase. */
	readonly label: string;
	/** Deliverable ids covered by this phase. */
	readonly deliverableIds: string[];
	/** What to explore in this phase. */
	readonly explorationGoal: string;
	/** Repo this phase targets. */
	readonly repoKey: string;
	/** Absolute path to the repo. */
	readonly repoPath: string;
}

export interface CheckpointEntry {
	readonly id: string;
	readonly label: string;
	readonly entryId: string;
	readonly timestamp: string;
}

export interface AnalyzeResult {
	/** Path to the raw analyze session file. */
	readonly sessionFile: string;
	/** Checkpoints discovered in the session, keyed by label. */
	readonly checkpoints: Map<string, CheckpointEntry>;
	/** Compacted session files, keyed by checkpoint label. */
	readonly compactedFiles: Map<string, string>;
	/** Deliverable ids covered by this analyze run. */
	readonly coveredDeliverableIds: Set<string>;
	/** When this result was created (ms since epoch). */
	readonly createdAt: number;
}

export interface AnalyzeOpts {
	/** Directory for session files. */
	readonly sessionDir: string;
	/** Directory for compacted output. */
	readonly compactDir: string;
	/** Function to spawn pi and run the analyze session. Returns session file path. */
	readonly spawn: SpawnFn;
	/** Function to compact a checkpoint. */
	readonly compact: CompactFn;
	/** Extension context for model resolution. */
	readonly ctx?: ExtensionContext;
}

/**
 * Spawn function: given an analyze prompt, cwd, session file path, and env,
 * runs pi and returns the session file (which now contains checkpoint entries).
 */
export type SpawnFn = (opts: {
	sessionFile: string;
	cwd: string;
	prompt: string;
	env?: Record<string, string>;
}) => Promise<void>;

/**
 * Compact function: given a raw session file and a checkpoint entry id,
 * produce a compacted session file in the output directory.
 */
export type CompactFn = (opts: {
	rawSessionFile: string;
	checkpointEntryId: string;
	outputDir: string;
}) => Promise<string>;

// ---- Custom entry type for checkpoints ------------------------------------

export const ANALYZE_CHECKPOINT_TYPE = "maestro.analyze.checkpoint";

// ---- Phase planning -------------------------------------------------------

/**
 * Group deliverables by repo and order by dependency depth. Always produces
 * a "core" phase first (for the default/primary repo), then per-repo phases.
 */
export function planAnalyzePhases(plan: Plan): AnalyzePhase[] {
	const allDeliverables = deliverables(plan).filter(
		(d) => d.status !== "abandoned",
	);
	if (allDeliverables.length === 0) return [];

	// Group by repo key
	const byRepo = new Map<string, typeof allDeliverables>();
	for (const d of allDeliverables) {
		const repo = repoFor(plan, d);
		const group = byRepo.get(repo.key) ?? [];
		group.push(d);
		byRepo.set(repo.key, group);
	}

	// Order repos: default first, then by how many other deliverables depend on them
	const repoKeys = [...byRepo.keys()];
	const dependencyCount = new Map<string, number>();
	for (const d of allDeliverables) {
		const deps = effectiveDependsOn(plan, d);
		for (const depId of deps) {
			const dep = allDeliverables.find((x) => x.id === depId);
			if (dep) {
				const depRepo = repoFor(plan, dep).key;
				dependencyCount.set(depRepo, (dependencyCount.get(depRepo) ?? 0) + 1);
			}
		}
	}

	repoKeys.sort((a, b) => {
		if (a === "default") return -1;
		if (b === "default") return 1;
		return (dependencyCount.get(b) ?? 0) - (dependencyCount.get(a) ?? 0);
	});

	const phases: AnalyzePhase[] = [];
	for (const key of repoKeys) {
		// biome-ignore lint/style/noNonNullAssertion: key comes from byRepo.keys()
		const group = byRepo.get(key)!;
		const repo = resolveRepo(plan, key);
		const goals = group.map(
			(d) => `- ${d.title}${d.body ? `: ${d.body}` : ""}`,
		);
		phases.push({
			label: key === "default" ? "core" : key,
			deliverableIds: group.map((d) => d.id),
			explorationGoal: goals.join("\n"),
			repoKey: key,
			repoPath: repo.path,
		});
	}

	return phases;
}

/**
 * Given phases and a deliverable id, return the phase label (checkpoint label)
 * that covers it.
 */
export function checkpointForDeliverable(
	phases: readonly AnalyzePhase[],
	deliverableId: string,
): string | undefined {
	for (const phase of phases) {
		if (phase.deliverableIds.includes(deliverableId)) {
			return phase.label;
		}
	}
	return undefined;
}

// ---- Analyze execution ----------------------------------------------------

/**
 * Run the full analyze phase: plan phases, spawn a single pi session that
 * explores in order and drops checkpoints, then compact each checkpoint.
 *
 * Throws on failure (fail hard — no silent fallback).
 */
export async function runAnalyzePhase(
	plan: Plan,
	opts: AnalyzeOpts,
): Promise<AnalyzeResult> {
	const phases = planAnalyzePhases(plan);
	if (phases.length === 0) {
		throw new Error("No deliverables to analyze");
	}

	// Build session file with header
	mkdirSync(opts.sessionDir, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const sessionFile = join(
		opts.sessionDir,
		`analyze_${timestamp}_${randomUUID().slice(0, 8)}.jsonl`,
	);

	// Build the exploration prompt
	const prompt = buildAnalyzePrompt(phases);

	// Resolve model for analyze phase
	const analyzeEnv: Record<string, string> = { PI_MAESTRO_PHASE: "analyze" };
	if (opts.ctx) {
		const resolved = await getModeRoleModel(opts.ctx, "analyze");
		if (resolved) {
			analyzeEnv.PI_MODEL = resolved.modelId;
			if (resolved.thinking && resolved.thinking !== "off") {
				analyzeEnv.PI_THINKING = resolved.thinking;
			}
		}
	} else if (MAESTRO_ENV.analyzeModel) {
		analyzeEnv.PI_MODEL = MAESTRO_ENV.analyzeModel;
	}

	// Spawn and run — throws on failure
	await opts.spawn({
		sessionFile,
		cwd: phases[0].repoPath,
		prompt,
		env: analyzeEnv,
	});

	// Parse checkpoints from the session
	const { entries } = parseSessionFile(sessionFile);
	const checkpoints = new Map<string, CheckpointEntry>();
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			(entry as { customType?: string }).customType === ANALYZE_CHECKPOINT_TYPE
		) {
			const data = (entry as { data?: { label?: string } }).data;
			if (data?.label) {
				checkpoints.set(data.label, {
					id: randomUUID().slice(0, 8),
					label: data.label,
					entryId: entry.id,
					timestamp: entry.timestamp,
				});
			}
		}
	}

	// Compact each checkpoint
	mkdirSync(opts.compactDir, { recursive: true });
	const compactedFiles = new Map<string, string>();
	for (const [label, checkpoint] of checkpoints) {
		const compacted = await opts.compact({
			rawSessionFile: sessionFile,
			checkpointEntryId: checkpoint.entryId,
			outputDir: opts.compactDir,
		});
		compactedFiles.set(label, compacted);
	}

	const coveredDeliverableIds = new Set<string>();
	for (const phase of phases) {
		for (const id of phase.deliverableIds) {
			coveredDeliverableIds.add(id);
		}
	}

	return {
		sessionFile,
		checkpoints,
		compactedFiles,
		coveredDeliverableIds,
		createdAt: Date.now(),
	};
}

// ---- Refresh logic --------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * True if a fresh analyze run is needed: no result, cache expired with new
 * work, or new deliverables not covered by the last run.
 */
export function shouldRefreshAnalyze(
	plan: Plan,
	analyzeResult?: AnalyzeResult,
): boolean {
	if (!analyzeResult) return true;

	const age = Date.now() - analyzeResult.createdAt;
	if (age < CACHE_TTL_MS) return false;

	// Cache is stale — check if new planned work exists
	const allDeliverables = deliverables(plan).filter(
		(d) => d.status === "planned",
	);
	return allDeliverables.some(
		(d) => !analyzeResult.coveredDeliverableIds.has(d.id),
	);
}

// ---- Internals ------------------------------------------------------------

function buildAnalyzePrompt(phases: readonly AnalyzePhase[]): string {
	const phaseInstructions = phases
		.map(
			(p, i) =>
				`## Phase ${i + 1}: ${p.label}\n` +
				`Repo: ${p.repoPath}\n` +
				`Deliverables to support:\n${p.explorationGoal}\n\n` +
				`When done exploring for this phase, call: checkpoint(label: "${p.label}")`,
		)
		.join("\n\n");

	return (
		`You are exploring a codebase to build context for implementation agents.\n\n` +
		`RULES:\n` +
		`- Use read, bash (read-only: ls, find, grep, cat, head, wc), and similar tools\n` +
		`- Do NOT modify any files\n` +
		`- Focus on: project structure, conventions, test patterns, key types, and dependencies\n` +
		`- After exploring each phase, call checkpoint(label: "<label>") to mark the boundary\n\n` +
		`PHASES:\n\n${phaseInstructions}\n\n` +
		`Start with Phase 1. Explore methodically, then checkpoint.`
	);
}

function resolveRepo(plan: Plan, key: string): PlanRepo {
	if (key === "default") return { key: "default", path: plan.repoPath };
	return plan.repos?.find((r) => r.key === key) ?? { key, path: plan.repoPath };
}
