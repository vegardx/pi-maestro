// Editor that shows a dim ghost suggestion on an empty buffer. Tab on an empty
// buffer accepts the ghost into the buffer; any other key clears it. Ported
// from the prompt-suggestion extension. Hard to unit-test (needs a live TUI),
// so it stays a thin shell over CustomEditor — the logic worth testing lives in
// sanitise.ts and state.ts.

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CURSOR_BLOCK = "\x1b[7m \x1b[0m";
const CURSOR_VISIBLE_WIDTH = 1;

export class GhostEditor extends CustomEditor {
	private ghost = "";

	setGhost(text: string): void {
		const next = text.trim();
		if (next === this.ghost) return;
		this.ghost = next;
		this.tui.requestRender();
	}

	clearGhost(): void {
		if (!this.ghost) return;
		this.ghost = "";
		this.tui.requestRender();
	}

	hasGhost(): boolean {
		return this.ghost.length > 0;
	}

	override handleInput(data: string): void {
		if (!this.ghost) {
			super.handleInput(data);
			return;
		}
		if (matchesKey(data, "tab") && this.getText().length === 0) {
			const suggestion = this.ghost;
			this.ghost = "";
			this.setText(suggestion);
			this.tui.requestRender();
			return;
		}
		this.ghost = "";
		this.tui.requestRender();
		super.handleInput(data);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.ghost) return lines;
		if (this.getText().length !== 0) return lines;
		if (
			lines.length < 3 ||
			typeof lines[0] !== "string" ||
			lines[0].length === 0
		)
			return lines;

		const paddingX = this.getPaddingX();
		const leftPad = " ".repeat(paddingX);
		const innerWidth = Math.max(0, width - paddingX * 2 - CURSOR_VISIBLE_WIDTH);
		if (innerWidth === 0) return lines;

		const shown = truncateToWidth(this.ghost, innerWidth);
		const fill = " ".repeat(Math.max(0, innerWidth - visibleWidth(shown)));
		lines[1] = `${leftPad}${CURSOR_BLOCK}${DIM}${shown}${RESET}${fill}${leftPad}`;
		return lines;
	}
}
