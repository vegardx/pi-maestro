// White-box outcome assertions. Per the research verdict, a full-stack run is
// validated by inspecting real program state — the persisted plan and the git
// repo — NOT by scraping the agent's transcript. These read the maestro's
// plan.json (deliverable statuses, PR URLs) and the git history (shipped files),
// independent of how the run was driven.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExpectedDeliverable, Scenario } from "./scenario.js";

/** A deliverable as persisted in plan.json (only the fields we assert on). */
interface PersistedDeliverable {
	readonly title: string;
	readonly status: string;
	readonly prUrl?: string;
	readonly branch?: string;
	readonly baseSha?: string;
	readonly stacked?: boolean;
	readonly worker?: { readonly model?: string };
}

interface PersistedPlan {
	readonly deliverables?: PersistedDeliverable[];
}

/** Statuses that count as "the deliverable landed". */
const SHIPPED_STATUSES = new Set(["shipped"]);

export function planJsonPath(piHome: string, slug: string): string {
	return join(piHome, ".pi", "agent", "maestro", "plans", slug, "plan.json");
}

export function readPlan(piHome: string, slug: string): PersistedPlan | null {
	const path = planJsonPath(piHome, slug);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PersistedPlan;
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
	const deliverables = plan.deliverables ?? [];
	const tracked = new Set(gitTrackedFilesAllBranches(repoDir));
	const checks = scenario.expected.map((exp) =>
		checkDeliverable(exp, deliverables, tracked, repoDir),
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
	deliverables: PersistedDeliverable[],
	tracked: Set<string>,
	repoDir: string,
): DeliverableCheck {
	const match = deliverables.find((d) =>
		d.title.toLowerCase().includes(exp.titleMatch.toLowerCase()),
	);
	const missingFiles = exp.files.filter((f) => !tracked.has(f));
	return {
		titleMatch: exp.titleMatch,
		matched: match !== undefined,
		status: match?.status,
		shipped: match ? SHIPPED_STATUSES.has(match.status) : false,
		hasPr: Boolean(match?.prUrl),
		missingFiles,
		modelPinned: Boolean(match?.worker?.model),
		baseOk: match ? stackedBaseOk(match, repoDir) : false,
	};
}

/**
 * Fix #249's live check: a stacked deliverable's base is the tip of the
 * branch it stacks on, which contains commits beyond main — so its recorded
 * baseSha must NOT be reachable from the seed `main`. (PRs are never merged
 * into the local main during a drive, so main still points at the seed.)
 */
function stackedBaseOk(d: PersistedDeliverable, repoDir: string): boolean {
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
