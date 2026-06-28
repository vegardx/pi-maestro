// The plan model: a forest of nodes. A node is either a Deliverable (ships as
// one PR, or groups child deliverables) or a WorkItem (a checklist line). This
// is the full in-memory model; @vegardx/pi-contracts exposes only the
// cross-cutting enums + summaries other modules reference.
//
// Greenfield rules (clean break from the v3 schema this is adapted from): no
// on-disk migration, no legacy id-prefix matching, no token telemetry, no
// multi-session driver claims. Branded ids live at the capability boundary;
// the tree itself uses plain strings for ergonomics.

import { basename, resolve } from "node:path";
import {
	DELIVERABLE_STATUSES,
	type DeliverableLifecycle,
	type DeliverableStatus,
	WORK_ITEM_KINDS,
	type WorkItemKind,
} from "@vegardx/pi-contracts";

export {
	DELIVERABLE_STATUSES,
	type DeliverableLifecycle,
	type DeliverableStatus,
	WORK_ITEM_KINDS,
	type WorkItemKind,
};

/** Statuses that require a worktree (active editing). */
export const WORKTREE_STATUSES: readonly DeliverableStatus[] = [
	"active",
	"needs-attention",
];

/** Terminal statuses — the deliverable will not transition again. */
export const TERMINAL_STATUSES: readonly DeliverableStatus[] = [
	"shipped",
	"abandoned",
];

