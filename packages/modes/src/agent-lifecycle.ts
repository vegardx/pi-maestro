// Agent lifecycle management. Defines how agents are seeded, how they
// produce summaries, and how stacked branches work.

import type { AgentSpec, WorkGroup, WorkItem } from "./schema.js";
import { gatingTasks } from "./schema.js";

// ─── Seed construction ───────────────────────────────────────────────────────

export interface SeedContext {
	/** Summaries from completed upstream groups (dependency chain). */
	depSummaries: string[];
	/** Summaries from sibling agents that completed earlier in this group. */
	siblingeSummaries: string[];
}

/**
 * Build the seed for a worker agent.
 * Ordering: dep summaries → group body → tasks
 */
export function buildWorkerSeed(group: WorkGroup, ctx: SeedContext): string {
	const parts: string[] = [];

	// Stable prefix: dep summaries (shared with all agents in this group)
	if (ctx.depSummaries.length > 0) {
		parts.push("## Context from completed groups\n");
		parts.push(ctx.depSummaries.join("\n\n"));
	}

	// Group-specific
	parts.push(`## Group: ${group.title}\n`);
	if (group.body) parts.push(group.body);

	// Tasks
	const tasks = gatingTasks(group);
	if (tasks.length > 0) {
		parts.push("\n## Tasks\n");
		parts.push(tasks.map((t) => formatTask(t)).join("\n\n"));
	}

	// Worker instructions
	parts.push("\n## Instructions\n");
	parts.push(
		"Implement each task. Commit as you go (small, focused commits). " +
			"Toggle each task when done (`task toggle`). " +
			"When all tasks are toggled, your work is complete. " +
			"The maestro handles pushing and opening the PR.",
	);

	return parts.join("\n");
}

/**
 * Build the seed for a support agent.
 * Ordering: dep summaries → sibling summaries → focus
 */
export function buildAgentSeed(
	group: WorkGroup,
	agent: AgentSpec,
	ctx: SeedContext,
): string {
	const parts: string[] = [];

	// Stable prefix: dep summaries
	if (ctx.depSummaries.length > 0) {
		parts.push("## Context from completed groups\n");
		parts.push(ctx.depSummaries.join("\n\n"));
	}

	// Sibling summaries (accumulated from prior agents)
	if (ctx.siblingeSummaries.length > 0) {
		parts.push("\n## Prior agent results\n");
		parts.push(ctx.siblingeSummaries.join("\n\n"));
	}

	// Agent-specific focus (cache-busting suffix)
	parts.push(`\n## Your Focus: ${agent.name}\n`);
	parts.push(agent.focus);

	// Agent instructions
	parts.push("\n## Instructions\n");
	if (agent.mode === "read-only") {
		parts.push(
			"You are a read-only reviewer. Examine the code and report findings. " +
				"You cannot edit files or make commits. " +
				"Write your analysis clearly — the maestro will extract your summary.",
		);
	} else {
		parts.push(
			"Review and fix issues in your focus area. Commit fixes as you go. " +
				"When done, the maestro will extract your summary.",
		);
	}

	return parts.join("\n");
}

// ─── Summary protocol ────────────────────────────────────────────────────────

/**
 * Build the RPC summarize instruction sent to an agent when it's done.
 * The agent does one final turn producing a forward-looking summary.
 */
export function buildSummarizeInstruction(
	consumer: string,
	preamble: string,
): { type: "summarize"; consumer: string; preamble: string } {
	return { type: "summarize", consumer, preamble };
}

/**
 * Build the consumer description for a worker's summary.
 * Tells the worker who will read its summary (downstream agents or groups).
 */
export function workerSummaryConsumer(
	group: WorkGroup,
	nextAgents: AgentSpec[],
): string {
	if (nextAgents.length > 0) {
		const names = nextAgents.map((a) => `${a.name} (${a.focus})`).join(", ");
		return (
			`The following agents will review your work: ${names}. ` +
			"Summarize what you built, key decisions, and anything they should scrutinize."
		);
	}
	return (
		"Downstream groups will consume your summary. " +
		"Summarize what was built, public API, key decisions, and edge cases."
	);
}

/**
 * Build the consumer description for a support agent's summary.
 */
export function agentSummaryConsumer(
	_agent: AgentSpec,
	nextAgents: AgentSpec[],
	isLastAgent: boolean,
): string {
	if (isLastAgent) {
		return (
			"This is the final agent summary for the group. " +
			"Summarize your findings, any issues found, and whether the work is acceptable."
		);
	}
	const names = nextAgents.map((a) => `${a.name} (${a.focus})`).join(", ");
	return `Next agents: ${names}. Summarize findings relevant to their focus areas.`;
}

// ─── Stacked branches ────────────────────────────────────────────────────────

/**
 * Determine the base branch for a group's worktree.
 * Stacked: branch from predecessor tip. Non-stacked: branch from main.
 */
export function resolveBaseBranch(
	group: WorkGroup,
	allGroups: readonly WorkGroup[],
	defaultBranch: string,
): string {
	// No dependencies → branch from main
	if (!group.dependsOn?.length) return defaultBranch;

	// Explicitly non-stacked → branch from main
	if (group.stacked === false) return defaultBranch;

	// Stacked (default): branch from last dependency's branch
	const lastDep = group.dependsOn[group.dependsOn.length - 1];
	const depGroup = allGroups.find((g) => g.id === lastDep);
	if (!depGroup) return defaultBranch;

	return `feat/${depGroup.id}`;
}

/**
 * Get the branch name for a group.
 */
export function groupBranch(groupId: string): string {
	return `feat/${groupId}`;
}

// ─── Completion detection ────────────────────────────────────────────────────

/**
 * Check if a worker agent is done (all gating tasks toggled).
 */
export function isWorkerComplete(group: WorkGroup): boolean {
	const tasks = gatingTasks(group);
	if (tasks.length === 0) return false;
	return tasks.every((t) => t.done);
}

/**
 * Determine next agents to spawn based on what just completed.
 * Returns agents whose `after` deps are all in the `completed` set.
 */
export function nextUnblockedAgents(
	group: WorkGroup,
	completed: ReadonlySet<string>,
): AgentSpec[] {
	return group.agents.filter((agent) =>
		agent.after.every((dep) => completed.has(dep)),
	);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTask(task: WorkItem): string {
	const checkbox = task.done ? "[x]" : "[ ]";
	const body = task.body ? `\n${task.body}` : "";
	return `${checkbox} **${task.title}**${body}`;
}
