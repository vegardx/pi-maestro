// Dashboard widget for the group-based execution model.
// Renders a tree of groups → agents with real-time status.

import type { GroupExecutor, GroupRunState } from "./group-executor.js";
import type { PlanEngine } from "./engine.js";
import type { WorkGroup } from "./schema.js";

export interface DashboardLine {
	indent: number;
	icon: string;
	label: string;
	meta?: string;
}

const STATUS_ICONS: Record<string, string> = {
	planned: "○",
	active: "●",
	complete: "✓",
	shipped: "🚀",
	superseded: "⤳",
	abandoned: "✗",
};

const AGENT_ICONS: Record<string, string> = {
	pending: "◌",
	spawning: "⟳",
	working: "▶",
	summarizing: "↻",
	done: "✓",
	failed: "✗",
};

/**
 * Render the full dashboard as an array of styled lines.
 * Each line has an indent level, icon, label, and optional metadata.
 */
export function renderDashboard(
	engine: PlanEngine,
	executor: GroupExecutor,
): DashboardLine[] {
	const plan = engine.get();
	const states = executor.getStates();
	const lines: DashboardLine[] = [];

	lines.push({
		indent: 0,
		icon: "📋",
		label: plan.title,
		meta: `${plan.groups.length} groups`,
	});

	for (const group of plan.groups) {
		const state = states.get(group.id);
		lines.push(renderGroupLine(group));

		if (state) {
			for (const [name, agentState] of state.agents) {
				lines.push(renderAgentLine(name, agentState));
			}
		}
	}

	return lines;
}

function renderGroupLine(group: WorkGroup): DashboardLine {
	const icon = STATUS_ICONS[group.status] ?? "?";
	const depInfo = group.dependsOn?.length
		? ` [after: ${group.dependsOn.join(", ")}]`
		: "";
	return {
		indent: 1,
		icon,
		label: group.title,
		meta: `${group.status}${depInfo}`,
	};
}

function renderAgentLine(
	name: string,
	state: { status: string; displayName?: string },
): DashboardLine {
	const icon = AGENT_ICONS[state.status] ?? "?";
	const display = state.displayName ?? name;
	return {
		indent: 2,
		icon,
		label: display,
		meta: state.status,
	};
}

/**
 * Render dashboard as a plain-text string for terminal/log output.
 */
export function renderDashboardText(
	engine: PlanEngine,
	executor: GroupExecutor,
): string {
	const lines = renderDashboard(engine, executor);
	return lines
		.map((l) => {
			const pad = "  ".repeat(l.indent);
			const meta = l.meta ? ` (${l.meta})` : "";
			return `${pad}${l.icon} ${l.label}${meta}`;
		})
		.join("\n");
}
