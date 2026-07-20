// Shipper — the maestro's push + PR seam for completed branch-owning nodes.
// Owns:
//   - shipNode: preflight (clean tree) → push → find/create/edit PR
//   - shipBaseBranch: stacked bases within a repo; cross-repo deps are
//     ordering-only (base falls back to the node's own repo default branch)
//   - reconcileShippedDeliverables: retarget open PRs whose stacked base merged;
//     conflicts are flagged needs-rebase, never auto-resolved
//   - cleanupWorktrees: DAG-driven retention — a terminal node's worktree is
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
// S8: TERMINAL_STATUSES has no v2 home yet — moves out of the v1 schema in S8.
import {
	defaultBranchForNode,
	deriveBase,
	isBranchOwner,
	PARENT_AFTER_TOKEN,
	type PlanNode,
	type PlanV2,
	parentOfNode,
	TERMINAL_STATUSES,
	walkNodes,
} from "../plan/schema.js";
import {
	renderMaestroPrSection,
	updateMaestroPrBody,
} from "../pr-provenance.js";
import { buildPrBody } from "../shipping.js";
import { auditBranchCommits, detectCommitPolicy } from "./commit-policy.js";

// ─── Repo resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the repo a node targets: its registry entry when it names one, else
 * the plan's default repo. Callers must not assume the path exists on disk —
 * a late-bound entry (`createdBy`) materializes during execution.
 */
export function repoForNode(
	plan: PlanV2,
	node: Pick<PlanNode, "repo">,
): { key: string; path: string } {
	if (node.repo) {
		return (
			plan.repos?.find((r) => r.key === node.repo) ?? {
				key: "default",
				path: plan.repoPath,
			}
		);
	}
	return { key: "default", path: plan.repoPath };
}