export interface WorkItem {
	type: "work-item";
	id: string;
	title: string;
	body: string;
	done: boolean;
	kind?: WorkItemKind;
	/** For `question` items: the decision once made (stamps decidedAt). */
	answer?: string;
	decidedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export function effectiveWorkItemKind(
	item: Pick<WorkItem, "kind">,
): WorkItemKind {
	return item.kind ?? "task";
}

export interface Deliverable {
	type: "deliverable";
	id: string;
	title: string;
	/** What ships when this merges. */
	body: string;
	status: DeliverableStatus;
	/** Git branch (typically feat/<id>). Lifecycle/groupings don't claim one. */
	branch?: string;
	lifecycle?: DeliverableLifecycle;
	/** The stacking edge: at most one parent; cross-subtree allowed. */
	dependsOn?: string[];
	/** Own gating work-items XOR child deliverables. */
	children: PlanNode[];
	/** Worktree path while active/needs-attention; cleared when it leaves. */
	worktreePath?: string;
	/** Session file backing this deliverable's auto session. Never cleared. */
	sessionPath?: string;
	issueNumber?: number;
	prNumber?: number;
	/** Distilled outcome, written at ship time; carried into later seeds. */
	summary?: string;
	createdAt: string;
	updatedAt: string;
}

export type PlanNode = Deliverable | WorkItem;

export function isDeliverable(node: PlanNode): node is Deliverable {
	return node.type === "deliverable";
}

export function isWorkItem(node: PlanNode): node is WorkItem {
	return node.type === "work-item";
}

export interface Plan {
	slug: string;
	title: string;
	repoPath: string;
	nodes: PlanNode[];
	/** GitHub plan-tracking issue (parent of deliverable issues) after park. */
	parentIssueNumber?: number;
	/** Session file backing this plan's planning session. */
	planSessionPath?: string;
	lastSyncedAt?: string;
	createdAt: string;
	updatedAt: string;
}

// ---- Forest traversal ---------------------------------------------------

/** Preorder flatten of every deliverable in the forest. */
export function deliverables(plan: Pick<Plan, "nodes">): Deliverable[] {
	const out: Deliverable[] = [];
	const visit = (nodes: readonly PlanNode[]): void => {
		for (const node of nodes) {
			if (isDeliverable(node)) {
				out.push(node);
				visit(node.children);
			}
		}
	};
	visit(plan.nodes);
	return out;
}

export function ownWorkItems(d: Pick<Deliverable, "children">): WorkItem[] {
	return d.children.filter(isWorkItem);
}

export function childDeliverables(
	d: Pick<Deliverable, "children">,
): Deliverable[] {
	return d.children.filter(isDeliverable);
}

export function gatingTasks(d: Pick<Deliverable, "children">): WorkItem[] {
	return ownWorkItems(d).filter((t) => effectiveWorkItemKind(t) === "task");
}

export function isGrouping(d: Pick<Deliverable, "children">): boolean {
	return childDeliverables(d).length > 0;
}

/** Ships as one PR? Lifecycle never ships; groupings complete via subtree. */
export function shipsPR(
	d: Pick<Deliverable, "children" | "lifecycle">,
): boolean {
	return !d.lifecycle && !isGrouping(d) && gatingTasks(d).length >= 1;
}

/** Not a lifecycle checklist, not a grouping — `/implement` can act on it. */
export function isImplementableLeaf(
	d: Pick<Deliverable, "children" | "lifecycle">,
): boolean {
	return !d.lifecycle && !isGrouping(d);
}

/** Depth-first preorder walk over every node. */
export function walk(
	plan: Pick<Plan, "nodes">,
	visit: (node: PlanNode, parent: Deliverable | null, depth: number) => void,
): void {
	const go = (
		nodes: readonly PlanNode[],
		parent: Deliverable | null,
		depth: number,
	): void => {
		for (const node of nodes) {
			visit(node, parent, depth);
			if (isDeliverable(node)) go(node.children, node, depth + 1);
		}
	};
	go(plan.nodes, null, 0);
}

export function findNode(
	plan: Pick<Plan, "nodes">,
	id: string,
): PlanNode | null {
	let found: PlanNode | null = null;
	walk(plan, (node) => {
		if (!found && node.id === id) found = node;
	});
	return found;
}

export function findDeliverable(
	plan: Pick<Plan, "nodes">,
	id: string,
): Deliverable | null {
	return deliverables(plan).find((d) => d.id === id) ?? null;
}

export function parentOf(
	plan: Pick<Plan, "nodes">,
	id: string,
): Deliverable | null {
	let found: Deliverable | null = null;
	walk(plan, (node, parent) => {
		if (!found && node.id === id) found = parent;
	});
	return found;
}

export function topLevelLeaves(plan: Pick<Plan, "nodes">): WorkItem[] {
	return plan.nodes.filter(isWorkItem);
}

/** Is a deliverable's subtree complete? */
export function subtreeComplete(d: Deliverable): boolean {
	if (d.lifecycle) return ownWorkItems(d).every((t) => t.done);
	if (isGrouping(d)) return childDeliverables(d).every(subtreeComplete);
	if (gatingTasks(d).length === 0) return true;
	return d.status === "shipped" || d.status === "abandoned";
}

// ---- State machine ------------------------------------------------------

export const DELIVERABLE_TRANSITIONS: Record<
	DeliverableStatus,
	readonly DeliverableStatus[]
> = {
	planned: ["active", "abandoned"],
	active: ["in-review", "abandoned"],
	"in-review": ["ready-to-ship", "needs-attention", "abandoned"],
	"needs-attention": ["ready-to-ship", "abandoned"],
	"ready-to-ship": ["shipped", "abandoned"],
	shipped: [],
	abandoned: [],
};

export function canTransition(
	from: DeliverableStatus,
	to: DeliverableStatus,
): boolean {
	return DELIVERABLE_TRANSITIONS[from].includes(to);
}

// ---- Ids ----------------------------------------------------------------

export function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
}

export function defaultBranchForDeliverable(
	d: Pick<Deliverable, "id">,
): string {
	return `feat/${d.id}`;
}

// ---- Lifecycle gates ----------------------------------------------------

export function findLifecycle(
	plan: Pick<Plan, "nodes">,
	which: DeliverableLifecycle,
): Deliverable | undefined {
	return plan.nodes.filter(isDeliverable).find((d) => d.lifecycle === which);
}

export function regularDeliverables(plan: Pick<Plan, "nodes">): Deliverable[] {
	return deliverables(plan).filter((d) => !d.lifecycle);
}

/** The pre/post deliverable if one exists AND has an unticked item, else null. */
export function pendingLifecycle(
	plan: Pick<Plan, "nodes">,
	which: DeliverableLifecycle,
): Deliverable | null {
	const d = findLifecycle(plan, which);
	if (!d) return null;
	const items = ownWorkItems(d);
	if (items.length === 0) return null;
	return items.every((t) => t.done) ? null : d;
}

// ---- Dependency / activation logic --------------------------------------

const IN_FLIGHT_PARENT_STATUSES: readonly DeliverableStatus[] = [
	"active",
	"in-review",
	"ready-to-ship",
	"needs-attention",
];

