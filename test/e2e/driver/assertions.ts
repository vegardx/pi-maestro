// White-box outcome assertions. Per the research verdict, a full-stack run is
// validated by inspecting real program state — the persisted plan and the git
// repo — NOT by scraping the agent's transcript. These read the maestro's
// plan.json (deliverable statuses, PR URLs) and the git history (shipped files),
// independent of how the run was driven.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type PlanView,
	type PlanViewNode,
	projectPlanView,
} from "@vegardx/pi-contracts";
import type { ExpectedDeliverable, Scenario } from "./scenario.js";

/** Statuses that count as "the deliverable landed". */
const SHIPPED_STATUSES = new Set(["shipped"]);

export function planJsonPath(piHome: string, slug: string): string {
	return join(piHome, ".pi", "agent", "maestro", "plans", slug, "plan.json");
}

/** The plan file IS the state API — read and project it (schema-agnostic). */
export function readPlan(piHome: string, slug: string): PlanView | null {
	const path = planJsonPath(piHome, slug);
	if (!existsSync(path)) return null;
	try {
		return projectPlanView(JSON.parse(readFileSync(path, "utf8"))) ?? null;
	} catch {
		return null;
	}
}

export interface DeliverableCheck {
	readonly titleMatch: string;
	readonly matched: boolean;
	readonly status?: string;
	readonly shipped: boolean;
	readonly hasPr: boolean;
	readonly missingFiles: string[];
	/**
	 * Worker model resolution persisted on the plan (fix #250): even a
	 * deliverable authored without a model must carry the pinned resolution
	 * after its worker spawned — never re-rolled in memory only.
	 */
	readonly modelPinned: boolean;
	/**
	 * Stacked-base integrity (fix #249): a stacked deliverable's recorded
	 * baseSha must NOT lie on the seed main branch — its base is a sibling's
	 * feat branch tip. The old bug recorded the main checkout's HEAD, which
	 * always sat on main. True for non-stacked deliverables vacuously.
	 */
	readonly baseOk: boolean;
}

export interface AssertionResult {
	readonly ok: boolean;
	readonly planFound: boolean;
	readonly checks: DeliverableCheck[];
	readonly summary: string;
}

/**
 * Assert every expected deliverable reached a shipped status, produced a PR, and
 * that its files exist somewhere in git history. `repoDir` is the checkout whose
 * `git log --all` should contain the shipped work.
 */
export function assertScenario(
	piHome: string,
	repoDir: string,
	scenario: Scenario,
): AssertionResult {
	const plan = readPlan(piHome, scenario.name);
	if (!plan) {
		return {
			ok: false,
			planFound: false,
			checks: [],
			summary: `plan.json not found for "${scenario.name}" under ${piHome}`,
		};
	}
	const tracked = new Set(gitTrackedFilesAllBranches(repoDir));
	const checks = scenario.expected.map((exp) =>
		checkDeliverable(exp, plan.nodes, tracked, repoDir),
	);
	const ok = checks.every(
		(c) =>
			c.matched &&
			c.shipped &&
			c.hasPr &&
			c.missingFiles.length === 0 &&
			c.modelPinned &&
			c.baseOk,
	);
	return { ok, planFound: true, checks, summary: renderSummary(checks) };
}

function checkDeliverable(
	exp: ExpectedDeliverable,
	nodes: readonly PlanViewNode[],
	tracked: Set<string>,
	repoDir: string,
): DeliverableCheck {
	const match = nodes.find((node) =>
		node.title.toLowerCase().includes(exp.titleMatch.toLowerCase()),
	);
	// A file spec may list explicit alternates ("src/x.ts|src/x.js") — the
	// scenario cares that the MODULE shipped, not which extension the agents
	// judged right for the sandbox repo's conventions.
	const missingFiles = exp.files.filter(
		(f) => !f.split("|").some((alternative) => tracked.has(alternative)),
	);
	return {
		titleMatch: exp.titleMatch,
		matched: match !== undefined,
		status: match?.status,
		shipped: match ? SHIPPED_STATUSES.has(match.status) : false,
		hasPr: Boolean(match?.prUrl),
		missingFiles,
		modelPinned: Boolean(match?.workerModel),
		baseOk: match ? stackedBaseOk(match, repoDir) : false,
	};
}

/**
 * Fix #249's live check: a stacked deliverable's base is the tip of the
 * branch it stacks on, which contains commits beyond main — so its recorded
 * baseSha must NOT be reachable from the seed `main`. (PRs are never merged
 * into the local main during a drive, so main still points at the seed.)
 */