/** The node's sibling group — its parent's children, or the roots. */
function siblingsOf(plan: PlanV2, node: PlanNode): readonly PlanNode[] {
	const parent = parentOfNode(plan, node.id);
	return parent ? (parent.children ?? []) : plan.nodes;
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
 * Base branch for a node's PR. Stacked nodes base off their first sibling
 * dependency's branch — but only when that dependency lives in the same repo;
 * cross-repo `after` is ordering-only, so the base falls back to the node's
 * own repo default branch.
 */
export function shipBaseBranch(
	plan: PlanV2,
	node: PlanNode,
	defaultBranch: string,
): string {
	if (node.base === "default-branch") return defaultBranch;
	if (node.base) return node.base;
	const deps = (node.after ?? []).filter((ref) => ref !== PARENT_AFTER_TOKEN);
	if (deps.length === 0) return defaultBranch;
	const siblings = siblingsOf(plan, node);
	const parent = siblings.find((sibling) => sibling.id === deps[0]) ?? null;
	if (!parent) return defaultBranch;
	if ((parent.repo ?? "default") !== (node.repo ?? "default"))
		return defaultBranch;
	return deriveBase(node, siblings, defaultBranch);
}

// ─── shipNode ────────────────────────────────────────────────────────────────

export type ShipErrorCode =
	| "dirty-worktree"
	| "commit-policy"
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

export interface ShipNodeOpts {
	plan: PlanV2;
	node: PlanNode;
	worktreePath: string;
	/** PR-body agent reports; defaults to the node summary when present. */
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
 * Push a completed node's branch and create (or update) its PR. Never ships
 * a dirty tree; every failure is a typed, retryable result — callers decide
 * whether and when to retry, and persist prUrl/prNumber on success.
 */
export async function shipNode(opts: ShipNodeOpts): Promise<ShipResult> {
	const { plan, node, worktreePath } = opts;
	const prClient = opts.prClient ?? defaultPrClient;
	const git = opts.git ?? defaultShipGit;

	if (!git.workingTreeClean(worktreePath)) {
		return shipError(
			"dirty-worktree",
			`worktree ${worktreePath} has uncommitted changes; commit or clean it before shipping`,
		);
	}

	const branch = node.branch ?? defaultBranchForNode(node);

	const repo = repoForNode(plan, node);
	const defaultBranch = git.detectDefaultBranch(repo.path);
	if (!defaultBranch) {
		return shipError(
			"no-default-branch",
			`cannot detect the default branch of ${repo.path}`,
		);
	}
	const base = shipBaseBranch(plan, node, defaultBranch);

	// Commit-policy audit BEFORE anything leaves the machine: in a
	// conventional-commit repo a bare "Add …" subject makes semantic-release
	// run green and publish nothing. Blocked here, the branch is still local
	// and rewritable (reword/amend), and the reason explains exactly what the
	// pushed commits would have done to the release.
	const policy = detectCommitPolicy(repo.path);
	if (policy.conventional) {
		const audit = auditBranchCommits(worktreePath, base, policy);
		if (!audit.ok) {
			const offenders = audit.violations.length
				? ` Offending subjects: ${audit.violations.map((s) => `"${s}"`).join(", ")}.`
				: "";
			return shipError("commit-policy", `${audit.explanation}${offenders}`);
		}
	}

	const push = await git.pushBranch(worktreePath, branch);
	if (!push.ok) {
		return shipError(
			"push-failed",
			push.stderr.trim() || `git push exited ${push.exitCode}`,
		);
	}

	const reports = opts.agentReports ?? (node.summary ? [node.summary] : []);
	const generatedBody = buildPrBody(node, reports);

	const existing = await prClient.findOpenPr(worktreePath, branch);
	if (existing.error) return shipError("pr-failed", existing.error);
	if (existing.pr) {
		let body = generatedBody;
		if (node.workflowAnalytics) {
			try {
				body = updateMaestroPrBody(
					existing.pr.body,
					renderMaestroPrSection(node),
				);
			} catch (cause) {
				return shipError(
					"pr-failed",
					cause instanceof Error ? cause.message : String(cause),
				);
			}
		}
		const edit = await prClient.editPr(worktreePath, existing.pr.number, {
			body,
		});
		if (!edit.ok) {
			return shipError("pr-failed", edit.error ?? "gh pr edit failed");
		}
		return {
			ok: true,
			prUrl: existing.pr.url || node.prUrl || "",
			prNumber: existing.pr.number,
			base: existing.pr.baseRefName || base,
			created: false,
		};
	}

	const created = await prClient.createPr(worktreePath, {
		title: node.title ?? node.id,
		body: generatedBody,
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
	retargeted: {
		deliverableId: string;
		prNumber: number;
		from: string;
		to: string;
	}[];
	/** Retargeted PRs now conflicting — surfaced for a human, never auto-resolved. */
	needsRebase: {
		deliverableId: string;
		prNumber: number;
		base: string;
		message: string;
	}[];
	errors: { deliverableId: string; message: string }[];
}

export interface ReconcileOpts {
	plan: PlanV2;
	prClient?: PrClient;
	git?: ShipGit;
}

/** Sibling node whose branch is `branch` in the same repo as `node`, or null. */
function stackedParentByBranch(
	siblings: readonly PlanNode[],
	node: PlanNode,
	branch: string,
): PlanNode | null {
	return (
		siblings.find(
			(g) =>
				g.id !== node.id &&
				isBranchOwner(g) &&
				(g.branch ?? defaultBranchForNode(g)) === branch &&
				(g.repo ?? "default") === (node.repo ?? "default"),
		) ?? null
	);
}

/**
 * For every shipped node with an open PR based on a sibling node's branch:
 * once that sibling's PR has merged, retarget the PR to the repo default
 * branch. Conflicts after retarget are reported as needs-rebase. Pure report
 * out — plan mutation happens in the caller.
 */
export async function reconcileShippedDeliverables(
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

	for (const { node, parent } of walkNodes(plan)) {
		if (node.status !== "shipped" || node.prNumber === undefined) continue;
		const repo = repoForNode(plan, node);
		const cwd = node.worktreePath ?? repo.path;

		const view = await prClient.viewPr(cwd, node.prNumber);
		if (!view.pr) {
			if (view.error)
				report.errors.push({
					deliverableId: node.id,
					message: view.error,
				});
			continue;
		}
		if (view.pr.state !== "OPEN") continue;

		const siblings = parent ? (parent.children ?? []) : plan.nodes;
		const stackedParent = stackedParentByBranch(
			siblings,
			node,
			view.pr.baseRefName,
		);
		if (!stackedParent || stackedParent.prNumber === undefined) continue;
		const parentView = await prClient.viewPr(cwd, stackedParent.prNumber);
		if (!parentView.pr) {
			if (parentView.error)
				report.errors.push({
					deliverableId: node.id,
					message: parentView.error,
				});
			continue;
		}
		if (parentView.pr.state !== "MERGED") continue;

		const defaultBranch = git.detectDefaultBranch(repo.path);
		if (!defaultBranch) {
			report.errors.push({
				deliverableId: node.id,
				message: `cannot detect the default branch of ${repo.path}`,
			});
			continue;
		}

		const edit = await prClient.editPr(cwd, node.prNumber, {
			base: defaultBranch,
		});
		if (!edit.ok) {
			report.errors.push({
				deliverableId: node.id,
				message: edit.error ?? `retargeting PR #${node.prNumber} failed`,
			});
			continue;
		}
		report.retargeted.push({
			deliverableId: node.id,
			prNumber: node.prNumber,
			from: view.pr.baseRefName,
			to: defaultBranch,
		});

		const after = await prClient.viewPr(cwd, node.prNumber);
		if (after.pr?.mergeable === "CONFLICTING") {
			report.needsRebase.push({
				deliverableId: node.id,
				prNumber: node.prNumber,
				base: defaultBranch,
				message: `PR #${node.prNumber} conflicts with ${defaultBranch} after retarget — rebase required`,
			});
		}
	}

	return report;
}

// ─── DAG-driven worktree cleanup ─────────────────────────────────────────────

export interface CleanupReport {
	removed: { deliverableId: string; path: string }[];
	retained: { deliverableId: string; path: string; reason: string }[];
}

export interface CleanupOpts {
	plan: PlanV2;
	git?: ShipGit;
}

/**
 * Remove worktrees the DAG no longer needs: a terminal (shipped/superseded/
 * abandoned) node's worktree is removable only when no dependent node is
 * unshipped — unshipped dependents may still need it for stacking or rebase.
 * Active worktrees are not candidates. Never forces removal, so a dirty
 * worktree is retained with its reason. Pure report out — callers clear
 * worktreePath on the plan.
 */
export function cleanupWorktrees(opts: CleanupOpts): CleanupReport {
	const { plan } = opts;
	const git = opts.git ?? defaultShipGit;
	const report: CleanupReport = { removed: [], retained: [] };

	for (const { node, parent } of walkNodes(plan)) {
		const path = node.worktreePath;
		if (!path) continue;
		if (!TERMINAL_STATUSES.includes(node.status)) continue;
		// Scratch workspaces are plain dirs under the plan dir, not git
		// worktrees — they persist (artifacts may be read later).
		if (!isBranchOwner(node)) continue;

		const siblings = parent ? (parent.children ?? []) : plan.nodes;
		const blocker = siblings.find(
			(g) =>
				(g.after ?? []).includes(node.id) &&
				!TERMINAL_STATUSES.includes(g.status),
		);
		if (blocker) {
			report.retained.push({
				deliverableId: node.id,
				path,
				reason: `dependent \`${blocker.id}\` is ${blocker.status} and may need it for stacking/rebase`,
			});
			continue;
		}

		const repo = repoForNode(plan, node);
		const removed = git.removeWorktree(repo.path, path);
		if (removed.ok) {
			report.removed.push({ deliverableId: node.id, path });
		} else {
			report.retained.push({
				deliverableId: node.id,
				path,
				reason: removed.error,
			});
		}
	}

	return report;
}
