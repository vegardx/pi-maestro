// Deep plan verification (/verify): beyond the mechanical /recover audit,
// actually check the WORK. For each started deliverable the orchestrator
// gathers hard evidence (commits ahead of base, the real diff, PR diff for
// shipped work), then spawns a read-only `general` subagent whose job is to
// read that diff plus the surrounding code and judge — task by task — whether
// the claimed work genuinely exists and accomplishes what the plan says.

import { existsSync } from "node:fs";
import type { RunResult, SpawnProfile } from "@vegardx/pi-contracts";
import { detectDefaultBranch, runCommand } from "@vegardx/pi-git";
import type { Deliverable, Plan } from "../schema.js";
import {
	defaultBranchForDeliverable,
	deliverableWorkspace,
	gatingTasks,
	pickBaseBranch,
	repoFor,
} from "../schema.js";
import {
	parseStructuredFindings,
	renderFinding,
	type StructuredFinding,
} from "./findings.js";
import { parseVerdict } from "./verdicts.js";

// The structured-finding vocabulary moved to the shared findings module (the
// panel ledger uses the same schema); re-exported here for existing callers.
export {
	FINDING_SEVERITIES,
	type FindingSeverity,
	parseStructuredFindings,
	renderFinding,
	type StructuredFinding,
} from "./findings.js";

/** Statuses with work on disk/remote worth verifying. */
const STARTED = new Set(["active", "complete", "shipped"]);

/** Diffs beyond this are clipped in the prompt (the agent can read files). */
const DIFF_CLIP = 50_000;

export interface VerifyEntry {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	/** pass = tasks genuinely accomplished; fail = agent found blockers or the
	 *  mechanical evidence contradicts the claimed status; inconclusive = the
	 *  agent returned no parseable verdict; error = spawn/run failure. */
	readonly verdict: "pass" | "fail" | "inconclusive" | "error";
	/** Agent findings rendered one-line ("file.ts:12 — description"). */
	readonly findings: readonly string[];
	/** The findings with structure (severity/category/claim/actual). */
	readonly structured: readonly StructuredFinding[];
	/** Mechanical (git/gh) problems found before the agent ran. */
	readonly problems: readonly string[];
	/** Mechanical facts fed to the agent (shown when expanding a report). */
	readonly facts: readonly string[];
	/** The agent's full report text, when it ran. */
	readonly report?: string;
	readonly error?: string;
}

/** Evidence gathered per deliverable before spawning its verifier. */
export interface Evidence {
	readonly facts: string[];
	readonly problems: string[];
	readonly diff?: string;
	/** Where the verifier runs (worktree > repo > workspace). */
	readonly cwd?: string;
}

export interface VerifyDeps {
	readonly spawn: (
		prompt: string,
		profile: SpawnProfile,
	) => { readonly id: string; result(): Promise<RunResult> };
	readonly pathExists?: (path: string) => boolean;
	/** Run git in a directory; ok=false on non-zero exit. */
	readonly runGit?: (
		cwd: string,
		args: string[],
	) => { ok: boolean; stdout: string };
	/** `gh pr diff <n>` — the authoritative diff for shipped work. */
	readonly prDiff?: (cwd: string, number: number) => string | undefined;
	readonly defaultBranchFor?: (repoPath: string) => string;
	/** Display metadata for run views (resolved session model). */
	readonly display?: {
		readonly model?: string;
		readonly effort?: string;
		readonly adaptive?: boolean;
	};
	/** Lifecycle hooks — feed the live agent table + chat cards. */
	readonly onStarted?: (view: VerifyRunView) => void;
	readonly onSettled?: (view: VerifyRunView, entry: VerifyEntry) => void;
	/** Liveness watchdog for verifier children (defaults 120s/240s/600s). */
	readonly watchdog?: SpawnProfile["watchdog"];
}

/** Shape-compatible with ResearchRunView so verify runs share the widget map. */
export interface VerifyRunView {
	readonly id: string;
	readonly question: string;
	readonly label: string;
	readonly kind: "verify";
	status: "running" | "succeeded" | "failed" | "stopped";
	readonly startedAt: number;
	tokensIn?: number;
	tokensOut?: number;
	cacheRatio?: number;
	model?: string;
	effort?: string;
	adaptive?: boolean;
	activity?: string;
}

