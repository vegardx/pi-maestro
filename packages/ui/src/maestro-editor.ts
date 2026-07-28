// MaestroEditor: the host session's input editor with the HUD tab bar in
// its top border. The input box always reads tab-bar / input text / bottom
// border; the panel (runtime/hud.ts) expands ABOVE the bar as its own
// widget. Extends pi's CustomEditor (same pattern as AnswerEditor in
// packages/ui) so the extension-shortcut chain and app actions keep working
// — every key the grammar doesn't own is delegated to super.
//
// Tab grammar (handleInput):
//   input focused + empty editor  → enter the ring: focus Agents, expand
//   input focused + draft present → super (autocomplete owns Tab); the
//                                   trailing " tab ──" hint renders extra-dim
//   panel tab focused             → next tab; past Questions → back to the
//                                   input with the panel fully collapsed
// Esc: from a panel tab → focus input AND collapse; from the input with a
// pinned panel → collapse; otherwise super (default editor behavior).
// While a panel tab is focused every other key is forwarded to the panel
// (up/down/fold/enter/s/i and [ ] as secondary tab switches) and never
// reaches the text editor.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { HudFocusState, HudSnapshot, HudTab } from "./hud.js";

const RING: readonly HudTab[] = ["agents", "plan", "questions"];

const KEY_TAB = "\t";
const KEY_ESC = "\u001b";

/** The live counts the tab bar renders (a HudSnapshot boiled down). */
export interface HudTabCounts {
	readonly agents: number;
	readonly plan?: { readonly done: number; readonly total: number };
	readonly questions: number;
	readonly blocking: number;
}

/** Boil a HudSnapshot down to the tab-bar counts. */
export function hudTabCounts(snap: HudSnapshot): HudTabCounts {
	let agents = 0;
	for (const node of snap.agents) agents += 1 + node.children.length;
	return {
		agents,
		...(snap.plan
			? { plan: { done: snap.plan.done, total: snap.plan.total } }
			: {}),
		questions: snap.questions.length,
		blocking: snap.questions.filter((q) => q.blocking).length,
	};
}

/** The thin panel surface the editor drives (HudComponent satisfies it). */
export interface HudPanelPort {
	setTab(tab: HudTab): void;
	handleInput(data: string): void;
}

export interface MaestroEditorDeps {
	/** Shared focus/expansion state (owned by hud-wiring). */
	readonly state: HudFocusState;
	/** Live counts for the tab-bar labels. */
	readonly counts: () => HudTabCounts;
	/** The HUD panel keystrokes are forwarded into while a tab is focused. */
	readonly panel: HudPanelPort;
	/** Theme accessor; absent (tests) renders plain text. */
	readonly theme?: () => Theme | undefined;
	readonly requestRender: () => void;
}

/**
 * Compose the tab-bar line:
 * `──[ Input ]─── Agents N ─── Plan D/T ─── Questions N · 1 blocking ── … ── tab ──`
 * Active ring member bracketed (bold/accent); counts omitted when zero;
 * blocking accent on the Questions label; dim rule dashes. `draftBusy`
 * renders the trailing tab hint extra-dim (Tab belongs to autocomplete).
 */
