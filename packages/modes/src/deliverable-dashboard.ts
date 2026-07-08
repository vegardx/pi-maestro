// Dashboard widget for the deliverable-based execution model.
// Renders a tree of deliverables → agents with real-time status.

import type { DeliverableExecutor } from "./deliverable-executor.js";
import type { PlanEngine } from "./engine.js";
import type { Deliverable } from "./schema.js";

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
	executor: DeliverableExecutor,
): DashboardLine[] {
	const plan = engine.get();
	const states = executor.getStates();
	const lines: DashboardLine[] = [];

	lines.push({
		indent: 0,
		icon: "📋",
		label: plan.title,
		meta: `${plan.deliverables.length} deliverables`,
	});

	for (const deliverable of plan.deliverables) {
		const state = states.get(deliverable.id);
		lines.push(renderDeliverableLine(deliverable));

		if (state) {
			for (const [name, agentState] of state.agents) {
				lines.push(renderAgentLine(name, agentState));
			}
		}
	}

	return lines;
}

function renderDeliverableLine(deliverable: Deliverable): DashboardLine {
	const icon = STATUS_ICONS[deliverable.status] ?? "?";
	const depInfo = deliverable.dependsOn?.length
		? ` [after: ${deliverable.dependsOn.join(", ")}]`
		: "";
	return {
		indent: 1,
		icon,
		label: deliverable.title,
		meta: `${deliverable.status}${depInfo}`,
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
	executor: DeliverableExecutor,
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
