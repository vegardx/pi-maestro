// Lens forking: run lenses from an analyze checkpoint instead of cold-starting.
// Lenses fork from the ANALYZE checkpoint (not worker checkpoint) to give
// fresh eyes without implementation bias.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalyzeResult } from "./analyze.js";
import type {
	LensName,
	LensResult,
	Situation,
	SpawnFn,
} from "./lenses/index.js";
import {
	parseEventStream,
	parseFindings,
	spawnCleanPi,
} from "./lenses/index.js";
import {
	appendToSession,
	buildCustomMessageEntry,
	forkSessionAt,
	parseSessionFile,
} from "./session-fork.js";

const LENS_DIR = fileURLToPath(new URL("./lenses/", import.meta.url));

// ---- Persona override builder ---------------------------------------------

/**
 * Build the persona override message that transforms an exploration session
 * into a code review session. Includes: role override, lens instructions, diff.
 */
export function buildLensPersonaMessage(
	lens: LensName,
	situation: Situation,
	input: string,
): string {
	const instructions = readFileSync(join(LENS_DIR, `${lens}.md`), "utf8");

	const situationFrame: Record<string, string> = {
		diff: "You are reviewing a DIFF against the base branch.",
		"working-tree": "You are reviewing UNCOMMITTED CHANGES.",
		files: "You are reviewing the provided files.",
		plan: "You are reviewing a PLAN (not code).",
		project: "You are reviewing an entire project.",
	};

	const frame = situationFrame[situation] ?? situationFrame.files;

	return (
		`# ROLE OVERRIDE\n` +
		`You are no longer exploring the codebase. You are now a CODE REVIEWER.\n` +
		`Your ONLY job is to analyze the content below.\n\n` +
		`# SITUATION\n${frame}\n\n` +
		`# REVIEW INSTRUCTIONS\n${instructions}\n\n` +
		`# CONTENT TO REVIEW\n\`\`\`\n${input}\n\`\`\`\n\n` +
		`Output ONLY a JSON array of findings. Each finding has: severity, title, file (optional), line (optional), description (optional), suggestedAction (optional). If no issues: []`
	);
}

// ---- Fork-based lens execution --------------------------------------------

export interface RunLensFromForkOptions {
	lens: LensName;
	situation: Situation;
	/** Compacted analyze checkpoint file path. */
	analyzeSessionFile: string;
	/** The input to review (diff, file contents, plan text). */
	input: string;
	cwd: string;
	model?: string;
	spawnFn?: SpawnFn;
}

/**
 * Run a lens by forking from a compacted analyze session. The forked session
 * gets a persona override message appended, then pi is spawned with
 * `--session` to use the forked context.
 *
 * Returns the same `LensResult` as the cold-start `runLens`.
 */
export async function runLensFromFork(
	opts: RunLensFromForkOptions,
): Promise<LensResult> {
	const { lens, situation, analyzeSessionFile, input, cwd, model } = opts;
	const spawnFn = opts.spawnFn ?? spawnCleanPi;

	// Fork from the last entry in the compacted file
	const { entries } = parseSessionFile(analyzeSessionFile);
	const lastEntry = entries[entries.length - 1];
	if (!lastEntry) {
		return {
			lens,
			findings: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: 0,
				turns: 0,
			},
			error: "Empty analyze session — cannot fork",
		};
	}

	const forked = forkSessionAt(analyzeSessionFile, lastEntry.id, cwd, { cwd });

	// Append persona override as a user-visible custom message
	const persona = buildLensPersonaMessage(lens, situation, input);
	const personaEntry = buildCustomMessageEntry(
		"maestro.lens.persona",
		persona,
		lastEntry.id,
		{ display: true },
	);
	appendToSession(forked, [personaEntry]);

	// Spawn pi with the forked session
	const args = [
		"--session",
		forked,
		"--mode",
		"json",
		"-ne",
		...(model ? ["--model", model] : []),
	];
	const result = await spawnFn(args, { cwd });

	if (result.exitCode !== 0) {
		return {
			lens,
			findings: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: 0,
				turns: 0,
			},
			error: `pi exited ${result.exitCode}`,
		};
	}

	const { text, usage } = parseEventStream(result.stdout);
	return { lens, findings: parseFindings(text), usage };
}

// ---- Integration helper ---------------------------------------------------

/**
 * Resolve the compacted session file for a deliverable from the analyze result.
 * Returns undefined if no analyze result or no matching checkpoint.
 */
export function resolveCompactedFile(
	analyzeResult: AnalyzeResult | undefined,
	checkpointLabel: string | undefined,
): string | undefined {
	if (!analyzeResult || !checkpointLabel) return undefined;
	return analyzeResult.compactedFiles.get(checkpointLabel);
}
