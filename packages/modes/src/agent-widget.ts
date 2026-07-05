// Renders the agent status panel with proper column alignment.
// Uses truncateToWidth for fixed-width cells that respect terminal width.

import { truncateToWidth } from "@earendil-works/pi-tui";
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
	readonly tokensIn?: number;
	readonly tokensOut?: number;
	readonly cost?: number;
}

function elapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
	return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function fmtTokens(n: number | undefined): string {
	if (n === undefined || n === 0) return "-";
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function _fmtCost(n: number | undefined): string {
	if (n === undefined || n === 0) return "";
	return `$${n.toFixed(3)}`;
}

/**
 * Column layout definition. Each column has a min width and whether it's
 * right-aligned. Flexible columns expand to fill remaining space.
 */
interface Column {
	readonly min: number;
	readonly flex?: boolean;
	readonly right?: boolean;
}

const COLUMNS: Column[] = [
	{ min: 14 }, // name (flying-falcon)
	{ min: 7 }, // role (worker)
	{ min: 10, flex: true }, // deliverable
	{ min: 3 }, // progress (2/4)
	{ min: 12, flex: true }, // activity
	{ min: 6 }, // tokens ↑
	{ min: 6 }, // tokens ↓
	{ min: 4, right: true }, // time
];

function buildRow(cells: string[], width: number): string {
	const innerWidth = width - 4; // "│ " + content + " │"
	const totalMin = COLUMNS.reduce((s, c) => s + c.min, 0);
	const gaps = COLUMNS.length - 1; // 2-space gaps between columns
	const gapSpace = gaps * 2;
	const flexCols = COLUMNS.filter((c) => c.flex);
	const extra = Math.max(0, innerWidth - totalMin - gapSpace);
	const flexBonus =
		flexCols.length > 0 ? Math.floor(extra / flexCols.length) : 0;

	const parts: string[] = [];
	for (let i = 0; i < COLUMNS.length; i++) {
		const col = COLUMNS[i];
		const w = col.min + (col.flex ? flexBonus : 0);
		const cell = cells[i] ?? "";
		parts.push(truncateToWidth(cell, w, "\u2026", true));
	}
	const row = parts.join("  ");
	return `\u2502 ${truncateToWidth(row, innerWidth, "\u2026", true)} \u2502`;
}

export function renderAgentWidget(
	agents: readonly AgentState[],
	width = 80,
): string[] {
	if (agents.length === 0) return [];

	// Top border: ┌ Agents ─── /a ┐
	const title = " Agents ";
	const hint = " /a ";
	const borderFill = Math.max(0, width - 2 - title.length - hint.length);
	const topBorder = `\u250C${title}${"\u2500".repeat(borderFill)}${hint}\u2510`;

	const lines: string[] = [topBorder];

	for (const a of agents) {
		const progress = `${a.tasksDone}/${a.tasksTotal}`;
		const activity =
			a.status === "done"
				? "done"
				: a.status === "waiting"
					? "\u26A0 waiting"
					: (a.currentTask ?? "working");
		const tokens =
			a.tokensIn || a.tokensOut ? `\u2191${fmtTokens(a.tokensIn)}` : "";
		const tokensOut =
			a.tokensIn || a.tokensOut ? `\u2193${fmtTokens(a.tokensOut)}` : "";
		const time = elapsed(a.elapsedMs);

		const cells = [
			a.name,
			a.role,
			a.deliverableTitle,
			progress,
			activity,
			tokens,
			tokensOut,
			time,
		];
		lines.push(buildRow(cells, width));
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
	tokens?: { in: number; out: number; cost: number },
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
		tokensIn: tokens?.in,
		tokensOut: tokens?.out,
		cost: tokens?.cost,
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
