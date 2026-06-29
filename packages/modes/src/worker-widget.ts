// Renders the live worker status widget (string[] for setWidget).

import type { Deliverable, WorkItem } from "./schema.js";

export interface WorkerState {
	readonly name: string;
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

function icon(status: WorkerState["status"]): string {
	if (status === "done") return "✓";
	if (status === "waiting") return "⚠";
	return "●";
}

export function renderWorkerWidget(workers: readonly WorkerState[]): string[] {
	if (workers.length === 0) return [];
	const lines: string[] = [];
	for (const w of workers) {
		const progress = `${w.tasksDone}/${w.tasksTotal}`;
		const task = w.status === "done" ? "done" : (w.currentTask ?? "working");
		const time = elapsed(w.elapsedMs);
		lines.push(
			`${icon(w.status)} ${w.name}   ${w.deliverableTitle}   ${progress}  ${task}   [${time}]`,
		);
	}
	lines[lines.length - 1] += "  (/w)";
	return lines;
}

export function renderWorkerWidgetCollapsed(
	workers: readonly WorkerState[],
): string[] {
	const active = workers.filter((w) => w.status === "active").length;
	const waiting = workers.filter((w) => w.status === "waiting").length;
	const done = workers.filter((w) => w.status === "done").length;
	const parts: string[] = [];
	if (active > 0) parts.push(`${active} active`);
	if (waiting > 0) parts.push(`${waiting} waiting`);
	if (done > 0) parts.push(`${done} done`);
	const suffix =
		active === 0 && waiting === 0 && done > 0 ? " · ready to ship" : "";
	return [`Workers: ${parts.join(" · ")}${suffix}  (/w)`];
}

/** Build WorkerState from a deliverable (for task progress tracking). */
export function workerStateFromDeliverable(
	name: string,
	d: Deliverable,
	status: WorkerState["status"],
	startedAt: number,
): WorkerState {
	const items = (d.children ?? []).filter(
		(c): c is WorkItem =>
			c.type === "work-item" && (c.kind === "task" || !c.kind),
	);
	const done = items.filter((i) => i.done).length;
	const firstUndone = items.find((i) => !i.done);
	return {
		name,
		deliverableTitle: shortTitle(d.title ?? d.id),
		status,
		tasksDone: done,
		tasksTotal: items.length,
		currentTask: firstUndone?.title,
		elapsedMs: Date.now() - startedAt,
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
