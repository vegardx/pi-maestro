// Run dashboard widget. Renders a list of subagent runs with status, elapsed
// time, and optional progress text. Parameterised over contracts' RunRecord /
// RunProgress so pi-ui never depends on the subagents package.

import type { Component } from "@earendil-works/pi-tui";
import type { RunProgress, RunRecord } from "@vegardx/pi-contracts";
import {
	defaultPalette,
	formatElapsed,
	type Palette,
	padRight,
	runStatusGlyph,
	runStatusStyle,
	truncate,
} from "./format.js";

export interface RunDashboardRow {
	readonly run: RunRecord;
	readonly progress?: RunProgress;
}

export interface RunDashboardOptions {
	palette?: Palette;
	/** Reference time for elapsed calc. Default Date.now() at render. */
	now?: number;
	/** Column width for the profile name. Default 16. */
	profileWidth?: number;
	/** Header line. Default omitted. */
	title?: string;
}

export function renderRunDashboard(
	rows: readonly RunDashboardRow[],
	width: number,
	opts: RunDashboardOptions = {},
): string[] {
	const palette = opts.palette ?? defaultPalette();
	const now = opts.now ?? Date.now();
	const profileWidth = opts.profileWidth ?? 16;
	const lines: string[] = [];

	if (opts.title) lines.push(palette.heading(opts.title));
	if (rows.length === 0) {
		lines.push(palette.muted("  (no runs)"));
		return lines;
	}

	for (const { run, progress } of rows) {
		const style = runStatusStyle(palette, run.status);
		const glyph = style(runStatusGlyph(run.status));
		const profile = padRight(
			truncate(run.profile.profile, profileWidth),
			profileWidth,
		);
		const elapsed = padRight(formatElapsed(now - run.createdAt), 6);
		const status = padRight(run.status, 10);
		const detail = progress?.text ? palette.dim(progress.text) : "";
		const head = `${glyph} ${palette.accent(profile)} ${palette.muted(status)} ${palette.muted(elapsed)}`;
		lines.push(truncate(detail ? `${head} ${detail}` : head, width));
	}

	return lines;
}

/** Live component wrapper around renderRunDashboard. */
export class RunDashboardComponent implements Component {
	private rows: readonly RunDashboardRow[] = [];

	constructor(private readonly opts: RunDashboardOptions = {}) {}

	setRows(rows: readonly RunDashboardRow[]): void {
		this.rows = rows;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return renderRunDashboard(this.rows, width, this.opts);
	}
}
