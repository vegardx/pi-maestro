// Shipper — the maestro's push + PR seam for completed groups. Owns:
//   - shipGroup: preflight (clean tree) → push → find/create/edit PR
//   - shipBaseBranch: stacked bases within a repo; cross-repo deps are
//     ordering-only (base falls back to the group's own repo default branch)
//   - reconcileShippedGroups: retarget open PRs whose stacked base merged;
//     conflicts are flagged needs-rebase, never auto-resolved
//   - cleanupWorktrees: DAG-driven retention — a terminal group's worktree is
//     removable only once no dependent is unshipped
//
// Self-contained: no plan mutation, no engine access. Callers persist results
// (prUrl/prNumber → shipped, worktreePath cleared) and decide retries.

import {
	detectDefaultBranch,
	pushBranch,
	removeWorktree,
	type ShellResult,
	type WorktreeRemoveResult,
	workingTreeClean,
} from "@vegardx/pi-git";
import {
	createPr,
	editPr,
	findOpenPr,
	type PrResult,
	viewPr,
} from "@vegardx/pi-github";
import {
	DEFAULT_REPO_KEY,
	defaultBranchForGroup,
	findGroup,
	type Plan,
	type PlanRepo,
	pickBaseBranch,
	TERMINAL_STATUSES,
	type WorkGroup,
} from "../schema.js";
import { buildPrBody } from "../shipping.js";

// ─── Repo resolution ─────────────────────────────────────────────────────────

/**
 * Registry key of the repo a group targets. The `repo` field is reserved on
 * WorkGroup per docs/multi-repo-plans.md; read loosely until schema lands it.
 */
export function groupRepoKey(group: WorkGroup): string {
	return (group as WorkGroup & { repo?: string }).repo ?? DEFAULT_REPO_KEY;
}

/**
 * Resolve the repo a group targets: its registry entry when it names one,
 * else the plan's default repo.
 */
export function repoFor(
	plan: Pick<Plan, "repoPath" | "repos">,
	group: WorkGroup,
): PlanRepo {
	const key = groupRepoKey(group);
	const entry = plan.repos?.find((r) => r.key === key);
	return entry ?? { key: DEFAULT_REPO_KEY, path: plan.repoPath };
}

// ─── Injectable seams ────────────────────────────────────────────────────────

/** PR operations the shipper needs, shaped after @vegardx/pi-github. */
export interface PrClient {
	findOpenPr(cwd: string, branch: string): Promise<PrResult>;
	viewPr(cwd: string, number: number): Promise<PrResult>;
	createPr(
		cwd: string,
		args: { title: string; body: string; base?: string },
	): Promise<{ url: string | null; error?: string }>;
	editPr(
		cwd: string,
		number: number,
		args: { title?: string; body?: string; base?: string },
	): Promise<{ ok: boolean; error?: string }>;
}

export const defaultPrClient: PrClient = {
	findOpenPr: (cwd, branch) => findOpenPr(cwd, branch),
	viewPr: (cwd, number) => viewPr(cwd, number),
	createPr: (cwd, args) => createPr(cwd, args),
	editPr: (cwd, number, args) => editPr(cwd, number, args),
};

/** Git operations the shipper needs, shaped after @vegardx/pi-git. */
export interface ShipGit {
	workingTreeClean(cwd: string): boolean;
	detectDefaultBranch(cwd: string): string | null;
	pushBranch(cwd: string, branch: string): Promise<ShellResult>;
	removeWorktree(repoPath: string, targetPath: string): WorktreeRemoveResult;
}

export const defaultShipGit: ShipGit = {
	workingTreeClean,
	detectDefaultBranch,
	pushBranch: (cwd, branch) => pushBranch(cwd, branch),
	removeWorktree: (repoPath, targetPath) =>
		removeWorktree(repoPath, targetPath),
};

// ─── Base resolution ─────────────────────────────────────────────────────────

/**
 * Base branch for a group's PR. Stacked groups base off their first
 * dependency's branch — but only when that dependency lives in the same repo;
 * cross-repo dependsOn is ordering-only, so the base falls back to the
 * group's own repo default branch.
 */
export function shipBaseBranch(
	plan: Pick<Plan, "groups" | "repoPath" | "repos">,
	group: WorkGroup,
	defaultBranch: string,
): string {
	const deps = group.dependsOn ?? [];
	if (deps.length === 0 || group.stacked === false) return defaultBranch;
	const parent = findGroup(plan, deps[0]);
	if (!parent) return defaultBranch;
	if (groupRepoKey(parent) !== groupRepoKey(group)) return defaultBranch;
	return pickBaseBranch(plan, group, defaultBranch);
}

