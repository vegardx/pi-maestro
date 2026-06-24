// Multi-host routing. The host is derived from the repo's origin remote; for
// operations on the current repo, gh auto-detects it (no flag). For a different
// repo we pass `-R host/owner/repo`. See the gh skill's routing rules.

import { originUrl } from "@vegardx/pi-git";

export interface RepoSlug {
	host: string;
	owner: string;
	repo: string;
}

/**
 * Parse a git remote URL into host/owner/repo. Handles scp-style ssh
 * (`git@host:owner/repo.git`), `ssh://`, and `https://` (with optional
 * userinfo). Returns null for anything that doesn't yield all three parts.
 */
export function parseRemoteUrl(url: string): RepoSlug | null {
	const trimmed = url.trim().replace(/\.git$/, "");
	if (!trimmed) return null;

	// scp-style: [user@]host:owner/repo
	const scp = trimmed.match(/^(?:[^@]+@)?([^/:]+):([^/]+)\/(.+)$/);
	if (scp && !trimmed.includes("://")) {
		const [, host, owner, repo] = scp;
		return { host, owner, repo };
	}

	// URL form: scheme://[user@]host[:port]/owner/repo
	try {
		const u = new URL(trimmed);
		const segments = u.pathname.replace(/^\//, "").split("/");
		if (segments.length < 2) return null;
		const owner = segments[0];
		const repo = segments.slice(1).join("/");
		if (!u.hostname || !owner || !repo) return null;
		return { host: u.hostname, owner, repo };
	} catch {
		return null;
	}
}

/** Resolve the current repo's slug from its origin remote, or null. */
export function repoSlug(cwd: string): RepoSlug | null {
	const url = originUrl(cwd);
	return url ? parseRemoteUrl(url) : null;
}

/** The host of the current repo, or null. */
export function detectHost(cwd: string): string | null {
	return repoSlug(cwd)?.host ?? null;
}

/**
 * Routing args for a gh subcommand. Empty for the current repo (gh detects the
 * host from origin); `["-R", "host/owner/repo"]` when targeting another repo.
 */
export function targetArgs(target?: RepoSlug): string[] {
	if (!target) return [];
	return ["-R", `${target.host}/${target.owner}/${target.repo}`];
}
