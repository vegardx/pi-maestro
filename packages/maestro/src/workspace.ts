// Where a deliverable's work happens.
//
// One worktree per deliverable, one branch per worktree, both named from the
// deliverable's id. That is the whole idea: the branch name is not stored
// anywhere, because it is derivable, and a stored copy is a copy that can
// disagree with the checkout it names.

import { realpathSync } from "node:fs";
import {
	addWorktree,
	detectDefaultBranch,
	worktreePathFor,
} from "@vegardx/pi-git";
import type { Workspace } from "./executor.js";
import type { Deliverable } from "./plan.js";

/**
 * Branches are named `<prefix><deliverable id>`.
 *
 * The id is already constrained to lowercase, digits and hyphens by plan
 * validation, precisely so this mapping needs no escaping step — an escaping
 * step is a place where two deliverables can collide into one branch.
 */
export const DEFAULT_BRANCH_PREFIX = "deliverable/";

export interface WorkspaceOptions {
	readonly branchPrefix?: string;
	/** What to branch from. Detected from the repo when absent. */
	readonly baseBranch?: string;
}

export function branchFor(
	deliverable: Deliverable,
	prefix = DEFAULT_BRANCH_PREFIX,
): string {
	return `${prefix}${deliverable.id}`;
}

export function createWorkspace(options: WorkspaceOptions = {}): Workspace {
	const prefix = options.branchPrefix ?? DEFAULT_BRANCH_PREFIX;

	return {
		async create(deliverable: Deliverable, repoPath: string) {
			const branch = branchFor(deliverable, prefix);
			const base = options.baseBranch ?? detectDefaultBranch(repoPath);
			if (!base)
				throw new Error(
					`cannot tell what to branch from in ${repoPath}: no origin/HEAD and no main, master, dev or develop`,
				);

			const path = worktreePathFor(repoPath, deliverable.id);
			const result = addWorktree(repoPath, path, branch, base);
			if (!result.ok)
				throw new Error(
					`could not create a worktree for \`${deliverable.id}\`: ${result.error}`,
				);
			// `addWorktree` answers with the existing checkout when the branch is
			// already out somewhere, so a resumed run reuses its worktree instead
			// of failing on one it made itself last time.
			//
			// Resolved, because those two answers are not the same string: the
			// path we computed, and the path git reports for a checkout it
			// already knows about, differ wherever a parent directory is a
			// symlink — `/var` on macOS, for one. The run record keeps this
			// value, so it has to mean the same thing on the first pass and on a
			// resumed one.
			return { path: realpathSync(result.path), branch };
		},
	};
}