export function composeTabBar(opts: {
	focus: "input" | HudTab;
	counts: HudTabCounts;
	width: number;
	draftBusy?: boolean;
	theme?: Theme | undefined;
}): string {
	const { focus, counts, width, draftBusy, theme } = opts;
	const labels: Record<"input" | HudTab, string> = {
		input: "Input",
		agents: `Agents${counts.agents > 0 ? ` ${counts.agents}` : ""}`,
		plan: counts.plan
			? `Plan ${counts.plan.done}/${counts.plan.total}`
			: "Plan",
		questions: `Questions${
			counts.questions > 0 ? ` ${counts.questions}` : ""
		}${counts.blocking > 0 ? ` · ${counts.blocking} blocking` : ""}`,
	};

	interface Segment {
		readonly text: string;
		readonly kind: "rule" | "label" | "active" | "blocking" | "hint";
	}
	const segments: Segment[] = [{ text: "──", kind: "rule" }];
	for (const member of ["input", ...RING] as const) {
		const label = labels[member];
		if (member === focus) {
			segments.push({ text: `[ ${label} ]`, kind: "active" });
		} else {
			segments.push({
				text: `─ ${label} ─`,
				kind:
					member === "questions" && counts.blocking > 0 ? "blocking" : "label",
			});
		}
		segments.push({ text: "──", kind: "rule" });
	}
	const hint = " tab ──";
	const used =
		segments.reduce((n, s) => n + visibleWidth(s.text), 0) + visibleWidth(hint);
	const fill = Math.max(0, width - used);
	segments.push({ text: "─".repeat(fill), kind: "rule" });
	segments.push({ text: hint, kind: "hint" });

	// Degenerate narrow terminal: drop styling and hard-truncate.
	if (used > width) {
		const plain = truncateToWidth(segments.map((s) => s.text).join(""), width);
		return theme ? theme.fg("dim", plain) : plain;
	}
	if (!theme) return segments.map((s) => s.text).join("");
	return segments
		.map((s) => {
			switch (s.kind) {
				case "active":
					return theme.bold(theme.fg("accent", s.text));
				case "blocking":
					return theme.fg("accent", s.text);
				case "hint":
					return draftBusy
						? `\u001b[2m${theme.fg("dim", s.text)}\u001b[22m`
						: theme.fg("dim", s.text);
				default:
					return theme.fg("dim", s.text);
			}
		})
		.join("");
}

/** Dim a pre-styled editor line, re-arming after any inner SGR reset. */
function dimLine(line: string): string {
	return `\u001b[2m${line.replaceAll("\u001b[0m", "\u001b[0m\u001b[2m")}\u001b[22m`;
}

export class MaestroEditor extends CustomEditor {
	readonly #deps: MaestroEditorDeps;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		deps: MaestroEditorDeps,
	) {
		super(tui, theme, keybindings);
		this.#deps = deps;
	}

	override handleInput(data: string): void {
		const { state, panel, requestRender } = this.#deps;

		if (data === KEY_TAB) {
			if (state.focus === "input") {
				if (this.getText() === "") {
					// Enter the ring: focus Agents (expand if collapsed).
					state.focus = "agents";
					state.expanded = true;
					panel.setTab("agents");
					requestRender();
					return;
				}
				// A draft keeps Tab for autocomplete.
				super.handleInput(data);
				return;
			}
			// Walk the ring; past Questions, return to the input and fully
			// collapse the panel.
			const at = RING.indexOf(state.focus);
			const next = RING[at + 1];
			if (next !== undefined) {
				state.focus = next;
				panel.setTab(next);
			} else {
				state.focus = "input";
				state.expanded = false;
			}
			requestRender();
			return;
		}

		if (state.focus !== "input") {
			if (data === KEY_ESC) {
				// Esc from a panel tab: focus the input AND collapse.
				state.focus = "input";
				state.expanded = false;
				requestRender();
				return;
			}
			// Control chords (Ctrl+C interrupt, Ctrl+D exit) must always
			// reach the app — a focused panel must never trap them.
			if (data === "\u0003" || data === "\u0004") {
				super.handleInput(data);
				return;
			}
			// Panel owns every other key while focused — nothing may leak
			// into the text editor.
			panel.handleInput(data);
			requestRender();
			return;
		}

		if (data === KEY_ESC && state.expanded && !this.isShowingAutocomplete()) {
			// Esc from the input with a pinned panel: collapse it.
			state.expanded = false;
			requestRender();
			return;
		}

		super.handleInput(data);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		const { state } = this.#deps;
		const theme = this.#deps.theme?.();
		const panelFocused = state.focus !== "input";
		// The editor's own top border becomes the tab bar.
		lines[0] = composeTabBar({
			focus: state.focus,
			counts: this.#deps.counts(),
			width,
			draftBusy: !panelFocused && this.getText() !== "",
			theme,
		});
		// While a panel tab is focused the input text stays visible, dimmed.
		if (panelFocused && theme) {
			for (let i = 1; i < lines.length; i++) lines[i] = dimLine(lines[i]);
		}
		return lines;
	}
}
