// Renders the live agent status panel (string[] for setWidget).
// Box-drawn with top + sides, no bottom border (editor provides the boundary).

import type { Deliverable, WorkItem } from "./schema.js";

export interface AgentState {
	readonly name: string;
	readonly role: string;
	readonly deliverableTitle: string;
	readonly status: "active" | "done" | "waiting";
	readonly tasksDone: number;
	readonly tasksTotal: number;
	readonly currentTask?: string;
	readonly elapsedMs: number;
}

function elapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${s % 60}s`;
}

export function renderAgentWidget(
	agents: readonly AgentState[],
	width = 80,
): string[] {
	if (agents.length === 0) return [];

	// Build the top border: ┌ Agents ─────── /a ┐
	const title = " Agents ";
	const hint = " /a ";
	const borderFill = Math.max(0, width - 2 - title.length - hint.length);
	const topBorder = `\u250C${title}${"─".repeat(borderFill)}${hint}\u2510`;

	const lines: string[] = [topBorder];

	for (const a of agents) {
		const progress = `${a.tasksDone}/${a.tasksTotal}`;
		const activity =
			a.status === "done"
				? "done"
				: a.status === "waiting"
					? "\u26A0 waiting for input"
					: (a.currentTask ?? "working");
		const time = elapsed(a.elapsedMs);

		// Build content: name  role  deliverable  progress  activity  time
		const content = `${a.name}  ${a.role}  ${a.deliverableTitle}  ${progress}  ${activity}  ${time}`;

		// Pad to fill the box width (minus the 2 border chars │ │)
		const inner = width - 4; // "│ " + content + " │"
		const padded =
			content.length >= inner
				? content.slice(0, inner)
				: content + " ".repeat(inner - content.length);

		lines.push(`\u2502 ${padded} \u2502`);
	}

	return lines;
}

export function renderAgentWidgetCollapsed(
	agents: readonly AgentState[],
): string[] {
	const active = agents.filter((a) => a.status === "active").length;
	const waiting = agents.filter((a) => a.status === "waiting").length;
	const done = agents.filter((a) => a.status === "done").length;
	const parts: string[] = [];
	if (active > 0) parts.push(`${active} active`);
	if (waiting > 0) parts.push(`${waiting} waiting`);
	if (done > 0) parts.push(`${done} done`);
	const suffix =
		active === 0 && waiting === 0 && done > 0 ? " \u00B7 ready to ship" : "";
	return [`Agents: ${parts.join(" \u00B7 ")}${suffix}  /a`];
}

/** Build AgentState from a deliverable (for task progress tracking). */
export function agentStateFromDeliverable(
	name: string,
	role: string,
	d: Deliverable,
	status: AgentState["status"],
	startedAt: number,
	endedAt?: number,
): AgentState {
	const items = (d.children ?? []).filter(
		(c): c is WorkItem =>
			c.type === "work-item" && (c.kind === "task" || !c.kind),
	);
	const doneCount = items.filter((i) => i.done).length;
	const firstUndone = items.find((i) => !i.done);
	return {
		name,
		role,
		deliverableTitle: shortTitle(d.title ?? d.id),
		status,
		tasksDone: doneCount,
		tasksTotal: items.length,
		currentTask: firstUndone?.title,
		elapsedMs: (endedAt ?? Date.now()) - startedAt,
	};
}

function shortTitle(title: string): string {
	return title
		.replace(
			/^(implement|add|fix|build|create|set up|write|update|enable)\s+/i,
			"",
		)
		.trim();
}
