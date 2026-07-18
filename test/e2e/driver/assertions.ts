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
		checkDeliverable(exp, deliverables, tracked),
	);
	const ok = checks.every(
		(c) => c.matched && c.shipped && c.hasPr && c.missingFiles.length === 0,
	);
	return { ok, planFound: true, checks, summary: renderSummary(checks) };
}

function checkDeliverable(
	exp: ExpectedDeliverable,
	deliverables: PersistedDeliverable[],
	tracked: Set<string>,
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
	};
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
			const mark =
				c.shipped && c.hasPr && c.missingFiles.length === 0 ? "✓" : "✗";
			return `${mark} ${c.titleMatch}: ${parts.join("; ")}`;
		})
		.join("\n");
}
