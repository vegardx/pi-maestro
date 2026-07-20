// Agent lifecycle management for the node model. Defines how worker nodes
// are seeded, how they produce summaries, and the canonical node branch name.
//
// v2 note: the AgentSpec support-agent layer is gone — support agents are
// child PlanNodes scheduled by the executor (readyChildren), and base-branch
// derivation lives in plan/schema.ts (deriveBase). The AgentSpec-typed
// helpers (buildAgentSeed, agentSummaryConsumer, nextUnblockedAgents,
// resolveBaseBranch) died with it.

import {
	gatingNodeTasks,
	type NodeTask,
	type PlanNode,
} from "./plan/schema.js";

// ─── Seed construction ───────────────────────────────────────────────────────

export interface SeedContext {
	/** Summaries from completed upstream nodes (`after` dependency chain). */
	depSummaries: string[];
	/** Summaries from sibling nodes that completed earlier in this group. */
	siblingeSummaries: string[];
}

/**
 * Build the seed for a worker node.
 * Ordering: dep summaries → node body → tasks
 */
export function buildWorkerSeed(node: PlanNode, ctx: SeedContext): string {
	const parts: string[] = [];

	// Stable prefix: dep summaries (shared with every agent under this node)
	if (ctx.depSummaries.length > 0) {
		parts.push("## Context from completed deliverables\n");
		parts.push(ctx.depSummaries.join("\n\n"));
	}

	// Node-specific
	parts.push(`## Deliverable: ${node.title ?? node.id}\n`);
	if (node.body) parts.push(node.body);

	// Tasks
	const tasks = gatingNodeTasks(node);
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
 * Build the consumer description for a worker node's summary.
 * Tells the worker who will read its summary (reviewer children or
 * downstream sibling nodes).
 */
export function workerSummaryConsumer(
	node: PlanNode,
	nextNodes: readonly PlanNode[],
): string {
	if (nextNodes.length > 0) {
		const names = nextNodes
			.map((next) => `${next.id} (${next.title ?? next.persona})`)
			.join(", ");
		return (
			`The following agents will review your work: ${names}. ` +
			"Summarize what you built, key decisions, and anything they should scrutinize."
		);
	}
	return (
		"Downstream deliverables will consume your summary. " +
		"Summarize what was built, public API, key decisions, and edge cases."
	);
}

// ─── Branches ────────────────────────────────────────────────────────────────

/**
 * Get the canonical branch name for a node id (`feat/<id>`).
 */
export function deliverableBranch(deliverableId: string): string {
	return `feat/${deliverableId}`;
}

// ─── Completion detection ────────────────────────────────────────────────────

/**
 * Check if a worker node is done (all gating tasks toggled).
 */
export function isWorkerComplete(node: PlanNode): boolean {
	const tasks = gatingNodeTasks(node);
	if (tasks.length === 0) return false;
	return tasks.every((t) => t.done);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTask(task: NodeTask): string {
	const checkbox = task.done ? "[x]" : "[ ]";
	const body = task.body ? `\n${task.body}` : "";
	return `${checkbox} **${task.title}**${body}`;
}
