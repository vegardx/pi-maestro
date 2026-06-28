// Repository queries — read-only inspection of a git working tree.

import { basename, resolve } from "node:path";
import { runCommand } from "./shell.js";

/** Basename of a repo path, used in the worktree path scheme. */
export function repoNameFromPath(repoPath: string): string {
	return basename(resolve(repoPath));
}

/** True if cwd is inside a git working tree. */
export function isGitRepo(cwd: string): boolean {
	return runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd }).ok;
}

/** Absolute root of the working tree containing cwd, or null when not a repo. */
export function gitToplevel(cwd: string): string | null {
	const r = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
	return r.ok ? r.stdout.trim() || null : null;
}

/** Current branch, or null on detached HEAD / bare repo. */
export function currentBranch(cwd: string): string | null {
	const r = runCommand("git", ["branch", "--show-current"], { cwd });
	if (!r.ok) return null;
	const trimmed = r.stdout.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the default branch from origin/HEAD, falling back to main → master
 * remote-ref existence. Returns null if neither pins down a branch.
 */
export function detectDefaultBranch(cwd: string): string | null {
	const head = runCommand("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
		cwd,
	});
	if (head.ok) {
		const match = head.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
		if (match?.[1]) return match[1];
	}
	for (const candidate of ["main", "master"]) {
		const exists = runCommand(
			"git",
			["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
			{ cwd },
		);
		if (exists.ok) return candidate;
	}
	return null;
}

/** Working tree + index status via --porcelain. Empty string = clean. */
export function statusPorcelain(cwd: string): string {
	const r = runCommand("git", ["status", "--porcelain"], { cwd });
	return r.ok ? r.stdout : "";
}

export function workingTreeClean(cwd: string): boolean {
	return statusPorcelain(cwd).trim().length === 0;
}

export function hasChanges(cwd: string): boolean {
	return statusPorcelain(cwd).trim().length > 0;
}

export function headSha(cwd: string): string | null {
	const r = runCommand("git", ["rev-parse", "HEAD"], { cwd });
	return r.ok ? r.stdout.trim() || null : null;
}

export function originUrl(cwd: string): string | null {
	const r = runCommand("git", ["remote", "get-url", "origin"], { cwd });
	if (!r.ok) return null;
	return r.stdout.trim() || null;
}

/** `git rev-parse --verify --quiet <ref>` — true when ref resolves. */
export function refExists(cwd: string, ref: string): boolean {
	return runCommand("git", ["rev-parse", "--verify", "--quiet", ref], { cwd })
		.ok;
}

/** True when HEAD is a descendant of ref (a fast-forward push is safe). */
export function isAncestor(cwd: string, ref: string): boolean {
	return runCommand("git", ["merge-base", "--is-ancestor", ref, "HEAD"], {
		cwd,
	}).ok;
}

/** Shared ancestor SHA of two refs, or null. */
export function mergeBase(cwd: string, a: string, b: string): string | null {
	const r = runCommand("git", ["merge-base", a, b], { cwd });
	return r.ok ? r.stdout.trim() || null : null;
}