const DEFAULT_WATCHDOG = { stallMs: 120_000, softMs: 240_000, hardMs: 600_000 };

function defaultRunGit(
	cwd: string,
	args: string[],
): { ok: boolean; stdout: string } {
	const r = runCommand("git", args, { cwd });
	return { ok: r.ok, stdout: r.stdout };
}

function defaultPrDiff(cwd: string, number: number): string | undefined {
	const r = runCommand("gh", ["pr", "diff", String(number)], { cwd });
	return r.ok ? r.stdout : undefined;
}

/** The deliverables /verify targets: everything started, or one by id. */
export function verifyTargets(plan: Plan, id?: string): Deliverable[] {
	if (id) {
		const g = plan.deliverables.find((d) => d.id === id);
		return g && STARTED.has(g.status) ? [g] : [];
	}
	return plan.deliverables.filter((g) => STARTED.has(g.status));
}

/**
 * Gather mechanical evidence for one deliverable: does the claimed work exist
 * in git/GitHub, and what is its actual diff? Problems recorded here are
 * Tier-2 findings in their own right (zero commits on a "complete" branch,
 * branch gone, workspace missing) — the agent pass builds on top of them.
 */
export function gatherEvidence(
	plan: Plan,
	g: Deliverable,
	deps: VerifyDeps,
): Evidence {
	const pathExists = deps.pathExists ?? existsSync;
	const runGit = deps.runGit ?? defaultRunGit;
	const prDiff = deps.prDiff ?? defaultPrDiff;
	const facts: string[] = [];
	const problems: string[] = [];

	if (deliverableWorkspace(g) === "scratch") {
		const cwd =
			g.worktreePath && pathExists(g.worktreePath) ? g.worktreePath : undefined;
		if (cwd) facts.push(`scratch workspace: ${cwd}`);
		else problems.push("scratch workspace missing — nothing to inspect");
		return { facts, problems, ...(cwd ? { cwd } : {}) };
	}

	const repo = repoFor(plan, g);
	if (!pathExists(repo.path)) {
		problems.push(`repo path missing: ${repo.path}`);
		return { facts, problems };
	}
	const cwd =
		g.worktreePath && pathExists(g.worktreePath) ? g.worktreePath : repo.path;
	const branch = g.branch ?? defaultBranchForDeliverable(g);
	const defaultBranch =
		deps.defaultBranchFor?.(repo.path) ??
		detectDefaultBranch(repo.path) ??
		"main";
	const base = pickBaseBranch(plan, g, defaultBranch);
	facts.push(`branch ${branch}, base ${base}`);

	// Shipped with a PR: the PR diff is authoritative — it is what actually
	// merged, and it survives local branch deletion.
	if (g.status === "shipped" && g.prNumber !== undefined) {
		const diff = prDiff(cwd, g.prNumber);
		if (diff !== undefined) {
			facts.push(`diff source: PR #${g.prNumber}`);
			if (diff.trim() === "")
				problems.push(`PR #${g.prNumber} has an empty diff`);
			return { facts, problems, diff, cwd };
		}
		facts.push(`PR #${g.prNumber} diff unavailable — using local branch`);
	}

	const branchExists = runGit(cwd, [
		"rev-parse",
		"--verify",
		"--quiet",
		`${branch}^{commit}`,
	]).ok;
	if (!branchExists) {
		problems.push(
			g.status === "shipped"
				? `branch ${branch} gone and no PR diff — cannot verify content`
				: `branch ${branch} not found — the claimed work does not exist locally`,
		);
		return { facts, problems, cwd };
	}

	// Commits ahead of base (merged branches legitimately report 0 — the
	// zero-work check only applies before ship).
	const ahead = runGit(cwd, ["rev-list", "--count", `${base}..${branch}`]);
	if (ahead.ok) {
		const n = Number.parseInt(ahead.stdout.trim(), 10);
		facts.push(`${n} commit(s) ahead of ${base}`);
		if (n === 0 && g.status !== "shipped") {
			problems.push(`branch ${branch} has zero commits ahead of ${base}`);
		}
	}

	const stat = runGit(cwd, ["diff", "--stat", `${base}...${branch}`]);
	if (stat.ok && stat.stdout.trim()) facts.push(`diffstat:\n${stat.stdout}`);
	const diff = runGit(cwd, ["diff", `${base}...${branch}`]);
	if (diff.ok) {
		if (diff.stdout.trim() === "" && g.status !== "shipped") {
			problems.push(`empty diff ${base}...${branch} — no work on the branch`);
		}
		return { facts, problems, diff: diff.stdout, cwd };
	}
	return { facts, problems, cwd };
}

