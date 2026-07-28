// Plan-aware compaction instructions for a running agent.

/**
 * Build plan-aware compaction instructions for a running agent.
 * This shapes what the compaction preserves vs drops.
 */
export function buildPlanAwareCompactionMarker(opts: {
	deliverableId: string;
	deliverableTitle: string;
	remainingTasks: Array<{ title: string; body?: string }>;
	completedTasks: Array<{ title: string }>;
	depSummaryIds: string[];
}): string {
	const remaining = opts.remainingTasks
		.map((t) => `- ${t.title}${t.body ? `: ${t.body}` : ""}`)
		.join("\n");

	const completed = opts.completedTasks.map((t) => `- ${t.title} ✓`).join("\n");

	const deps =
		opts.depSummaryIds.length > 0
			? opts.depSummaryIds.map((id) => `- ${id}: available in plan`).join("\n")
			: "(none)";

	return `Compacting agent session for deliverable: ${opts.deliverableId} — ${opts.deliverableTitle}

Remaining tasks (MUST preserve context for):
${remaining || "(all done)"}

Completed tasks (can drop raw details, keep outcomes):
${completed || "(none yet)"}

Dependency context (already in seed, don't duplicate):
${deps}

Preserve: decisions made, current approach, errors encountered, progress on remaining tasks.
Drop: verbose tool output from completed tasks, exploration that led nowhere, repeated content from seed.`;
}
