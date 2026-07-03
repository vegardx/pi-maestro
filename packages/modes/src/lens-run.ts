import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { currentBranch, detectDefaultBranch } from "@vegardx/pi-git";
import type { AnalyzeResult } from "./analyze.js";
import type { PlanEngine } from "./engine.js";
import { resolveCompactedFile, runLensFromFork } from "./lens-fork.js";
import {
	detectScope,
	type Finding,
	type GitInfo,
	type LensName,
	type LensResult,
	type LensScope,
	runLens,
	type Situation,
} from "./lenses/index.js";
import { renderPlanSummary } from "./markdown.js";

export const LENSES: readonly LensName[] = ["review", "refine", "validate"];

function git(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8" });
	} catch {
		return "";
	}
}

export function gatherGitInfo(cwd: string): GitInfo {
	return {
		defaultBranch: detectDefaultBranch(cwd) ?? "main",
		currentBranch: currentBranch(cwd),
		dirty: git(cwd, ["status", "--porcelain"]).trim().length > 0,
	};
}

/**
 * Render a scope to the text a lens will analyse, plus the situation frame to
 * use. Returns null for the "project" scope (caller shows guidance instead of
 * injecting the whole repo).
 */
export function renderScope(
	scope: LensScope,
	cwd: string,
	engine: PlanEngine | undefined,
): { text: string; situation: Situation } | null {
	switch (scope.situation) {
		case "files": {
			const text = scope.paths
				.map((p) => {
					try {
						return `# ${p}\n${readFileSync(p, "utf8")}`;
					} catch {
						return `# ${p}\n(could not read)`;
					}
				})
				.join("\n\n");
			return { text, situation: "files" };
		}
		case "plan":
			return engine
				? { text: renderPlanSummary(engine.get()), situation: "plan" }
				: null;
		case "working-tree":
			return { text: git(cwd, ["diff", "HEAD"]), situation: "working-tree" };
		case "diff":
			return { text: git(cwd, ["diff", scope.range]), situation: "diff" };
		case "project":
			return null;
	}
}

export interface LensRunContext {
	cwd: string;
	mode: string;
	engine: PlanEngine | undefined;
	requirements?: string;
	model?: string;
	/** Analyze result for checkpoint-based forking. */
	analyzeResult?: AnalyzeResult;
	/** Checkpoint label for the target deliverable. */
	checkpointLabel?: string;
}

export interface AggregateResult {
	scope: LensScope;
	guidance?: string;
	results: LensResult[];
}

/** Detect scope, render it, and run the requested lenses sequentially. */
export async function runLensesForArgs(
	lenses: readonly LensName[],
	args: string,
	rc: LensRunContext,
): Promise<AggregateResult> {
	const scope = detectScope(args, rc.mode, gatherGitInfo(rc.cwd), !!rc.engine);
	const rendered = renderScope(scope, rc.cwd, rc.engine);
	if (!rendered) {
		return {
			scope,
			guidance:
				"Nothing to review here — pass paths (/review src/…) or switch to a feature branch with changes. Whole-project review is not a single-shot lens.",
			results: [],
		};
	}
	if (!rendered.text.trim()) {
		return { scope, guidance: "No changes to review.", results: [] };
	}
	const results: LensResult[] = [];
	const compactedFile = resolveCompactedFile(
		rc.analyzeResult,
		rc.checkpointLabel,
	);
	for (const lens of lenses) {
		if (compactedFile) {
			// Fork from compacted analyze checkpoint
			results.push(
				await runLensFromFork({
					lens,
					situation: rendered.situation,
					analyzeSessionFile: compactedFile,
					input: rendered.text,
					cwd: rc.cwd,
					model: rc.model,
				}),
			);
		} else {
			// Cold start fallback
			results.push(
				await runLens(lens, rendered.situation, {
					cwd: rc.cwd,
					input: rendered.text,
					requirements: rc.requirements,
					model: rc.model,
				}),
			);
		}
	}
	return { scope, results };
}

/** Human-readable summary of lens findings. */
export function formatFindings(results: readonly LensResult[]): string {
	const lines: string[] = [];
	for (const r of results) {
		if (r.error) {
			lines.push(`## ${r.lens}: error — ${r.error}`);
			continue;
		}
		if (r.findings.length === 0) {
			lines.push(`## ${r.lens}: no issues ✓`);
			continue;
		}
		lines.push(`## ${r.lens}: ${r.findings.length} finding(s)`);
		for (const f of r.findings) lines.push(formatFinding(f));
	}
	return lines.join("\n");
}

function formatFinding(f: Finding): string {
	const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
	const action = f.suggestedAction ? `\n  → ${f.suggestedAction}` : "";
	return `- [${f.severity}] ${f.title}${loc}${f.description ? `\n  ${f.description}` : ""}${action}`;
}

export function totalFindings(results: readonly LensResult[]): number {
	return results.reduce((n, r) => n + r.findings.length, 0);
}
