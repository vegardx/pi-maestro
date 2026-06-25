// PlanEngine — the mutation surface over a Plan. Every mutation clones the
// plan, applies the change, runs validatePlanShape, and (only if valid) bumps
// timestamps and persists atomically. Invalid mutations throw before touching
// disk, so the in-memory plan and the file never diverge. The tool/command
// layer (next child) is a thin wrapper over these methods.

import {
	canTransition,
	type Deliverable,
	type DeliverableLifecycle,
	type DeliverableStatus,
	defaultBranchForDeliverable,
	deliverables,
	findDeliverable,
	findNode,
	isDeliverable,
	isWorkItem,
	type Plan,
	type PlanNode,
	parentOf,
	slugify,
	validatePlanShape,
	type WorkItem,
	type WorkItemKind,
} from "./schema.js";
import type { PlanStore } from "./storage.js";

export interface AddDeliverableInput {
	title: string;
	body?: string;
	parentId?: string;
	dependsOn?: string[];
	lifecycle?: DeliverableLifecycle;
	position?: number;
}

export interface AddWorkItemInput {
	title: string;
	body?: string;
	kind?: WorkItemKind;
	position?: number;
}

/** Sentinel container id for top-level loose work-items. */
export const PLAN_CONTAINER = "@plan";

export class PlanEngine {
	private plan: Plan;

	constructor(
		plan: Plan,
		private readonly store: PlanStore,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		this.plan = plan;
	}

	static create(
		store: PlanStore,
		input: { slug: string; title: string; repoPath: string },
		now: () => string = () => new Date().toISOString(),
	): PlanEngine {
		const ts = now();
		const plan: Plan = {
			slug: input.slug,
			title: input.title,
			repoPath: input.repoPath,
			nodes: [],
			createdAt: ts,
			updatedAt: ts,
		};
		const engine = new PlanEngine(plan, store, now);
		store.save(plan);
		return engine;
	}

	get(): Plan {
		return this.plan;
	}

	// Clone → mutate → validate → persist. Throws (without saving) on an
	// invalid shape, so disk only ever holds valid plans.
	private mutate(fn: (plan: Plan) => void): void {
		const next = structuredClone(this.plan) as Plan;
		fn(next);
		const problems = validatePlanShape(next);
		if (problems.length > 0) {
			throw new Error(`invalid plan:\n- ${problems.join("\n- ")}`);
		}
		next.updatedAt = this.now();
		this.store.save(next);
		this.plan = next;
	}

	private uniqueId(base: string): string {
		const root = slugify(base) || "node";
		const taken = new Set<string>();
		for (const d of deliverables(this.plan)) taken.add(d.id);
		const items: WorkItem[] = [];
		const collect = (nodes: PlanNode[]) => {
			for (const n of nodes) {
				if (isWorkItem(n)) items.push(n);
				else collect(n.children);
			}
		};
		collect(this.plan.nodes);
		for (const i of items) taken.add(i.id);
		if (!taken.has(root)) return root;
		for (let n = 2; ; n++) {
			const candidate = `${root}-${n}`;
			if (!taken.has(candidate)) return candidate;
		}
	}

	// ---- Deliverables -----------------------------------------------------

	addDeliverable(input: AddDeliverableInput): Deliverable {
		const ts = this.now();
		const id = this.uniqueId(input.title);
		const deliverable: Deliverable = {
			type: "deliverable",
			id,
			title: input.title,
			body: input.body ?? "",
			status: "planned",
			children: [],
			lifecycle: input.lifecycle,
			createdAt: ts,
			updatedAt: ts,
		};

		this.mutate((plan) => {
			const siblings = this.containerChildren(plan, input.parentId);
			// dependsOn default: chain off the last sibling deliverable (linear
			// plans). [] declares a root; an explicit list is honoured verbatim.
			if (input.dependsOn !== undefined) {
				deliverable.dependsOn = input.dependsOn;
			} else if (!input.lifecycle) {
				const prev = [...siblings].reverse().find(isDeliverable);
				deliverable.dependsOn = prev ? [prev.id] : [];
			}
			if (!input.lifecycle) {
				deliverable.branch = defaultBranchForDeliverable(deliverable);
			}
			insertAt(siblings, deliverable, input.position);
		});
		return findDeliverable(this.plan, id) as Deliverable;
	}

	updateDeliverable(
		id: string,
		patch: Partial<
			Pick<Deliverable, "title" | "body" | "branch" | "dependsOn" | "lifecycle">
		>,
	): void {
		this.mutate((plan) => {
			const d = findDeliverable(plan, id);
			if (!d) throw new Error(`unknown deliverable: ${id}`);
			Object.assign(d, patch);
			d.updatedAt = this.now();
		});
	}

