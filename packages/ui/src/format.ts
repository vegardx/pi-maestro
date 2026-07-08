// Pure formatting helpers shared by every widget. Render output is plain text
// by default — the Palette's style functions are identity, so snapshot tests
// see deterministic strings. Live callers pass theme-derived ANSI styles.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DeliverableStatus, RunStatus } from "@vegardx/pi-contracts";

export type Style = (s: string) => string;

/** Named style slots. All default to identity (plain text). */
export interface Palette {
	dim: Style;
	muted: Style;
	accent: Style;
	heading: Style;
	success: Style;
	warning: Style;
	error: Style;
	info: Style;
}

const identity: Style = (s) => s;

export function defaultPalette(overrides: Partial<Palette> = {}): Palette {
	return {
		dim: identity,
		muted: identity,
		accent: identity,
		heading: identity,
		success: identity,
		warning: identity,
		error: identity,
		info: identity,
		...overrides,
	};
}

const RUN_GLYPHS: Record<RunStatus, string> = {
	queued: "○",
	running: "◐",
	blocked: "⏸",
	succeeded: "✓",
	failed: "✗",
	stopped: "■",
	canceled: "⊘",
};

const DELIVERABLE_GLYPHS: Record<DeliverableStatus, string> = {
	planned: "○",
	active: "◐",
	complete: "◎",
	shipped: "✓",
	superseded: "⤳",
	abandoned: "⊘",
};

export function runStatusGlyph(status: RunStatus): string {
	return RUN_GLYPHS[status] ?? "?";
}

export function deliverableStatusGlyph(status: DeliverableStatus): string {
	return DELIVERABLE_GLYPHS[status] ?? "?";
}

/** Style slot appropriate to a run status (for colored live rendering). */
export function runStatusStyle(palette: Palette, status: RunStatus): Style {
	switch (status) {
		case "succeeded":
			return palette.success;
		case "failed":
			return palette.error;
		case "blocked":
			return palette.warning;
		case "running":
			return palette.accent;
		default:
			return palette.muted;
	}
}

export function deliverableStatusStyle(
	palette: Palette,
	status: DeliverableStatus,
): Style {
	switch (status) {
		case "shipped":
			return palette.success;
		case "abandoned":
		case "superseded":
			return palette.muted;
		case "complete":
			return palette.warning;
		case "active":
			return palette.accent;
		default:
			return palette.muted;
	}
}

/** Truncate to a column width with an ellipsis (delegates to pi-tui). */
export function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width);
}

/** Right-pad to a column width, accounting for wide/ANSI characters. */
export function padRight(text: string, width: number): string {
	const w = visibleWidth(text);
	return w >= width ? text : text + " ".repeat(width - w);
}

/** Compact "done/total" badge. */
export function formatCount(done: number, total: number): string {
	return `${done}/${total}`;
}

/** Human elapsed time from a millisecond span. */
export function formatElapsed(ms: number): string {
	if (ms < 0 || !Number.isFinite(ms)) return "—";
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	if (min < 60) {
		const sec = totalSec % 60;
		return sec ? `${min}m${sec}s` : `${min}m`;
	}
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return remMin ? `${hr}h${remMin}m` : `${hr}h`;
}
