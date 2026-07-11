// Collapsed result rendering for maestro's custom tools. pi's BUILT-IN tools
// (read/bash/grep) render collapsed previews with their own renderers, but a
// custom tool without `renderResult` falls back to dumping its COMPLETE text
// output into the dialog — a 14KB dig result is 200+ lines of scroll, and the
// go-rewrite dogfood session was unreadable because of it. This renderer is
// DISPLAY-ONLY: the model always receives the full tool result; the human
// gets a preview and the TUI's native expand toggle.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const PREVIEW_LINES = 8;

interface RenderableResult {
	readonly content: ReadonlyArray<{ type: string; text?: string }>;
}

/**
 * Attachable as `renderResult` on any defineTool whose output can run long
 * (research, dig, review, subagent). Collapsed: first lines + a count tail;
 * expanded: everything.
 */
export function renderCollapsedResult(
	result: RenderableResult,
	options: { expanded: boolean },
	theme: Theme,
): Text {
	const text = result.content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text)
		.join("\n")
		.trimEnd();
	const lines = text.split("\n");
	// A short result (or the expanded view) renders whole — no tease tail for
	// two hidden lines.
	if (options.expanded || lines.length <= PREVIEW_LINES + 2) {
		return new Text(theme.fg("toolOutput", text), 0, 0);
	}
	const preview = lines.slice(0, PREVIEW_LINES).join("\n");
	const tail = `(+${lines.length - PREVIEW_LINES} more lines — expand to read)`;
	return new Text(
		`${theme.fg("toolOutput", preview)}\n${theme.fg("dim", tail)}`,
		0,
		0,
	);
}
