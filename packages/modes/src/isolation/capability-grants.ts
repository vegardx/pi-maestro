// The capability grant table — the policy half of "the OS enforces, we explain"
// (design: memory project-capability-policy-design, 2026-07-21). Default-DENY
// per (actor × capability); a WRITE capability is always SCOPED. Grants compile
// to a native sandbox filesystem profile (allowWrite paths) that the spawner
// applies to the REAL tree, so a bash-classifier miss stops being an escape —
// the kernel denies the write. Hack lifts every restriction, globally.
//
// This module is pure policy: it names WHERE each actor may write and compiles
// that to concrete allow/deny path lists. Applying the profile (seatbelt /
// sandbox-runtime) and picking the paths for a live spawn live elsewhere.

import { join } from "node:path";
import type { ModeName } from "@vegardx/pi-contracts";
import type { BashActor } from "../bash-policy.js";

/**
 * Where an actor may write.
 * - `none`   — no repo writes at all (private scratch only).
 * - `workspace` — the agent's own worktree.
 * - `repo`   — the whole checkout.
 * - `host`   — unrestricted (hack): the caller should not sandbox at all.
 */
export type WriteScope = "none" | "workspace" | "repo" | "host";

/**
 * The write scope granted to an actor in a mode. Default-DENY: an actor the
 * table does not name gets `none`, so a new agent type inherits nothing by
 * mistake. Hack is the global escape hatch — every actor writes unrestricted
 * (you entered it deliberately, possibly to repair the harness itself).
 *
 * Rulings (2026-07-21): maestro is scoped to the `repo` in recon/plan/auto;
 * a worker to its `workspace` (worktree); a reviewer reads and executes but
 * never writes.
 */
export function writeScopeFor(actor: BashActor, mode: ModeName): WriteScope {
	if (mode === "hack") return "host";
	switch (actor) {
		case "maestro":
			return "repo";
		case "worker":
			return "workspace";
		default:
			// reviewer (and any unlisted future actor) — default-deny.
			return "none";
	}
}

export interface ProfilePaths {
	/** The agent's worktree (the `workspace` scope target). */
	readonly worktree?: string;
	/** The repository checkout root (the `repo` scope target). */
	readonly repoRoot?: string;
	/**
	 * The worktree's OWN private git dir (`.git/worktrees/<name>`), writable so
	 * git operations inside the worktree work. Distinct from the SHARED git dir.
	 */
	readonly worktreeGitDir?: string;
	/**
	 * The SHARED repository git dir. `config` and `refs` under it are denied even
	 * when the surrounding scope allows writes — a worktree shares the
	 * REPOSITORY, so `git config` there rewrites the developer's real config
	 * (the git-identity incident). File writes are contained; git-state writes
	 * to the shared repo are not, which is the opposite of the naive assumption.
	 */
	readonly sharedGitDir?: string;
	/** Private scratch dirs (HOME/TMP/cache) — always writable, never the repo. */
	readonly scratch: readonly string[];
}

export interface WriteProfile {
	readonly allowWrite: readonly string[];
	readonly denyWrite: readonly string[];
	/** true only for `host` scope (hack): the caller should run direct, unsandboxed. */
	readonly unrestricted: boolean;
}

/**
 * Compile a write scope to concrete allow/deny path lists for a native sandbox
 * profile. Private scratch is always writable; the repo/worktree is writable
 * only in scope; and the shared repo `config`/`refs` are always denied so
 * git-state cannot leak out of a worktree into the developer's real repo.
 */
export function compileWriteProfile(
	scope: WriteScope,
	paths: ProfilePaths,
): WriteProfile {
	const scratch = [...paths.scratch];
	if (scope === "host")
		return { allowWrite: [], denyWrite: [], unrestricted: true };
	if (scope === "none")
		return { allowWrite: scratch, denyWrite: [], unrestricted: false };
	const root = scope === "workspace" ? paths.worktree : paths.repoRoot;
	// A worktree's git ops write commit OBJECTS to the SHARED .git/objects (they
	// are content-addressed and safe); its HEAD/index live in the worktree's own
	// git dir. `repo` scope already covers .git/objects via the checkout root.
	const sharedObjects =
		scope === "workspace" && paths.sharedGitDir
			? [join(paths.sharedGitDir, "objects")]
			: [];
	const allowWrite = [
		...(root ? [root] : []),
		...(paths.worktreeGitDir ? [paths.worktreeGitDir] : []),
		...sharedObjects,
		...scratch,
	];
	const denyWrite = paths.sharedGitDir
		? [join(paths.sharedGitDir, "config"), join(paths.sharedGitDir, "refs")]
		: [];
	return { allowWrite, denyWrite, unrestricted: false };
}
