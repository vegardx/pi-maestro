// TUI component for the worker status widget. Uses pi-tui's Box + Text for
// proper framing and column-aware truncation.

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	Container,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";

export interface WorkerDisplayState {
	readonly name: string;
	readonly deliverable: string;
	readonly tasksDone: number;
	readonly tasksTotal: number;
	readonly currentTask: string;
	readonly elapsed: string;
	readonly status: "active" | "done" | "waiting";
}

export class WorkerWidgetComponent implements Component {
	private workers: WorkerDisplayState[] = [];
	private collapsed = false;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private theme?: Theme;

	setTheme(theme: Theme): void {
		this.theme = theme;
		this.invalidate();
	}

	setWorkers(workers: WorkerDisplayState[]): void {
		this.workers = workers;
		this.invalidate();
	}

	setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		if (this.workers.length === 0) {
			this.cachedLines = [];
			this.cachedWidth = width;
			return this.cachedLines;
		}
		if (this.collapsed) {
			this.cachedLines = this.renderCollapsed(width);
		} else {
			this.cachedLines = this.renderExpanded(width);
		}
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private renderExpanded(width: number): string[] {
		const lines: string[] = [];
		const fg = this.theme?.fg.bind(this.theme);
		for (const w of this.workers) {
			const icon =
				w.status === "done"
					? fg
						? fg("success", "✓")
						: "✓"
					: w.status === "waiting"
						? fg
							? fg("warning", "⚠")
							: "⚠"
						: fg
							? fg("accent", "●")
							: "●";
			const progress = `${w.tasksDone}/${w.tasksTotal}`;
			const task =
				w.status === "done"
					? fg
						? fg("muted", "done")
						: "done"
					: w.currentTask;
			const time = fg ? fg("muted", `[${w.elapsed}]`) : `[${w.elapsed}]`;
			const line = `${icon} ${w.name}  ${w.deliverable}  ${progress}  ${task}  ${time}`;
			lines.push(truncateToWidth(line, width));
		}
		const hint = fg ? fg("dim", "(/w)") : "(/w)";
		if (lines.length > 0) {
			lines[lines.length - 1] = truncateToWidth(
				`${lines[lines.length - 1]}  ${hint}`,
				width,
			);
		}
		return lines;
	}

	private renderCollapsed(width: number): string[] {
		const active = this.workers.filter((w) => w.status === "active").length;
		const waiting = this.workers.filter((w) => w.status === "waiting").length;
		const done = this.workers.filter((w) => w.status === "done").length;
		const parts: string[] = [];
		if (active > 0) parts.push(`${active} active`);
		if (waiting > 0) parts.push(`${waiting} waiting`);
		if (done > 0) parts.push(`${done} done`);
		const allDone = active === 0 && waiting === 0 && done > 0;
		const suffix = allDone ? " · ready to ship" : "";
		const fg = this.theme?.fg.bind(this.theme);
		const hint = fg ? fg("dim", "(/w)") : "(/w)";
		const line = `Workers: ${parts.join(" · ")}${suffix}  ${hint}`;
		return [truncateToWidth(line, width)];
	}
}