const ACTIVATABLE_PARENT_STATUSES: readonly DeliverableStatus[] = [
	...IN_FLIGHT_PARENT_STATUSES,
	"shipped",
];

/**
 * Read a deliverable's dependsOn, defaulting to nearest preceding
 * non-abandoned deliverable in preorder when unset (ad-hoc/test plans).
 */
export function effectiveDependsOn(
	plan: Pick<Plan, "nodes">,
	d: Pick<Deliverable, "id" | "dependsOn">,
): string[] {
	if (d.dependsOn !== undefined) return d.dependsOn;
	const flat = deliverables(plan);
	const idx = flat.findIndex((p) => p.id === d.id);
	if (idx <= 0) return [];
	for (let i = idx - 1; i >= 0; i--) {
		if (flat[i].status !== "abandoned") return [flat[i].id];
	}
	return [];
}

export function isDeliverableReady(
	plan: Pick<Plan, "nodes">,
	d: Pick<
		Deliverable,
		"id" | "status" | "dependsOn" | "lifecycle" | "children"
	>,
): boolean {
	if (d.status !== "planned") return false;
	if (!isImplementableLeaf(d)) return false;
	const deps = effectiveDependsOn(plan, d);
	if (deps.length === 0) return true;
	const parent = deliverables(plan).find((p) => p.id === deps[0]);
	if (!parent) return false;
	if (isGrouping(parent)) return parent.status === "shipped";
	return ACTIVATABLE_PARENT_STATUSES.includes(parent.status);
}

export function readyDeliverables(plan: Pick<Plan, "nodes">): Deliverable[] {
	return deliverables(plan).filter((d) => isDeliverableReady(plan, d));
}

export function blockedReason(
	plan: Pick<Plan, "nodes">,
	d: Pick<Deliverable, "id" | "status" | "dependsOn">,
): string | null {
	if (d.status !== "planned") {
		return `deliverable \`${d.id}\` is ${d.status}, not planned`;
	}
	const deps = effectiveDependsOn(plan, d);
	if (deps.length === 0) return null;
	const parent = deliverables(plan).find((p) => p.id === deps[0]);
	if (!parent) return `unknown parent \`${deps[0]}\``;
	if (isGrouping(parent)) {
		return parent.status === "shipped"
			? null
			: `waiting on grouping \`${parent.id}\` (completes when its children ship)`;
	}
	if (ACTIVATABLE_PARENT_STATUSES.includes(parent.status)) return null;
	if (parent.status === "abandoned") {
		return `waiting on abandoned deliverable \`${parent.id}\` — edit dependsOn to unblock`;
	}
	return `waiting on \`${parent.id}\` (${parent.status})`;
}

/** Next non-shipped PR-shipping successor down the chain rooted at `d`. */
export function chainHead(
	plan: Pick<Plan, "nodes">,
	d: Pick<Deliverable, "id">,
): Deliverable | null {
	const flat = deliverables(plan);
	let curId = d.id;
	for (let steps = 0; steps < flat.length; steps++) {
		const next = flat.find((p) => effectiveDependsOn(plan, p)[0] === curId);
		if (!next) return null;
		if (!isImplementableLeaf(next) || next.status === "shipped") {
			curId = next.id;
			continue;
		}
		return next;
	}
	return null;
}

/** Pick the base branch a freshly-activated deliverable should fork from. */
export function pickBaseBranch(
	plan: Pick<Plan, "nodes">,
	activatingId: string,
	defaultBranch: string,
): string {
	const flat = deliverables(plan);
	const activating = flat.find((d) => d.id === activatingId);
	if (!activating) return defaultBranch;
	const parentId = effectiveDependsOn(plan, activating)[0];
	if (!parentId) return defaultBranch;
	const parent = flat.find((d) => d.id === parentId);
	if (!parent) return defaultBranch;
	if (isGrouping(parent)) return defaultBranch;
	if (IN_FLIGHT_PARENT_STATUSES.includes(parent.status) && parent.branch) {
		return parent.branch;
	}
	return defaultBranch;
}

export type ImplementBranchPlan =
	| { kind: "create"; branch: string; baseBranch: string }
	| { kind: "resume"; branch: string }
	| { kind: "abort"; reason: string };

