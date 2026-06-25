// Worktree + session lifecycle policy. pi-git owns mechanics; modes owns when
// a deliverable receives or releases a worktree and where session paths are
// recorded in the plan. Branches are never deleted here.

import type { WorktreeEntry } from "@vegardx/pi-git";
import { worktreePathFor } from "@vegardx/pi-git";
import type { PlanEngine } from "./engine.js";
import { renderPlanSeed } from "./markdown.js";
import {
	type Deliverable,
	defaultBranchForDeliverable,
	deliverables,
	findDeliverable,
	type Plan,
	pickBaseBranch,
	WORKTREE_STATUSES,
} from "./schema.js";

export interface WorktreeLifecycleDeps {
	readonly addWorktree: (
		repoPath: string,
		targetPath: string,
		branch: string,
		baseBranch: string,
	) =>
		| { ok: true; path: string; created: boolean }
		| { ok: false; error: string };
	readonly removeWorktree: (
		repoPath: string,
		path: string,
		opts?: { force?: boolean },
	) => { ok: true } | { ok: false; error: string; reason?: string };
}

export type WorktreeActivationResult =
	| {
			kind: "ready";
			deliverable: Deliverable;
			path: string;
			branch: string;
			baseBranch: string;
			created: boolean;
	  }
	| { kind: "error"; error: string };

export function deliverableWorktreePath(
	plan: Plan,
	d: Pick<Deliverable, "id">,
): string {
	return worktreePathFor(plan.repoPath, d.id);
}

export function activateDeliverableWorktree(
	engine: PlanEngine,
	deliverableId: string,
	defaultBranch: string,
	deps: WorktreeLifecycleDeps,
): WorktreeActivationResult {
	const plan = engine.get();
	const d = findDeliverable(plan, deliverableId);
	if (!d)
		return { kind: "error", error: `unknown deliverable: ${deliverableId}` };
	const branch = d.branch ?? defaultBranchForDeliverable(d);
	const baseBranch = pickBaseBranch(plan, d.id, defaultBranch);
	const target = deliverableWorktreePath(plan, d);
	const added = deps.addWorktree(plan.repoPath, target, branch, baseBranch);
	if (!added.ok) return { kind: "error", error: added.error };
	engine.updateDeliverable(d.id, {
		branch,
		worktreePath: added.path,
	});
	const updated = findDeliverable(engine.get(), d.id) ?? d;
	return {
		kind: "ready",
		deliverable: updated,
		path: added.path,
		branch,
		baseBranch,
		created: added.created,
	};
}

export interface CleanupResult {
	readonly removed: readonly string[];
	readonly kept: readonly { id: string; path: string; reason: string }[];
}

export function cleanupInactiveWorktrees(
	engine: PlanEngine,
	deps: WorktreeLifecycleDeps,
): CleanupResult {
	const removed: string[] = [];
	const kept: Array<{ id: string; path: string; reason: string }> = [];
	for (const d of deliverables(engine.get())) {
		if (!d.worktreePath) continue;
		if (WORKTREE_STATUSES.includes(d.status)) continue;
		const result = deps.removeWorktree(engine.get().repoPath, d.worktreePath);
		if (result.ok) {
			removed.push(d.worktreePath);
			engine.updateDeliverable(d.id, { worktreePath: undefined });
		} else {
			kept.push({
				id: d.id,
				path: d.worktreePath,
				reason: result.reason ?? result.error,
			});
		}
	}
	return { removed, kept };
}

export interface ReconcileResult {
	readonly attached: readonly string[];
	readonly cleared: readonly string[];
}

export function reconcileWorktrees(
	engine: PlanEngine,
	entries: readonly WorktreeEntry[],
): ReconcileResult {
	const attached: string[] = [];
	const cleared: string[] = [];
	const byBranch = new Map(
		entries.filter((e) => e.branch).map((e) => [e.branch, e.path]),
	);
	const paths = new Set(entries.map((e) => e.path));
	for (const d of deliverables(engine.get())) {
		const branch = d.branch ?? defaultBranchForDeliverable(d);
		const path = byBranch.get(branch);
		if (path && path !== d.worktreePath) {
			engine.updateDeliverable(d.id, { branch, worktreePath: path });
			attached.push(d.id);
			continue;
		}
		if (d.worktreePath && !paths.has(d.worktreePath)) {
			engine.updateDeliverable(d.id, { worktreePath: undefined });
			cleared.push(d.id);
		}
	}
	return { attached, cleared };
}

export function recordDeliverableSession(
	engine: PlanEngine,
	deliverableId: string,
	sessionPath: string,
): void {
	engine.updateDeliverable(deliverableId, { sessionPath });
}

export function recordPlanSession(
	engine: PlanEngine,
	sessionPath: string,
): void {
	engine.updatePlan({ planSessionPath: sessionPath });
}

export function deliverableSessionSeed(
	plan: Plan,
	deliverableId: string,
): string {
	return renderPlanSeed(plan, deliverableId);
}
