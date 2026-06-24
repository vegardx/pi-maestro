// Default-branch and branch-protection discovery. The repo convention: never
// push directly to a protected branch — always open a PR. These helpers let
// callers check before acting.

import { runCommandAsync } from "@vegardx/pi-git";
import { type RepoSlug, repoSlug } from "./host.js";

export function parseDefaultBranch(raw: string): string | null {
	try {
		const obj = JSON.parse(raw) as { defaultBranchRef?: { name?: string } };
		return obj.defaultBranchRef?.name ?? null;
	} catch {
		return null;
	}
}

/** Default branch via `gh repo view --json defaultBranchRef`. */
export async function defaultBranch(
	cwd: string,
	opts: { target?: RepoSlug; signal?: AbortSignal } = {},
): Promise<string | null> {
	const args = ["repo", "view", "--json", "defaultBranchRef"];
	if (opts.target) {
		args.push(`${opts.target.host}/${opts.target.owner}/${opts.target.repo}`);
	}
	const r = await runCommandAsync("gh", args, { cwd, signal: opts.signal });
	return r.ok ? parseDefaultBranch(r.stdout) : null;
}

export interface BranchProtection {
	/** Rule types active on the branch (e.g. "pull_request", "non_fast_forward"). */
	rules: string[];
	/** A pull-request rule applies — direct pushes are rejected. */
	requiresPullRequest: boolean;
	/** A non-fast-forward rule applies — force-pushes are rejected. */
	blocksForcePush: boolean;
	/** Any rule at all applies. */
	protected: boolean;
}

/** Parse `gh api repos/{owner}/{repo}/rules/branches/{branch}` (rules array). */
export function parseBranchProtection(raw: string): BranchProtection {
	let arr: unknown;
	try {
		arr = JSON.parse(raw);
	} catch {
		return {
			rules: [],
			requiresPullRequest: false,
			blocksForcePush: false,
			protected: false,
		};
	}
	const rules: string[] = [];
	if (Array.isArray(arr)) {
		for (const item of arr) {
			const type = (item as { type?: string }).type;
			if (typeof type === "string") rules.push(type);
		}
	}
	return {
		rules,
		requiresPullRequest: rules.includes("pull_request"),
		blocksForcePush: rules.includes("non_fast_forward"),
		protected: rules.length > 0,
	};
}

/**
 * Discover branch-protection rules for `branch`. Returns null only when the
 * repo slug can't be resolved or gh fails outright; an unprotected branch
 * returns an all-false BranchProtection.
 */
export async function getBranchProtection(
	cwd: string,
	branch: string,
	opts: { target?: RepoSlug; signal?: AbortSignal } = {},
): Promise<BranchProtection | null> {
	const slug = opts.target ?? repoSlug(cwd);
	if (!slug) return null;
	const args = [
		"api",
		`repos/${slug.owner}/${slug.repo}/rules/branches/${branch}`,
	];
	if (opts.target) args.push("--hostname", opts.target.host);
	const r = await runCommandAsync("gh", args, { cwd, signal: opts.signal });
	if (!r.ok && !r.stdout.trim()) return null;
	return parseBranchProtection(r.stdout);
}
