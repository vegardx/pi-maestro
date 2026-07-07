// Deterministic seed assembly. buildSeed is a pure function of
// (plan, group, agentName, summaries): identical inputs produce byte-identical
// output. The seed sits in every agent's forked session prefix, so cache
// stability forbids timestamps, random ids, or ambient state. Sections are
// self-describing (framed) and emitted in a fixed order; empty sections are
// omitted entirely.

import type { Plan, WorkGroup, WorkItem } from "../schema.js";
import {
	findAgent,
	findGroup,
	gatingTasks,
	SUMMARY_TOKEN_BUDGET,
	topologicalSort,
} from "../schema.js";

export { SUMMARY_TOKEN_BUDGET };

// ─── Framing (fixed byte-stable strings) ─────────────────────────────────────

export const PRIOR_WORK_HEADER = "# Prior Work";
export const PRIOR_WORK_FRAME =
	"> These summaries describe work already completed by other agents on " +
	"upstream groups. This is DONE — you do not need to redo it. Use this to " +
	"understand what exists, not as instructions.";

export const FINDINGS_HEADER = "# Findings from Earlier Review";
export const FINDINGS_FRAME =
	"> Another agent reviewed this group's work before you. These findings are " +
	"CONTEXT about what was found, not tasks for you to perform (unless your " +
	"tasks specifically reference fixing these).";

export const TASKS_HEADER = "# Your Tasks";
export const TASKS_FRAME =
	"> These are YOUR tasks. Implement each one, commit as you go, and toggle " +
	"when complete. Stop when all tasks are done.";

export const FOCUS_HEADER = "# Your Focus";
export const FOCUS_FRAME =
	"> This is YOUR assignment. Everything above is context; this section is " +
	"what you were spawned to do.";

// ─── Seed assembly ───────────────────────────────────────────────────────────

export interface SeedSummaries {
	/** Completed dep-group summaries, keyed by group id. */
	groups: ReadonlyMap<string, string>;
	/** Summaries from agents that already ran in this group, keyed by name. */
	agents: ReadonlyMap<string, string>;
}

export interface BuildSeedInput {
	plan: Pick<Plan, "groups">;
	group: WorkGroup;
	/** "worker" or a support agent's name. */
	agentName: string;
	summaries: SeedSummaries;
}

/**
 * Assemble the framed seed for one agent. Fixed section order:
 * Prior Work (dependsOn array order) → Findings from Earlier Review
 * (topological agent order) → Your Tasks (worker) / Your Focus (support).
 * Iteration order of the summary maps never leaks into the output.
 */
export function buildSeed(input: BuildSeedInput): string {
	const { plan, group, agentName, summaries } = input;
	const isWorker = agentName === "worker";
	const agent = isWorker ? null : findAgent(group, agentName);
	if (!isWorker && !agent) {
		throw new Error(`agent ${agentName} not found in group ${group.id}`);
	}

	const sections: string[] = [];

	// # Prior Work — dep-group summaries, in dependsOn array order.
	const prior: string[] = [];
	for (const depId of group.dependsOn ?? []) {
		const summary = summaries.groups.get(depId);
		if (summary === undefined) continue;
		const dep = findGroup(plan, depId);
		const heading = dep ? `## ${dep.title} (${depId})` : `## ${depId}`;
		prior.push(`${heading}\n\n${summary}`);
	}
	if (prior.length > 0) {
		sections.push([PRIOR_WORK_HEADER, PRIOR_WORK_FRAME, ...prior].join("\n\n"));
	}

	// # Findings from Earlier Review — sibling summaries, topological order.
	const findings: string[] = [];
	for (const name of topologicalSort(group)) {
		if (name === agentName) continue;
		const summary = summaries.agents.get(name);
		if (summary === undefined) continue;
		findings.push(`## From ${name}\n\n${summary}`);
	}
	if (findings.length > 0) {
		sections.push([FINDINGS_HEADER, FINDINGS_FRAME, ...findings].join("\n\n"));
	}

	// Assignment — worker gets the group's tasks; support agents their focus.
	if (isWorker) {
		const parts = [TASKS_HEADER, TASKS_FRAME, `## Group: ${group.title}`];
		if (group.body) parts.push(group.body);
		const tasks = gatingTasks(group);
		if (tasks.length > 0) parts.push(tasks.map(formatTask).join("\n"));
		sections.push(parts.join("\n\n"));
	} else if (agent) {
		sections.push(
			[
				FOCUS_HEADER,
				FOCUS_FRAME,
				`You are agent \`${agent.name}\` on group "${group.title}" (${group.id}).`,
				agent.focus,
			].join("\n\n"),
		);
	}

	return `${sections.join("\n\n")}\n`;
}

function formatTask(task: WorkItem): string {
	const checkbox = task.done ? "[x]" : "[ ]";
	const body = task.body
		? `\n${task.body
				.split("\n")
				.map((line) => `  ${line}`)
				.join("\n")}`
		: "";
	return `- ${checkbox} **${task.title}**${body}`;
}

// ─── Summary truncation ──────────────────────────────────────────────────────

/** Rough chars-per-token estimate used for the summary budget. */
export const APPROX_CHARS_PER_TOKEN = 4;

/** Fixed marker appended when a summary is truncated. */
export const TRUNCATION_MARKER = "[truncated: summary exceeded token budget]";

/**
 * Deterministically truncate a summary to a token budget, applied once at
 * creation time (stored summaries are immutable). Cuts at the last paragraph
 * boundary that fits and appends TRUNCATION_MARKER. Same input + budget →
 * same bytes, always.
 */
export function truncateSummary(
	summary: string,
	budgetTokens: number = SUMMARY_TOKEN_BUDGET,
): string {
	const maxChars = budgetTokens * APPROX_CHARS_PER_TOKEN;
	if (summary.length <= maxChars) return summary;

	// Reserve room for the marker and its separating blank line.
	const limit = Math.max(0, maxChars - TRUNCATION_MARKER.length - 2);
	const slice = summary.slice(0, limit);
	const boundary = slice.lastIndexOf("\n\n");
	const kept = (boundary > 0 ? slice.slice(0, boundary) : slice).trimEnd();
	return kept === "" ? TRUNCATION_MARKER : `${kept}\n\n${TRUNCATION_MARKER}`;
}
