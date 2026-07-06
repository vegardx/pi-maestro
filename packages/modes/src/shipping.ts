// Shipping for the group model. The maestro owns shipping — agents never
// push or create PRs. This module provides the concrete implementation of
// the `shipGroup` dependency that the GroupExecutor calls.

import type { WorkGroup } from "./schema.js";
import { gatingTasks } from "./schema.js";

export interface ShipGroupInput {
	group: WorkGroup;
	branch: string;
	worktreePath: string;
	/** Agent summaries assembled into PR body sections. */
	agentReports: string[];
}

export interface ShipGroupResult {
	prUrl: string;
	prNumber: number;
}

/**
 * Build the PR body for a shipped group.
 */
export function buildPrBody(group: WorkGroup, agentReports: string[]): string {
	const sections: string[] = [];

	// Group description
	if (group.body) {
		sections.push(group.body);
	}

	// Task checklist
	const tasks = gatingTasks(group);
	if (tasks.length > 0) {
		const list = tasks.map((t) => `- [x] ${t.title}`).join("\n");
		sections.push(`## Tasks\n\n${list}`);
	}

	// Agent reports
	if (agentReports.length > 0) {
		sections.push(`## Agent Reports\n\n${agentReports.join("\n\n")}`);
	}

	return sections.join("\n\n");
}

/**
 * Determine if a group needs shipping (complete + terminal).
 * Used by the executor — external callers use shippableGroups() from schema.
 */
export function shouldShip(group: WorkGroup, hasDownstreamDeps: boolean): boolean {
	return group.status === "complete" && !hasDownstreamDeps;
}