const clipDiff = (diff: string): string =>
	diff.length > DIFF_CLIP
		? `${diff.slice(0, DIFF_CLIP)}\n[…diff clipped — read the files for the rest]`
		: diff;

/** The verifier's prompt: deliverable contract + evidence + verdict protocol. */
export function buildVerifyPrompt(g: Deliverable, evidence: Evidence): string {
	const tasks = gatingTasks(g)
		.map(
			(t) =>
				`- [${t.done ? "x" : " "}] ${t.title}${t.body ? ` — ${t.body}` : ""}`,
		)
		.join("\n");
	const lines = [
		"You are a verification agent. A plan claims the deliverable below is " +
			`"${g.status}". Your job is to check whether the work GENUINELY exists ` +
			"and accomplishes its tasks — not whether files merely changed.",
		"",
		`# Deliverable: ${g.title} (${g.id}, status: ${g.status})`,
		g.body,
		"",
		"## Tasks",
		"Tasks marked [x] must be genuinely accomplished by the work. Unmarked " +
			"tasks are not expected to be done yet — flag them only if the plan " +
			"status implies they should be.",
		tasks || "(no gating tasks recorded)",
		"",
		"## Mechanical evidence (gathered by the orchestrator)",
		...evidence.facts.map((f) => `- ${f}`),
		...evidence.problems.map((p) => `- PROBLEM: ${p}`),
	];
	if (g.waivers?.length) {
		lines.push(
			"",
			"## Waived findings",
			"A human explicitly accepted these review findings at the ship gate — " +
				"do NOT re-flag them or count them against the verdict:",
			...g.waivers.map((w) => `- ${w.reviewer}: ${w.reason} (${w.at})`),
		);
	}
	if (evidence.diff !== undefined) {
		lines.push(
			"",
			"## The actual diff",
			"```diff",
			clipDiff(evidence.diff),
			"```",
		);
	} else if (evidence.cwd) {
		lines.push(
			"",
			"No diff applies — inspect the working directory contents directly.",
		);
	}
	lines.push(
		"",
		"## Instructions",
		"Work task by task. Read the surrounding code in the working directory " +
			"where the diff alone is ambiguous. Look for: tasks with no " +
			"corresponding change, stubs or TODOs passed off as done, tests " +
			"claimed but absent, and implementations that would not actually work.",
		"",
		"End your report with a line `VERDICT: pass` (every expected task is " +
			"genuinely accomplished) or `VERDICT: block` (something claimed is " +
			"missing, fake, or broken), then a fenced ```json block:",
		"",
		"```json",
		'{"findings": [{"severity": "critical|major|minor", "category": ' +
			'"<kebab-case theme, e.g. packaging, fake-verification, ' +
			'missing-artifact, correctness-bug, unimplemented-integration>", ' +
			'"file": "path.ts", "line": 12, "task": "<the task it contradicts>", ' +
			'"claim": "<what is claimed to exist>", "actual": "<what is actually there>"}]}',
		"```",
		"",
		"One entry per finding; an empty findings array when passing. The " +
			"claim/actual pair must make the finding decidable without reading " +
			"your prose.",
	);
	return lines.join("\n");
}

/**
 * Fan out one read-only `general` verifier per target and fold verdicts back
 * into entries. Mechanical-only failures (no repo, no branch, no workspace)
 * skip the agent — there is nothing for it to read.
 */
