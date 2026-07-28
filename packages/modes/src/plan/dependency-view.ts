// The plan-side half of the compaction seam.
//
// Compaction renders summaries; it does not know how the plan scopes
// dependencies. It asks for two lists — what this work builds on, and who will
// read its output — and this module answers them from the current plan model.
//
// It lives HERE rather than behind an interface in packages/maestro on purpose:
// `after` being sibling-scoped is a fact about THIS plan model, and the plan
// model is what the rebuild replaces. Encoding it in the seam would carry a
// retired concept into the new core. When the new model lands, this file is
// replaced — not ported — and compaction is untouched.

import type { InventoryPlanView } from "@vegardx/pi-maestro/carry-forward";
import type { CompactionDeliverable } from "@vegardx/pi-maestro/compaction";
import {
	effectiveNodeTaskKind,
	PARENT_AFTER_TOKEN,
	type Plan,
	type PlanNode,
	parentOfNode,
	TERMINAL_STATUSES,
	walkNodes,
} from "./schema.js";

/** The sibling group `id` schedules within (its `after` scope). */
function siblingGroup(
	plan: Pick<Plan, "nodes">,
	id: string,
): readonly PlanNode[] {
	const parent = parentOfNode(plan, id);
	return parent ? (parent.children ?? []) : plan.nodes;
}

const view = (node: PlanNode): CompactionDeliverable => ({
	id: node.id,
	...(node.title !== undefined ? { title: node.title } : {}),
	...(node.body !== undefined ? { body: node.body } : {}),
	...(node.summary !== undefined ? { summary: node.summary } : {}),
});

/**
 * Transitive dependency ancestors of `id` (deepest-first dedup, no cycles).
 * `after` is sibling-scoped, so the closure runs over the node's own sibling
 * group; the "parent" ordering token is not a dependency.
 */
export function dependenciesOf(
	plan: Pick<Plan, "nodes">,
	id: string,
): CompactionDeliverable[] {
	const byId = new Map(siblingGroup(plan, id).map((d) => [d.id, d]));
	const seen = new Set<string>();
	const out: CompactionDeliverable[] = [];
	const visit = (current: string) => {
		for (const depId of byId.get(current)?.after ?? []) {
			if (depId === PARENT_AFTER_TOKEN || seen.has(depId)) continue;
			seen.add(depId);
			const dep = byId.get(depId);
			if (dep) {
				out.push(view(dep));
				visit(depId);
			}
		}
	};
	visit(id);
	return out;
}

/**
 * Non-terminal sibling nodes that depend (directly or transitively) on `id` —
 * the future readers the summary retains detail for. Terminal work is excluded
 * here rather than downstream: a reader that is finished is not a reader.
 */
export function dependentsOf(
	plan: Pick<Plan, "nodes">,
	id: string,
): CompactionDeliverable[] {
	const all = siblingGroup(plan, id);
	const dependents = new Set<string>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const d of all) {
			if (d.id === id || dependents.has(d.id)) continue;
			const deps = (d.after ?? []).filter((ref) => ref !== PARENT_AFTER_TOKEN);
			if (deps.some((dep) => dep === id || dependents.has(dep))) {
				dependents.add(d.id);
				grew = true;
			}
		}
	}
	return all
		.filter(
			(d) => dependents.has(d.id) && !TERMINAL_STATUSES.includes(d.status),
		)
		.map(view);
}

/**
 * The plan as the carry-forward inventory renders it: flattened, with task
 * counts already taken. Which task kinds gate completion is a plan-model fact,
 * so it is answered here rather than learned downstream.
 */
export function inventoryView(plan: Plan): InventoryPlanView {
	return {
		slug: plan.slug,
		title: plan.title,
		...(plan.phase !== undefined ? { phase: plan.phase } : {}),
		rows: [...walkNodes(plan)].map(({ node, depth }) => {
			const tasks = node.tasks.filter(
				(t) => effectiveNodeTaskKind(t) === "task",
			);
			return {
				id: node.id,
				depth,
				status: node.status,
				tasksDone: tasks.filter((t) => t.done).length,
				tasksTotal: tasks.length,
				...(node.prUrl !== undefined ? { prUrl: node.prUrl } : {}),
			};
		}),
	};
}
