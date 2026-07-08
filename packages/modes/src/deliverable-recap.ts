// Recap for the deliverable model. Produces a concise text summary of plan
// progress — useful when the maestro session resumes or a compaction
// boundary is hit.

import type { DeliverableExecutor } from "./deliverable-executor.js";
import type { PlanEngine } from "./engine.js";
import type { Deliverable } from "./schema.js";
import { gatingTasks } from "./schema.js";

export interface RecapOptions {
	/** Include agent summaries for complete deliverables. */
	includeSummaries?: boolean;
}

/**
 * Build a recap of plan progress. Returns a markdown string suitable
 * for injection into a new maestro turn or compaction seed.
 */
export function buildRecap(
	engine: PlanEngine,
	executor: DeliverableExecutor,
	opts: RecapOptions = {},
): string {
	const plan = engine.get();
	const sections: string[] = [];

	sections.push(`# Plan: ${plan.title}`);
	sections.push(
		`Slug: \`${plan.slug}\` · ${plan.deliverables.length} deliverables`,
	);

	// Status summary
	const counts = countStatuses(plan.deliverables);
	const statusLine = Object.entries(counts)
		.filter(([_, n]) => n > 0)
		.map(([s, n]) => `${s}: ${n}`)
		.join(" · ");
	sections.push(statusLine);

	// Per-deliverable detail
	for (const deliverable of plan.deliverables) {
		sections.push(renderDeliverableRecap(deliverable, executor, opts));
	}

	return sections.join("\n\n");
}

function countStatuses(
	deliverables: readonly Deliverable[],
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const g of deliverables) {
		counts[g.status] = (counts[g.status] ?? 0) + 1;
	}
	return counts;
}

function renderDeliverableRecap(
	deliverable: Deliverable,
	executor: DeliverableExecutor,
	opts: RecapOptions,
): string {
	const lines: string[] = [];
	const tasks = gatingTasks(deliverable);
	const done = tasks.filter((t) => t.done).length;

	lines.push(`## ${deliverable.title} [${deliverable.status}]`);

	if (deliverable.dependsOn?.length) {
		lines.push(`Depends on: ${deliverable.dependsOn.join(", ")}`);
	}

	if (deliverable.prUrl) {
		lines.push(`PR: ${deliverable.prUrl}`);
	}

	if (tasks.length > 0) {
		lines.push(`Tasks: ${done}/${tasks.length} complete`);
		for (const t of tasks) {
			lines.push(`  ${t.done ? "[x]" : "[ ]"} ${t.title}`);
		}
	}

	// Agent status from executor
	const state = executor.getStates().get(deliverable.id);
	if (state) {
		if (state.round > 0) {
			lines.push(`Fix rounds: ${state.round}`);
		}
		if (state.blocked) {
			lines.push(`Blocked: ${state.blocked}`);
		}
		const agentLines: string[] = [];
		for (const [name, a] of state.agents) {
			const display = a.displayName ?? name;
			agentLines.push(`  ${display}: ${a.status}`);
		}
		if (agentLines.length > 0) {
			lines.push(`Agents:\n${agentLines.join("\n")}`);
		}
	}

	// Summaries for complete deliverables
	if (opts.includeSummaries && deliverable.summary) {
		lines.push(`Summary:\n${deliverable.summary}`);
	}

	return lines.join("\n");
}
