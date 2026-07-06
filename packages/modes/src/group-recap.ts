// Recap for the group model. Produces a concise text summary of plan
// progress — useful when the maestro session resumes or a compaction
// boundary is hit.

import type { PlanEngine } from "./engine.js";
import type { GroupExecutor } from "./group-executor.js";
import type { WorkGroup } from "./schema.js";
import { gatingTasks } from "./schema.js";

export interface RecapOptions {
	/** Include agent summaries for complete groups. */
	includeSummaries?: boolean;
}

/**
 * Build a recap of plan progress. Returns a markdown string suitable
 * for injection into a new maestro turn or compaction seed.
 */
export function buildRecap(
	engine: PlanEngine,
	executor: GroupExecutor,
	opts: RecapOptions = {},
): string {
	const plan = engine.get();
	const sections: string[] = [];

	sections.push(`# Plan: ${plan.title}`);
	sections.push(`Slug: \`${plan.slug}\` · ${plan.groups.length} groups`);

	// Status summary
	const counts = countStatuses(plan.groups);
	const statusLine = Object.entries(counts)
		.filter(([_, n]) => n > 0)
		.map(([s, n]) => `${s}: ${n}`)
		.join(" · ");
	sections.push(statusLine);

	// Per-group detail
	for (const group of plan.groups) {
		sections.push(renderGroupRecap(group, executor, opts));
	}

	return sections.join("\n\n");
}

function countStatuses(groups: readonly WorkGroup[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const g of groups) {
		counts[g.status] = (counts[g.status] ?? 0) + 1;
	}
	return counts;
}

function renderGroupRecap(
	group: WorkGroup,
	executor: GroupExecutor,
	opts: RecapOptions,
): string {
	const lines: string[] = [];
	const tasks = gatingTasks(group);
	const done = tasks.filter((t) => t.done).length;

	lines.push(`## ${group.title} [${group.status}]`);

	if (group.dependsOn?.length) {
		lines.push(`Depends on: ${group.dependsOn.join(", ")}`);
	}

	if (tasks.length > 0) {
		lines.push(`Tasks: ${done}/${tasks.length} complete`);
		for (const t of tasks) {
			lines.push(`  ${t.done ? "[x]" : "[ ]"} ${t.title}`);
		}
	}

	// Agent status from executor
	const state = executor.getStates().get(group.id);
	if (state) {
		const agentLines: string[] = [];
		for (const [name, a] of state.agents) {
			const display = a.displayName ?? name;
			agentLines.push(`  ${display}: ${a.status}`);
		}
		if (agentLines.length > 0) {
			lines.push(`Agents:\n${agentLines.join("\n")}`);
		}
	}

	// Summaries for complete groups
	if (opts.includeSummaries && group.summary) {
		lines.push(`Summary:\n${group.summary}`);
	}

	return lines.join("\n");
}
