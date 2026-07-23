// A real multi-select checkbox overlay for toggle lists, via ctx.ui.custom
// (a focused TUI component): SPACE toggles, ↑/↓ move without the cursor
// resetting, ENTER confirms the whole selection in one shot, Esc cancels.
// 'a' selects all, 'n' selects none. Surfaces without the custom-component
// API (RPC extension_ui_request, headless) don't get this — callers keep
// their select-loop fallback, which the e2e driver can navigate.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";

export interface MultiSelectItem {
	readonly id: string;
	readonly label: string;
	readonly checked: boolean;
}

interface Palette {
	readonly accent: (s: string) => string;
	readonly muted: (s: string) => string;
	readonly bold: (s: string) => string;
}

const PLAIN: Palette = {
	accent: (s) => s,
	muted: (s) => s,
	bold: (s) => s,
};

function paletteFromTheme(theme: unknown): Palette {
	const t = theme as {
		fg?: (color: string, text: string) => string;
		bold?: (text: string) => string;
	} | null;
	if (!t?.fg) return PLAIN;
	return {
		accent: (s) => t.fg?.("accent", s) ?? s,
		muted: (s) => t.fg?.("muted", s) ?? s,
		bold: (s) => t.bold?.(s) ?? s,
	};
}

const UP = new Set(["\u001b[A", "\u001bOA"]);
const DOWN = new Set(["\u001b[B", "\u001bOB"]);
const WINDOW = 14;

/** Exported for tests: drive handleInput directly and observe done(). */
export class MultiSelectComponent implements Component, Focusable {
	// Set by the TUI on focus (Focusable). The overlay factory also flips it
	// true after construction, mirroring runQuestionnaire.
	focused = false;
	private cursor = 0;
	private readonly checked: Set<string>;

	constructor(
		private readonly title: string,
		private readonly items: readonly MultiSelectItem[],
		private readonly done: (result: string[] | undefined) => void,
		private readonly palette: Palette = PLAIN,
	) {
		this.checked = new Set(
			items.filter((item) => item.checked).map((item) => item.id),
		);
	}

	/** Required by Component; the TUI calls it when priming the overlay and on
	 *  theme changes. Its absence left the overlay unfocused (input never
	 *  routed to it) — the bug this fixes. Nothing is cached, so it is a no-op. */
	invalidate(): void {}

	render(width: number): string[] {
		const p = this.palette;
		const lines: string[] = [
			p.bold(this.title),
			p.muted("space toggle · a all · n none · enter apply · esc cancel"),
		];
		// Window the list around the cursor so long providers stay usable.
		const start = Math.max(
			0,
			Math.min(
				this.cursor - Math.floor(WINDOW / 2),
				this.items.length - WINDOW,
			),
		);
		const end = Math.min(this.items.length, start + WINDOW);
		if (start > 0) lines.push(p.muted(`  ↑ ${start} more`));
		for (let i = start; i < end; i++) {
			const item = this.items[i];
			const on = this.checked.has(item.id);
			const row = `${i === this.cursor ? "▸" : " "} ${on ? "✓" : "✗"} ${item.label}`;
			lines.push(i === this.cursor ? p.bold(row) : on ? p.accent(row) : row);
		}
		if (end < this.items.length)
			lines.push(p.muted(`  ↓ ${this.items.length - end} more`));
		return lines.map((line) => line.slice(0, Math.max(1, width)));
	}

	handleInput(data: string): void {
		if (data === "\u001b") {
			this.done(undefined);
			return;
		}
		if (data === "\r" || data === "\n") {
			this.done(
				this.items.map((item) => item.id).filter((id) => this.checked.has(id)),
			);
			return;
		}
		if (UP.has(data)) {
			this.cursor = Math.max(0, this.cursor - 1);
			return;
		}
		if (DOWN.has(data)) {
			this.cursor = Math.min(this.items.length - 1, this.cursor + 1);
			return;
		}
		if (data === " ") {
			const item = this.items[this.cursor];
			if (!item) return;
			if (this.checked.has(item.id)) this.checked.delete(item.id);
			else this.checked.add(item.id);
			return;
		}
		if (data === "a") {
			for (const item of this.items) this.checked.add(item.id);
			return;
		}
		if (data === "n") this.checked.clear();
	}
}

/** Whether this surface can show the overlay (TUI with ui.custom). */
export function supportsMultiSelect(ctx: ExtensionContext): boolean {
	return Boolean(
		ctx.hasUI &&
			(ctx.ui as unknown as { custom?: unknown }).custom !== undefined,
	);
}

/**
 * Show the overlay and resolve the chosen ids (authored order), or
 * undefined on cancel. Callers must check supportsMultiSelect first and
 * keep a select-loop fallback for RPC/headless surfaces.
 */
export function multiSelect(
	ctx: ExtensionContext,
	title: string,
	items: readonly MultiSelectItem[],
): Promise<string[] | undefined> {
	const custom = (
		ctx.ui as unknown as {
			custom: <T>(
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (result: T) => void,
				) => unknown,
				options?: unknown,
			) => Promise<T>;
		}
	).custom;
	return custom<string[] | undefined>(
		(_tui, theme, _keybindings, done) => {
			const component = new MultiSelectComponent(
				title,
				items,
				done,
				paletteFromTheme(theme),
			);
			component.focused = true;
			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "60%",
			},
		},
	);
}