// ─── shipGroup ───────────────────────────────────────────────────────────────

export type ShipErrorCode =
	| "dirty-worktree"
	| "no-default-branch"
	| "push-failed"
	| "pr-failed";

export type ShipResult =
	| {
			ok: true;
			prUrl: string;
			prNumber: number;
			base: string;
			/** True when a new PR was created; false when an open one was updated. */
			created: boolean;
	  }
	| { ok: false; code: ShipErrorCode; message: string; retryable: boolean };

export interface ShipGroupOpts {
	plan: Plan;
	group: WorkGroup;
	worktreePath: string;
	/** PR-body agent reports; defaults to the group summary when present. */
	agentReports?: string[];
	prClient?: PrClient;
	git?: ShipGit;
}

/** PR number from a GitHub PR URL, or null. Pure — exported for tests. */
export function prNumberFromUrl(url: string): number | null {
	const match = url.match(/\/pull\/(\d+)\b/);
	return match ? Number(match[1]) : null;
}

function shipError(code: ShipErrorCode, message: string): ShipResult {
	return { ok: false, code, message, retryable: true };
}

/**
 * Push a completed group's branch and create (or update) its PR. Never ships
 * a dirty tree; every failure is a typed, retryable result — callers decide
 * whether and when to retry, and persist prUrl/prNumber on success.
 */
export async function shipGroup(opts: ShipGroupOpts): Promise<ShipResult> {
	const { plan, group, worktreePath } = opts;
	const prClient = opts.prClient ?? defaultPrClient;
	const git = opts.git ?? defaultShipGit;

	if (!git.workingTreeClean(worktreePath)) {
		return shipError(
			"dirty-worktree",
			`worktree ${worktreePath} has uncommitted changes; commit or clean it before shipping`,
		);
	}

	const branch = group.branch ?? defaultBranchForGroup(group);
	const push = await git.pushBranch(worktreePath, branch);
	if (!push.ok) {
		return shipError(
			"push-failed",
			push.stderr.trim() || `git push exited ${push.exitCode}`,
		);
	}

	const repo = repoFor(plan, group);
	const defaultBranch =
		repo.defaultBranch ?? git.detectDefaultBranch(repo.path);
	if (!defaultBranch) {
		return shipError(
			"no-default-branch",
			`cannot detect the default branch of ${repo.path}`,
		);
	}
	const base = shipBaseBranch(plan, group, defaultBranch);

	const reports = opts.agentReports ?? (group.summary ? [group.summary] : []);
	const body = buildPrBody(group, reports);

	const existing = await prClient.findOpenPr(worktreePath, branch);
	if (existing.error) return shipError("pr-failed", existing.error);
	if (existing.pr) {
		const edit = await prClient.editPr(worktreePath, existing.pr.number, {
			body,
		});
		if (!edit.ok) {
			return shipError("pr-failed", edit.error ?? "gh pr edit failed");
		}
		return {
			ok: true,
			prUrl: existing.pr.url || group.prUrl || "",
			prNumber: existing.pr.number,
			base: existing.pr.baseRefName || base,
			created: false,
		};
	}

	const created = await prClient.createPr(worktreePath, {
		title: group.title,
		body,
		base,
	});
	if (!created.url) {
		return shipError(
			"pr-failed",
			created.error ?? "gh pr create returned no URL",
		);
	}
	const prNumber = prNumberFromUrl(created.url);
	if (prNumber === null) {
		return shipError(
			"pr-failed",
			`cannot parse a PR number from ${created.url}`,
		);
	}
	return { ok: true, prUrl: created.url, prNumber, base, created: true };
}

// ─── Retarget / reconcile ────────────────────────────────────────────────────

export interface ReconcileReport {
	/** PRs whose base branch merged, retargeted to the repo default branch. */
	retargeted: { groupId: string; prNumber: number; from: string; to: string }[];
	/** Retargeted PRs now conflicting — surfaced for a human, never auto-resolved. */
	needsRebase: {
		groupId: string;
		prNumber: number;
		base: string;
		message: string;
	}[];
	errors: { groupId: string; message: string }[];
}

export interface ReconcileOpts {
	plan: Plan;
	prClient?: PrClient;
	git?: ShipGit;
}

/** Group whose branch is `branch` in the same repo as `group`, or null. */
function stackedParentByBranch(
	plan: Plan,
	group: WorkGroup,
	branch: string,
): WorkGroup | null {
	return (
		plan.groups.find(
			(g) =>
				g.id !== group.id &&
				(g.branch ?? defaultBranchForGroup(g)) === branch &&
				groupRepoKey(g) === groupRepoKey(group),
		) ?? null
	);
}