	setStatus(id: string, status: DeliverableStatus): void {
		this.mutate((plan) => {
			const d = findDeliverable(plan, id);
			if (!d) throw new Error(`unknown deliverable: ${id}`);
			if (d.status !== status && !canTransition(d.status, status)) {
				throw new Error(`illegal status transition: ${d.status} → ${status}`);
			}
			d.status = status;
			d.updatedAt = this.now();
		});
	}

	removeDeliverable(id: string): void {
		this.mutate((plan) => {
			if (!removeNode(plan.nodes, id)) {
				throw new Error(`unknown deliverable: ${id}`);
			}
		});
	}

	reorderDeliverable(id: string, position: number): void {
		this.mutate((plan) => {
			const parent = parentOf(plan, id);
			const siblings = parent ? parent.children : plan.nodes;
			const idx = siblings.findIndex((n) => n.id === id);
			if (idx < 0) throw new Error(`unknown deliverable: ${id}`);
			const [node] = siblings.splice(idx, 1);
			insertAt(siblings, node, position);
		});
	}

	// ---- Work items -------------------------------------------------------

	addWorkItem(container: string, input: AddWorkItemInput): WorkItem {
		const ts = this.now();
		const id = this.uniqueId(input.title);
		const item: WorkItem = {
			type: "work-item",
			id,
			title: input.title,
			body: input.body ?? "",
			done: false,
			kind: input.kind ?? "task",
			createdAt: ts,
			updatedAt: ts,
		};
		this.mutate((plan) => {
			// Plan-level loose items must not gate.
			if (container === PLAN_CONTAINER && (input.kind ?? "task") === "task") {
				throw new Error("plan-level items cannot be gating tasks");
			}
			const children = this.containerChildren(plan, container);
			insertAt(children, item, input.position);
		});
		return findNode(this.plan, id) as WorkItem;
	}

	updateWorkItem(
		id: string,
		patch: Partial<Pick<WorkItem, "title" | "body" | "kind">> & {
			answer?: string;
		},
	): void {
		this.mutate((plan) => {
			const node = findNode(plan, id);
			if (!node || !isWorkItem(node))
				throw new Error(`unknown work item: ${id}`);
			const { answer, ...rest } = patch;
			Object.assign(node, rest);
			if (answer !== undefined) {
				node.answer = answer;
				node.decidedAt = this.now();
				node.done = true;
			}
			node.updatedAt = this.now();
		});
	}

	toggleWorkItem(id: string): boolean {
		let done = false;
		this.mutate((plan) => {
			const node = findNode(plan, id);
			if (!node || !isWorkItem(node))
				throw new Error(`unknown work item: ${id}`);
			node.done = !node.done;
			node.updatedAt = this.now();
			done = node.done;
		});
		return done;
	}

	removeWorkItem(id: string): void {
		this.mutate((plan) => {
			if (!removeNode(plan.nodes, id))
				throw new Error(`unknown work item: ${id}`);
		});
	}

	moveWorkItem(id: string, targetContainer: string): void {
		this.mutate((plan) => {
			const node = findNode(plan, id);
			if (!node || !isWorkItem(node))
				throw new Error(`unknown work item: ${id}`);
			if (
				targetContainer === PLAN_CONTAINER &&
				(node.kind ?? "task") === "task"
			) {
				throw new Error("plan-level items cannot be gating tasks");
			}
			removeNode(plan.nodes, id);
			const children = this.containerChildren(plan, targetContainer);
			children.push(node);
			node.updatedAt = this.now();
		});
	}

	// Resolve a container id to its children array (plan root or a deliverable).
	private containerChildren(plan: Plan, container?: string): PlanNode[] {
		if (!container || container === PLAN_CONTAINER) return plan.nodes;
		const d = findDeliverable(plan, container);
		if (!d) throw new Error(`unknown deliverable: ${container}`);
		return d.children;
	}
}

function insertAt(arr: PlanNode[], node: PlanNode, position?: number): void {
	if (position === undefined || position >= arr.length) arr.push(node);
	else arr.splice(Math.max(0, position), 0, node);
}

// Remove a node by id anywhere in the forest; returns true if removed.
function removeNode(nodes: PlanNode[], id: string): boolean {
	const idx = nodes.findIndex((n) => n.id === id);
	if (idx >= 0) {
		nodes.splice(idx, 1);
		return true;
	}
	for (const n of nodes) {
		if (isDeliverable(n) && removeNode(n.children, id)) return true;
	}
	return false;
}