function stackedBaseOk(d: PlanViewNode, repoDir: string): boolean {
	if (!d.stacked) return true;
	if (!d.baseSha) return false;
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", d.baseSha, "main"], {
			cwd: repoDir,
			stdio: "ignore",
		});
		return false; // on main = the old checkout-HEAD bug
	} catch {
		return true; // not on main → based on a sibling's branch, as designed
	}
}

/** Every path that appears anywhere in the repo's reachable history. */
function gitTrackedFilesAllBranches(repoDir: string): string[] {
	try {
		const out = execFileSync(
			"git",
			["log", "--all", "--pretty=format:", "--name-only", "--no-renames"],
			{ cwd: repoDir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
		);
		return out
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	} catch {
		return [];
	}
}

function renderSummary(checks: DeliverableCheck[]): string {
	return checks
		.map((c) => {
			if (!c.matched) return `✗ ${c.titleMatch}: no matching deliverable`;
			const parts = [`status=${c.status}`];
			if (!c.hasPr) parts.push("no PR");
			if (c.missingFiles.length)
				parts.push(`missing ${c.missingFiles.join(", ")}`);
			if (!c.modelPinned) parts.push("worker model not pinned on plan");
			if (!c.baseOk) parts.push("stacked baseSha sits on main (stale base)");
			const ok =
				c.shipped &&
				c.hasPr &&
				c.missingFiles.length === 0 &&
				c.modelPinned &&
				c.baseOk;
			return `${ok ? "✓" : "✗"} ${c.titleMatch}: ${parts.join("; ")}`;
		})
		.join("\n");
}

// ─── Ensemble acceptance (task #27) ──────────────────────────────────────────

export interface EnsembleAssertion {
	readonly ok: boolean;
	readonly base: AssertionResult;
	/** cand/<parent>/<id> branches found in the repo. */
	readonly candBranches: string[];
	/** Every cand branch carries a DONE: commit. */
	readonly candidatesDone: boolean;
	/** PRs whose head is a cand/ branch — MUST be zero. */
	readonly candidatePrCount: number;
	/** PRs whose head is the parent branch — MUST be exactly one. */
	readonly parentPrCount: number;
	readonly summary: string;
}

/**
 * The ensemble invariant on top of the base scenario assertions: N candidate
 * branches with finished work, ZERO candidate PRs, exactly ONE parent PR.
 * `ghStateDir` is the gh shim's state dir (PI_E2E_GH_STATE).
 */
export function assertEnsemble(
	piHome: string,
	repoDir: string,
	scenario: Scenario,
	opts: { parentBranch: string; minCandidates: number; ghStateDir?: string },
): EnsembleAssertion {
	const base = assertScenario(piHome, repoDir, scenario);
	let candBranches: string[] = [];
	let candidatesDone = false;
	try {
		candBranches = execSync(
			"git branch --list 'cand/*/*' --format='%(refname:short)'",
			{
				cwd: repoDir,
				encoding: "utf8",
			},
		)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		candidatesDone =
			candBranches.length > 0 &&
			candBranches.every((branch) =>
				execSync(`git log --format=%s ${JSON.stringify(branch)}`, {
					cwd: repoDir,
					encoding: "utf8",
				})
					.split("\n")
					.some((subject) => subject.startsWith("DONE:")),
			);
	} catch {
		candBranches = [];
	}
	let candidatePrCount = 0;
	let parentPrCount = 0;
	if (opts.ghStateDir) {
		try {
			const state = JSON.parse(
				readFileSync(join(opts.ghStateDir, "prs.json"), "utf8"),
			) as { prs?: { headRefName?: string }[] };
			for (const pr of state.prs ?? []) {
				if (pr.headRefName?.startsWith("cand/")) candidatePrCount += 1;
				if (pr.headRefName === opts.parentBranch) parentPrCount += 1;
			}
		} catch {
			// Missing shim state reads as zero PRs — the parent check fails.
		}
	}
	const ok =
		base.ok &&
		candBranches.length >= opts.minCandidates &&
		candidatesDone &&
		candidatePrCount === 0 &&
		parentPrCount === 1;
	const parts = [
		base.summary,
		`cand branches: ${candBranches.length ? candBranches.join(", ") : "none"}`,
		`candidates done: ${candidatesDone ? "yes" : "no"}`,
		`candidate PRs: ${candidatePrCount} (must be 0)`,
		`parent PRs (${opts.parentBranch}): ${parentPrCount} (must be 1)`,
	];
	return {
		ok,
		base,
		candBranches,
		candidatesDone,
		candidatePrCount,
		parentPrCount,
		summary: parts.join("\n"),
	};
}
