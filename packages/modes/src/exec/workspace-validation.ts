import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { currentBranch, gitToplevel, listWorktrees } from "@vegardx/pi-git";
import type { Deliverable, Plan } from "../schema.js";
import {
	defaultBranchForDeliverable,
	deliverableWorkspace,
	repoFor,
} from "../schema.js";

export interface WorkspaceValidationDeps {
	pathExists(path: string): boolean;
	realpath(path: string): string;
	gitToplevel(path: string): string | null;
	currentBranch(path: string): string | null;
	worktrees(repoPath: string): ReadonlyArray<{ path: string; branch?: string }>;
}

export interface WorkspaceValidationResult {
	ok: boolean;
	path?: string;
	branch?: string;
	missing?: boolean;
	canReprovision?: boolean;
	error?: string;
}

const defaults: WorkspaceValidationDeps = {
	pathExists: existsSync,
	realpath: realpathSync,
	gitToplevel,
	currentBranch,
	worktrees: listWorktrees,
};

function canonical(path: string, deps: WorkspaceValidationDeps): string {
	return resolve(deps.realpath(path));
}

/**
 * Read-only proof that a persisted workspace is the unique workspace owned by
 * this active deliverable. This never checks out a branch or edits Git state.
 */
export function validateRestartWorkspace(
	plan: Plan,
	deliverable: Deliverable,
	overrides: Partial<WorkspaceValidationDeps> = {},
	planDir?: string,
): WorkspaceValidationResult {
	const deps = { ...defaults, ...overrides };
	const path = deliverable.worktreePath;
	const expectedBranch =
		deliverableWorkspace(deliverable) === "scratch"
			? undefined
			: (deliverable.branch ?? defaultBranchForDeliverable(deliverable));
	if (!path || !deps.pathExists(path)) {
		return {
			ok: true,
			missing: true,
			canReprovision: true,
			...(path ? { path } : {}),
			...(expectedBranch ? { branch: expectedBranch } : {}),
		};
	}

	let actualPath: string;
	try {
		actualPath = canonical(path, deps);
	} catch (error) {
		return {
			ok: false,
			error: `cannot resolve workspace ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	for (const other of plan.deliverables) {
		if (other.id === deliverable.id || other.status !== "active") continue;
		if (other.worktreePath && deps.pathExists(other.worktreePath)) {
			try {
				if (canonical(other.worktreePath, deps) === actualPath) {
					return {
						ok: false,
						error: `workspace is also claimed by active deliverable ${other.id}`,
					};
				}
			} catch {
				return {
					ok: false,
					error: `cannot prove workspace claim for active deliverable ${other.id}`,
				};
			}
		}
		if (
			expectedBranch &&
			deliverableWorkspace(other) !== "scratch" &&
			repoFor(plan, other).path === repoFor(plan, deliverable).path &&
			(other.branch ?? defaultBranchForDeliverable(other)) === expectedBranch
		) {
			return {
				ok: false,
				error: `branch ${expectedBranch} is also claimed by active deliverable ${other.id}`,
			};
		}
	}

	if (deliverableWorkspace(deliverable) === "scratch") {
		// Scratch dirs have no repo/branch proof, so the only ownership claim is
		// the authoritative provisioning path under the plan directory.
		if (!planDir) {
			return {
				ok: false,
				error:
					"scratch workspace validation requires the authoritative plan directory",
			};
		}
		const expected = resolve(planDir, "workspaces", deliverable.id);
		let expectedPath: string;
		try {
			expectedPath = canonical(expected, deps);
		} catch (error) {
			return {
				ok: false,
				error: `cannot resolve expected scratch workspace ${expected}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (actualPath !== expectedPath) {
			return {
				ok: false,
				error: `scratch workspace mismatch: expected ${expectedPath}, found ${actualPath}`,
			};
		}
		return { ok: true, path: actualPath };
	}

	const repo = repoFor(plan, deliverable);
	const top = deps.gitToplevel(actualPath);
	if (!top || resolve(top) !== actualPath) {
		return { ok: false, error: `${path} is not the root of a git worktree` };
	}
	const entries = deps.worktrees(repo.path);
	const entry = entries.find((item) => {
		try {
			return canonical(item.path, deps) === actualPath;
		} catch {
			return false;
		}
	});
	if (!entry) {
		return {
			ok: false,
			error: `${path} is not registered to expected repository ${repo.path}`,
		};
	}
	const branch = deps.currentBranch(actualPath);
	if (!branch || branch !== expectedBranch) {
		return {
			ok: false,
			error: `workspace branch mismatch: expected ${expectedBranch}, found ${branch ?? "detached HEAD"}`,
		};
	}
	const duplicate = entries.find(
		(item) => item.path !== entry.path && item.branch === expectedBranch,
	);
	if (duplicate) {
		return {
			ok: false,
			error: `branch ${expectedBranch} is checked out at ${duplicate.path}`,
		};
	}
	return { ok: true, path: actualPath, branch };
}
