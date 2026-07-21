// Git committer identity, resolved once at the harness and carried to agents
// as process environment.
//
// Why this exists: a linked worktree does NOT get its own config. `git config
// user.email x` run inside a worktree writes to the SHARED repository config —
// the developer's real `<repo>/.git/config`. So an agent that "sets identity
// repo-locally, in its own worktree" silently re-authors the developer's
// checkout. Identity is therefore resolved here, from whatever the developer
// already configured (global, repo-local, or an includeIf conditional), and
// handed to agents through GIT_AUTHOR_*/GIT_COMMITTER_*, which take precedence
// over config and touch no file on disk.

import { runCommand } from "./shell.js";

export interface GitIdentity {
	readonly name: string;
	readonly email: string;
}

function configValue(repoPath: string, key: string): string | undefined {
	const result = runCommand("git", ["config", "--get", key], { cwd: repoPath });
	if (!result.ok) return undefined;
	const value = result.stdout.trim();
	return value.length > 0 ? value : undefined;
}

/**
 * The identity git itself would use for a commit in `repoPath`.
 *
 * Environment first, then git's own precedence chain (system, global,
 * repo-local, includeIf) — because that is git's real order, and because
 * the GIT_AUTHOR and GIT_COMMITTER variables are the mechanism THIS MODULE
 * hands to agents.
 * Checking only `git config` made the check disagree with its own remedy: an
 * outer harness that had already supplied the identity as env was told none
 * was configured. A live drive died on exactly that — the e2e driver runs the
 * maestro with an isolated HOME, so `~/.gitconfig` and any `includeIf` are
 * invisible, and every worker refused to spawn.
 *
 * Null when neither source has both halves — the caller must surface that
 * rather than invent one.
 */
export function resolveGitIdentity(repoPath: string): GitIdentity | null {
	const envName = process.env.GIT_AUTHOR_NAME ?? process.env.GIT_COMMITTER_NAME;
	const envEmail =
		process.env.GIT_AUTHOR_EMAIL ?? process.env.GIT_COMMITTER_EMAIL;
	if (envName && envEmail) return { name: envName, email: envEmail };

	const name = configValue(repoPath, "user.name");
	const email = configValue(repoPath, "user.email");
	return name && email ? { name, email } : null;
}

/**
 * The env an agent process needs to commit as the developer. Both AUTHOR and
 * COMMITTER are set: git falls back to config (and then to its hostname guess)
 * for whichever is missing, which is how a half-set identity slips through.
 */
export function gitIdentityEnv(identity: GitIdentity): Record<string, string> {
	return {
		GIT_AUTHOR_NAME: identity.name,
		GIT_AUTHOR_EMAIL: identity.email,
		GIT_COMMITTER_NAME: identity.name,
		GIT_COMMITTER_EMAIL: identity.email,
	};
}

/**
 * Operator-facing message for the no-identity case. Names the fix as a global
 * one deliberately: the harness must never write it, and a repo-local write
 * from an agent's worktree would land in the developer's shared config.
 */
export function missingIdentityMessage(repoPath: string): string {
	return (
		`no git identity is configured for ${repoPath} — agents would commit ` +
		`as git's hostname guess, or invent one. Set yours:\n` +
		`  git config --global user.name "Your Name"\n` +
		`  git config --global user.email "you@example.com"\n` +
		`The harness never writes git config on your behalf.`
	);
}