/** Decide what `/implement` should do to set up the deliverable's branch. */
export function planImplementBranch(
	plan: Pick<Plan, "nodes">,
	d: Pick<Deliverable, "id" | "branch" | "status">,
	defaultBranch: string,
	branchExists: boolean,
): ImplementBranchPlan {
	const branch = d.branch ?? defaultBranchForDeliverable(d);
	if (d.status === "planned") {
		return {
			kind: "create",
			branch,
			baseBranch: pickBaseBranch(plan, d.id, defaultBranch),
		};
	}
	if (!branchExists) {
		return {
			kind: "abort",
			reason:
				`deliverable branch \`${branch}\` is missing locally. Refusing to ` +
				"recreate — that would reset the deliverable to the default branch " +
				"and lose commits. Restore the branch before re-running /implement.",
		};
	}
	return { kind: "resume", branch };
}

export function repoNameFromPath(path: string): string {
	const name = basename(resolve(path));
	return name === "" ? "repo" : name;
}

/**
 * Guard against acting on the wrong repo. A pi session has one cwd modes can't
 * move; if it doesn't resolve to the plan's repo, commit/sync/park would
 * silently hit the wrong tree. Compares git toplevels (not raw paths) so a
 * subdir or symlinked checkout still matches. Returns a warning message on
 * mismatch, or null when the session is in the plan's repo.
 */
export function planRepoMismatch(
	planTop: string | null,
	sessionTop: string | null,
	planRepoPath: string,
	sessionCwd: string,
): string | null {
	if (sessionTop === null) {
		return `session cwd is not inside a git repo: ${sessionCwd}`;
	}
	if (planTop === null) {
		return `plan repo is not a git repo: ${planRepoPath}`;
	}
	if (resolve(sessionTop) !== resolve(planTop)) {
		return (
			`session repo (${sessionTop}) is not the plan's repo (${planTop}); ` +
			"refusing to act on the wrong repo — re-run from the plan's checkout"
		);
	}
	return null;
}

// ---- Write-time validation ----------------------------------------------

/** Structural invariants enforced before saving. Empty array = valid. */
export function validatePlanShape(plan: Pick<Plan, "nodes">): string[] {
	const problems: string[] = [];
	const flat = deliverables(plan);
	const ids = new Set(flat.map((d) => d.id));

	for (const item of topLevelLeaves(plan)) {
		if (effectiveWorkItemKind(item) === "task") {
			problems.push(
				`plan-level work item \`${item.id}\` cannot be a gating task`,
			);
		}
	}

	for (const d of flat) {
		if (gatingTasks(d).length > 0 && childDeliverables(d).length > 0) {
			problems.push(
				`deliverable \`${d.id}\` has both gating tasks and child deliverables`,
			);
		}
		const deps = d.dependsOn ?? [];
		if (deps.length > 1) {
			problems.push(
				`deliverable \`${d.id}\` has ${deps.length} dependsOn entries — at most one parent`,
			);
		}
		for (const dep of deps) {
			if (!ids.has(dep)) {
				problems.push(
					`deliverable \`${d.id}\` depends on unknown deliverable \`${dep}\``,
				);
			}
		}
		if (d.lifecycle && childDeliverables(d).length > 0) {
			problems.push(
				`lifecycle deliverable \`${d.id}\` cannot contain child deliverables`,
			);
		}
	}

	const nested = flat.filter((d) => d.lifecycle && !plan.nodes.includes(d));
	for (const d of nested) {
		problems.push(`lifecycle deliverable \`${d.id}\` must be top-level`);
	}
	for (const which of ["pre", "post"] as const) {
		const count = flat.filter((d) => d.lifecycle === which).length;
		if (count > 1) {
			problems.push(
				`plan has ${count} \`${which}\` deliverables — at most one`,
			);
		}
	}

	// Cycle check over dependsOn edges.
	const colour = new Map<string, "visiting" | "done">();
	const byId = new Map(flat.map((d) => [d.id, d]));
	const visit = (id: string, trail: string[]): void => {
		const state = colour.get(id);
		if (state === "done") return;
		if (state === "visiting") {
			problems.push(`dependsOn cycle: ${[...trail, id].join(" → ")}`);
			return;
		}
		colour.set(id, "visiting");
		for (const dep of byId.get(id)?.dependsOn ?? []) {
			if (byId.has(dep)) visit(dep, [...trail, id]);
		}
		colour.set(id, "done");
	};
	for (const d of flat) visit(d.id, []);

	return problems;
}