/**
 * For every shipped group with an open PR based on a sibling group's branch:
 * once that sibling's PR has merged, retarget the PR to the repo default
 * branch. Conflicts after retarget are reported as needs-rebase. Pure report
 * out — plan mutation happens in the caller.
 */
export async function reconcileShippedGroups(
	opts: ReconcileOpts,
): Promise<ReconcileReport> {
	const { plan } = opts;
	const prClient = opts.prClient ?? defaultPrClient;
	const git = opts.git ?? defaultShipGit;
	const report: ReconcileReport = {
		retargeted: [],
		needsRebase: [],
		errors: [],
	};

	for (const group of plan.groups) {
		if (group.status !== "shipped" || group.prNumber === undefined) continue;
		const repo = repoFor(plan, group);
		const cwd = group.worktreePath ?? repo.path;

		const view = await prClient.viewPr(cwd, group.prNumber);
		if (!view.pr) {
			if (view.error)
				report.errors.push({ groupId: group.id, message: view.error });
			continue;
		}
		if (view.pr.state !== "OPEN") continue;

		const parent = stackedParentByBranch(plan, group, view.pr.baseRefName);
		if (!parent || parent.prNumber === undefined) continue;
		const parentView = await prClient.viewPr(cwd, parent.prNumber);
		if (!parentView.pr) {
			if (parentView.error)
				report.errors.push({ groupId: group.id, message: parentView.error });
			continue;
		}
		if (parentView.pr.state !== "MERGED") continue;

		const defaultBranch =
			repo.defaultBranch ?? git.detectDefaultBranch(repo.path);
		if (!defaultBranch) {
			report.errors.push({
				groupId: group.id,
				message: `cannot detect the default branch of ${repo.path}`,
			});
			continue;
		}

		const edit = await prClient.editPr(cwd, group.prNumber, {
			base: defaultBranch,
		});
		if (!edit.ok) {
			report.errors.push({
				groupId: group.id,
				message: edit.error ?? `retargeting PR #${group.prNumber} failed`,
			});
			continue;
		}
		report.retargeted.push({
			groupId: group.id,
			prNumber: group.prNumber,
			from: view.pr.baseRefName,
			to: defaultBranch,
		});

		const after = await prClient.viewPr(cwd, group.prNumber);
		if (after.pr?.mergeable === "CONFLICTING") {
			report.needsRebase.push({
				groupId: group.id,
				prNumber: group.prNumber,
				base: defaultBranch,
				message: `PR #${group.prNumber} conflicts with ${defaultBranch} after retarget — rebase required`,
			});
		}
	}

	return report;
}

// ─── DAG-driven worktree cleanup ─────────────────────────────────────────────

export interface CleanupReport {
	removed: { groupId: string; path: string }[];
	retained: { groupId: string; path: string; reason: string }[];
}

export interface CleanupOpts {
	plan: Plan;
	git?: ShipGit;
}

/**
 * Remove worktrees the DAG no longer needs: a terminal (shipped/superseded/
 * abandoned) group's worktree is removable only when no dependent group is
 * unshipped — unshipped dependents may still need it for stacking or rebase.
 * Active worktrees are not candidates. Never forces removal, so a dirty
 * worktree is retained with its reason. Pure report out — callers clear
 * worktreePath on the plan.
 */
export function cleanupWorktrees(opts: CleanupOpts): CleanupReport {
	const { plan } = opts;
	const git = opts.git ?? defaultShipGit;
	const report: CleanupReport = { removed: [], retained: [] };

	for (const group of plan.groups) {
		const path = group.worktreePath;
		if (!path) continue;
		if (!TERMINAL_STATUSES.includes(group.status)) continue;

		const blocker = plan.groups.find(
			(g) =>
				(g.dependsOn ?? []).includes(group.id) &&
				!TERMINAL_STATUSES.includes(g.status),
		);
		if (blocker) {
			report.retained.push({
				groupId: group.id,
				path,
				reason: `dependent \`${blocker.id}\` is ${blocker.status} and may need it for stacking/rebase`,
			});
			continue;
		}

		const repo = repoFor(plan, group);
		const removed = git.removeWorktree(repo.path, path);
		if (removed.ok) {
			report.removed.push({ groupId: group.id, path });
		} else {
			report.retained.push({ groupId: group.id, path, reason: removed.error });
		}
	}

	return report;
}
