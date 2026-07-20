// Recap for the node-tree plan model. Produces a concise text summary of
// plan progress — useful when the maestro session resumes or a compaction
// boundary is hit.

import type { PlanEngineV2 } from "./plan/engine.js";
import type { NodeExecutor } from "./plan/node-executor.js";
import {
	gatingNodeTasks,
	PARENT_AFTER_TOKEN,
	type PlanNode,
	walkNodes,
} from "./plan/schema.js";

export interface RecapOptions {
	/** Include agent summaries for complete nodes. */
	includeSummaries?: boolean;
}

/**
 * Build a recap of plan progress. Returns a markdown string suitable
 * for injection into a new maestro turn or compaction seed.
 */
export function buildRecap(
	engine: PlanEngineV2,
	executor: NodeExecutor,
	opts: RecapOptions = {},
): string {
	const plan = engine.get();
	const sections: string[] = [];

	const visits = [...walkNodes(plan)];
	sections.push(`# Plan: ${plan.title}`);
	sections.push(`Slug: \`${plan.slug}\` · ${visits.length} node(s)`);

	// Status summary
	const counts = countStatuses(visits.map((visit) => visit.node));
	const statusLine = Object.entries(counts)
		.filter(([_, n]) => n > 0)
		.map(([s, n]) => `${s}: ${n}`)
		.join(" · ");
	sections.push(statusLine);

	// Per-node detail (tree order; heading depth mirrors tree depth)
	for (const { node, depth } of visits) {
		sections.push(renderNodeRecap(node, depth, executor, opts));
	}

	return sections.join("\n\n");
}

function countStatuses(nodes: readonly PlanNode[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const node of nodes) {
		counts[node.status] = (counts[node.status] ?? 0) + 1;
	}
	return counts;
}

function renderNodeRecap(
	node: PlanNode,
	depth: number,
	executor: NodeExecutor,
	opts: RecapOptions,
): string {
	const lines: string[] = [];
	const tasks = gatingNodeTasks(node);
	const done = tasks.filter((t) => t.done).length;

	const heading = "#".repeat(Math.min(depth + 1, 6));
	lines.push(`${heading} ${node.title ?? node.id} [${node.status}]`);

	const after = (node.after ?? []).filter((ref) => ref !== PARENT_AFTER_TOKEN);
	if (after.length) {
		lines.push(`After: ${after.join(", ")}`);
	}

	if (node.prUrl) {
		lines.push(`PR: ${node.prUrl}`);
	}

	if (tasks.length > 0) {
		lines.push(`Tasks: ${done}/${tasks.length} complete`);
		for (const t of tasks) {
			lines.push(`  ${t.done ? "[x]" : "[ ]"} ${t.title}`);
		}
	}

	// Live run state from the executor
	const state = executor.getStates().get(node.id);
	if (state) {
		if (state.blocked) {
			lines.push(`Blocked: ${state.blocked}`);
		}
		lines.push(`Agent: ${state.displayName ?? node.id} — ${state.status}`);
	}

	// Summaries for complete nodes
	if (opts.includeSummaries && node.summary) {
		lines.push(`Summary:\n${node.summary}`);
	}

	return lines.join("\n");
}