export async function runVerification(
	plan: Plan,
	targets: readonly Deliverable[],
	deps: VerifyDeps,
): Promise<VerifyEntry[]> {
	return Promise.all(
		targets.map(async (g) => {
			const evidence = gatherEvidence(plan, g, deps);
			const base = {
				id: g.id,
				title: g.title,
				status: g.status,
				problems: evidence.problems,
				facts: evidence.facts,
			};
			if (!evidence.cwd) {
				return {
					...base,
					verdict: "fail" as const,
					findings: [],
					structured: [],
				};
			}
			const view: VerifyRunView = {
				id: "",
				question: `verify ${g.id}`,
				label: g.id,
				kind: "verify",
				status: "running",
				startedAt: Date.now(),
				effort: deps.display?.effort ?? "high",
				...(deps.display?.model ? { model: deps.display.model } : {}),
				...(deps.display?.adaptive !== undefined
					? { adaptive: deps.display.adaptive }
					: {}),
			};
			const profile = {
				profile: "general",
				transport: "tmux" as const,
				role: "verifier",
				displayName: `verify-${g.id}`,
				cwd: evidence.cwd,
				thinking: (deps.display?.effort ?? "high") as
					| "off"
					| "minimal"
					| "low"
					| "medium"
					| "high"
					| "xhigh",
				watchdog: deps.watchdog ?? DEFAULT_WATCHDOG,
			};
			const prompt = buildVerifyPrompt(g, evidence);
			let result: RunResult;
			try {
				const handle = deps.spawn(prompt, profile);
				(view as { id: string }).id = handle.id;
				deps.onStarted?.(view);
				result = await handle.result();
				if (
					result.status === "succeeded" &&
					!result.summary?.trim() &&
					!result.error?.includes("user interrupt")
				) {
					// Some gateway models occasionally end a run with no final text
					// — retry once rather than reporting an empty verification. The
					// widget keeps the original run's row; only the result is
					// replaced.
					result = await deps.spawn(prompt, profile).result();
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				view.status = "failed";
				const entry = {
					...base,
					verdict: "error" as const,
					findings: [],
					structured: [],
					error: message,
				};
				deps.onSettled?.(view, entry);
				return entry;
			}
			const report = result.summary?.trim();
			view.status = result.status === "succeeded" ? "succeeded" : "failed";
			if (!report) {
				const entry = {
					...base,
					verdict: "error" as const,
					findings: [],
					structured: [],
					error: result.error ?? `verifier ${result.status} with no report`,
				};
				deps.onSettled?.(view, entry);
				return entry;
			}
			const parsed = parseVerdict(report);
			const verdict =
				parsed.verdict === "approve"
					? ("pass" as const)
					: parsed.verdict === "request-changes"
						? ("fail" as const)
						: ("inconclusive" as const);
			const structured = parseStructuredFindings(report);
			const entry = {
				...base,
				verdict,
				findings: structured.map(renderFinding),
				structured,
				report,
			};
			deps.onSettled?.(view, entry);
			return entry;
		}),
	);
}

const VERDICT_ICON = { pass: "✓", fail: "✗", inconclusive: "?", error: "!" };

/** Render the verification round as a notify-able report. */
export function renderVerification(entries: readonly VerifyEntry[]): string {
	if (entries.length === 0) return "Nothing started to verify.";
	const counts = { pass: 0, fail: 0, inconclusive: 0, error: 0 };
	for (const e of entries) counts[e.verdict]++;
	const lines = entries.map((e) => {
		const head = `${VERDICT_ICON[e.verdict]} ${e.id} (${e.status}) — ${e.verdict}${e.error ? `: ${e.error}` : ""}`;
		const detail = [
			...e.problems.map((p) => `    ⚠ ${p}`),
			...e.findings.map((f) => `    - ${f}`),
		].join("\n");
		return detail ? `${head}\n${detail}` : head;
	});
	const summary =
		counts.fail + counts.error === 0
			? `Verified: ${counts.pass} pass${counts.inconclusive ? `, ${counts.inconclusive} inconclusive` : ""}.`
			: `Verification found problems: ${counts.pass} pass, ${counts.fail} fail${counts.inconclusive ? `, ${counts.inconclusive} inconclusive` : ""}${counts.error ? `, ${counts.error} error` : ""}.`;
	return `${summary}\n${lines.join("\n")}`;
}
