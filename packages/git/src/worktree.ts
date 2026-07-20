// Worktree mechanics + the reserved path scheme. This package owns the
// *mechanics* (add/remove/list, path computation); the modes package owns the
// *lifecycle* (which deliverable maps to which branch/worktree, when to prune).
// Decoupled from any plan type — callers pass repo path, branch, and target.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RunId } from "@vegardx/pi-contracts";
import { branchExists } from "./branch.js";
import { mergeBase, repoNameFromPath, revParse } from "./repo.js";
import { runCommand } from "./shell.js";

/**
 * Root for all maestro worktrees, a sibling of the repo:
 *   <parent-of-repo>/worktrees/<repo-name>/
 */
export function worktreesRoot(repoPath: string): string {
	const repo = resolve(repoPath);
	return join(dirname(repo), "worktrees", repoNameFromPath(repo));
}

/** Worktree path for a named segment under the repo's worktrees root. */
export function worktreePathFor(
	repoPath: string,
	...segments: string[]
): string {
	return join(worktreesRoot(repoPath), ...segments);
}

/**
 * Reserved path for a background agent run:
 *   <parent-of-repo>/worktrees/<repo-name>/_agents/<runId>/
 * The `_agents` segment keeps ephemeral agent worktrees from colliding with
 * deliverable worktrees the modes lifecycle manages by branch name.
 */
export function agentWorktreePath(repoPath: string, runId: RunId): string {
	return worktreePathFor(repoPath, "_agents", runId);
}

export interface WorktreeEntry {
	path: string;
	branch?: string;
	head?: string;
	detached?: boolean;
}

/** Parse `git worktree list --porcelain` output. Pure — exported for tests. */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | null = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = { path: line.slice("worktree ".length).trim() };
		} else if (current && line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length).trim();
		} else if (current && line.startsWith("branch ")) {
			const ref = line.slice("branch ".length).trim();
			current.branch = ref.replace(/^refs\/heads\//, "");
		} else if (current && line.trim() === "detached") {
			current.detached = true;
		}
	}
	if (current) entries.push(current);
	return entries;
}

export function listWorktrees(repoPath: string): WorktreeEntry[] {
	const r = runCommand("git", ["worktree", "list", "--porcelain"], {
		cwd: repoPath,
	});
	return r.ok ? parseWorktreeList(r.stdout) : [];
}

/** Existing worktree path where `branch` is checked out, or null. */
export function findCheckoutOf(
	repoPath: string,
	branch: string,
): string | null {
	for (const entry of listWorktrees(repoPath)) {
		if (entry.branch === branch) return entry.path;
	}
	return null;
}

export type WorktreeAddResult =
	| { ok: true; path: string; created: boolean }
	| { ok: false; error: string };

/**
 * Add a worktree for `branch` at `targetPath`, creating the branch from
 * `baseBranch` when it doesn't yet exist. If the branch is already checked out
 * somewhere (commonly the main repo), reuse that path — git refuses to check
 * out the same branch twice. `created: false` means an existing checkout was
 * reused and no `git worktree add` ran.
 */
export function addWorktree(
	repoPath: string,
	targetPath: string,
	branch: string,
	baseBranch: string,
): WorktreeAddResult {
	const repo = resolve(repoPath);
	const target = resolve(targetPath);

	const existing = findCheckoutOf(repo, branch);
	if (existing) return { ok: true, path: existing, created: false };
	if (existsSync(target)) return { ok: true, path: target, created: false };

	const parent = dirname(target);
	if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

	let args: string[];
	if (branchExists(repo, branch)) {
		args = ["worktree", "add", target, branch];
	} else {
		// The base may exist only as a remote-tracking ref — e.g. origin's
		// default branch changed and was fetched, but no local branch tracks
		// it. Resolve local → origin/<base> → clear error, instead of handing
		// git a name it can't resolve ("fatal: invalid reference").
		const base = resolveBaseRef(repo, baseBranch);
		if (!base) {
			return {
				ok: false,
				error:
					`base branch "${baseBranch}" not found — no local branch and no ` +
					`origin/${baseBranch}. Fetch the remote or pick an existing base.`,
			};
		}
		args = ["worktree", "add", "-b", branch, target, base];
	}

	const result = runCommand("git", args, { cwd: repo });
	if (!result.ok) {
		return {
			ok: false,
			error: `git worktree add failed: ${result.stderr.trim() || "unknown error"}`,
		};
	}
	return { ok: true, path: target, created: true };
}

/**
 * The commit a delivery branch's worktree is (or would be) based on — the
 * counterpart of {@link addWorktree}'s branch-creation rule, NOT the main
 * checkout's HEAD (which may sit on an unrelated branch: stacked deliverables
 * base on a sibling's feat branch, and the user's checkout moves freely).
 *
 * - Branch doesn't exist yet: the resolved base ref's tip — exactly what
 *   `git worktree add -b <branch> <target> <base>` will branch from.
 * - Branch already exists (reuse): the fork point, `merge-base(base, branch)`
 *   — its recorded tip may have advanced past the true base.
 * - Null when neither resolves; callers fall back or fail loudly.
 */
export function worktreeBaseSha(
	repoPath: string,
	branch: string,
	baseBranch: string,
): string | null {
	const repo = resolve(repoPath);
	const base = resolveBaseRef(repo, baseBranch);
	if (branchExists(repo, branch)) {
		return base ? mergeBase(repo, base, branch) : null;
	}
	return base ? revParse(repo, base) : null;
}

/**
 * Resolve a base branch name to a ref `git worktree add` can use: the local
 * branch if it exists, else the remote-tracking `origin/<name>` (which also
 * sets up branch tracking), else null.
 */
function resolveBaseRef(repo: string, baseBranch: string): string | null {
	if (branchExists(repo, baseBranch)) return baseBranch;
	const remote = runCommand(
		"git",
		["show-ref", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`],
		{ cwd: repo },
	);
	if (remote.ok) return `origin/${baseBranch}`;
	return null;
}

export type WorktreeRemoveResult =
	| { ok: true }
	| { ok: false; error: string; reason?: "dirty" | "main" | "git" };

/**
 * Remove a worktree. Refuses the main worktree (git rejects it; we surface a
 * friendlier message) and refuses a dirty worktree unless `force`. Never
 * deletes branches.
 */
export function removeWorktree(
	repoPath: string,
	targetPath: string,
	opts: { force?: boolean } = {},
): WorktreeRemoveResult {
	const repo = resolve(repoPath);
	const target = resolve(targetPath);
	if (!existsSync(target)) return { ok: true };

	if (target === repo) {
		return {
			ok: false,
			error: `${target} is the main worktree; switch branches instead of pruning`,
			reason: "main",
		};
	}

	if (!opts.force) {
		const status = runCommand("git", ["status", "--porcelain"], {
			cwd: target,
		});
		if (status.ok && status.stdout.trim().length > 0) {
			return {
				ok: false,
				error: `worktree ${target} has uncommitted changes`,
				reason: "dirty",
			};
		}
	}

	const args = ["worktree", "remove"];
	if (opts.force) args.push("--force");
	args.push(target);
	const result = runCommand("git", args, { cwd: repo });
	if (!result.ok) {
		return {
			ok: false,
			error: `git worktree remove failed: ${result.stderr.trim()}`,
			reason: "git",
		};
	}
	return { ok: true };
}
