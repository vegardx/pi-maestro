// Forward-looking summary generation for completed groups.
// Shapes what a completed group's output looks like to downstream consumers.

/**
 * Input for building a forward-looking summary prompt.
 * Used when a group completes and needs to produce a summary
 * for downstream groups that depend on it.
 */
export interface ForwardSummaryInput {
	completed: {
		title: string;
		body: string;
	};
	agentOutput: string;
	consumers: Array<{
		title: string;
		body: string;
		tasks: string[];
	}>;
}

/**
 * Build the prompt for generating a forward-looking summary.
 * The summary is shaped by WHO will read it (downstream consumers).
 */
export function buildForwardSummaryPrompt(input: ForwardSummaryInput): string {
	const consumerLines = input.consumers
		.map(
			(c) =>
				`- ${c.title}: "${c.body}"\n  Tasks: ${c.tasks.join(", ") || "(none)"}`,
		)
		.join("\n");

	return `You are summarizing the output of a completed group for downstream consumers.

## Completed group
Title: ${input.completed.title}
Description: ${input.completed.body}

## Agent output
${input.agentOutput || "(no output captured)"}

## Downstream consumers (who will read this summary)
${consumerLines}

## Instructions
Write a concise summary (max 200 words) of what this group produced.
Preserve ONLY what downstream consumers need to do their work.
Focus on: public API, behavior, signatures, edge cases, decisions made.
Omit: implementation internals, refactoring history, test iteration, tool output.
Format: factual, terse. No filler words.`;
}

/**
 * Build plan-aware compaction instructions for a running agent.
 * This shapes what the compaction preserves vs drops.
 */
export function buildPlanAwareCompactionMarker(opts: {
	groupId: string;
	groupTitle: string;
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

	return `Compacting agent session for group: ${opts.groupId} — ${opts.groupTitle}

Remaining tasks (MUST preserve context for):
${remaining || "(all done)"}

Completed tasks (can drop raw details, keep outcomes):
${completed || "(none yet)"}

Dependency context (already in seed, don't duplicate):
${deps}

Preserve: decisions made, current approach, errors encountered, progress on remaining tasks.
Drop: verbose tool output from completed tasks, exploration that led nowhere, repeated content from seed.`;
}
