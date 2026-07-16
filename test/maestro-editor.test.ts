// MaestroEditor: the tab bar in the input's top border and the Tab/Esc
// grammar. Covers the tab-bar line (brackets follow focus, live counts,
// blocking accent, draft-dims-tab-hint), the ring walk including the
// wrap-to-collapsed-input step, Esc collapse from both states, draft-keeps-Tab
// (super called), panel-key forwarding, and the install/dispose wiring
// (host sessions install the editor + panel widget; worker mode never
// reaches installHud and the answer-mode swap restores the factory).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { openAnswerMode } from "@vegardx/pi-ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HudFocusState } from "../packages/modes/src/runtime/hud.js";
import {
	composeTabBar,
	type HudPanelPort,
	type HudTabCounts,
	hudTabCounts,
	MaestroEditor,
} from "../packages/modes/src/runtime/maestro-editor.js";

const W = 72;

function counts(overrides: Partial<HudTabCounts> = {}): HudTabCounts {
	return { agents: 0, questions: 0, blocking: 0, ...overrides };
}

/** Marker-style fake theme so styling is assertable as plain text. */
function fakeTheme(): Theme {
	return {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `<b>${text}</b>`,
	} as unknown as Theme;
}

function fakePanel() {
	return {
		setTab: vi.fn<(tab: string) => void>(),
		handleInput: vi.fn<(data: string) => void>(),
	} satisfies HudPanelPort;
}

/** Minimal TUI/theme/keybindings fakes for constructing a real editor. */
function editor(opts: { state?: HudFocusState; theme?: Theme } = {}) {
	const state: HudFocusState = opts.state ?? {
		focus: "input",
		expanded: false,
	};
	const panel = fakePanel();
	const requestRender = vi.fn();
	const tui = {
		terminal: { rows: 30, cols: W },
		requestRender: () => {},
	} as never;
	const editorTheme = {
		borderColor: (s: string) => s,
		selectList: {},
	} as never;
	const keybindings = {
		// Escape maps to app.interrupt (mirrors pi's default keybindings);
		// nothing else matches so plain typing reaches the buffer.
		matches: (data: string, action: string) =>
			action === "app.interrupt" && data === "\u001b",
	} as never;
	const e = new MaestroEditor(tui, editorTheme, keybindings, {
		state,
		counts: () => counts({ agents: 4, plan: { done: 5, total: 9 } }),
		panel,
		...(opts.theme ? { theme: () => opts.theme } : {}),
		requestRender,
	});
	return { e, state, panel, requestRender };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("composeTabBar", () => {
	it("brackets the focused ring member and fills to width", () => {
		const bar = composeTabBar({ focus: "input", counts: counts(), width: W });
		expect(bar).toContain("[ Input ]");
		expect(bar).toContain("─ Agents ─");
		expect(bar).toContain("─ Plan ─");
		expect(bar).toContain("─ Questions ─");
		expect(bar).toMatch(/ tab ──$/);
		expect(bar.length).toBe(W); // plain: exactly width columns
	});

	it("moves the bracket with focus", () => {
		const bar = composeTabBar({
			focus: "agents",
			counts: counts({ agents: 4 }),
			width: W,
		});
		expect(bar).toContain("─ Input ─");
		expect(bar).toContain("[ Agents 4 ]");
	});

	it("carries live counts and omits them when zero", () => {
		const bar = composeTabBar({
			focus: "input",
			counts: counts({
				agents: 4,
				plan: { done: 5, total: 9 },
				questions: 2,
				blocking: 1,
			}),
			width: 90,
		});
		expect(bar).toContain("Agents 4");
		expect(bar).toContain("Plan 5/9");
		expect(bar).toContain("Questions 2 · 1 blocking");
		const zero = composeTabBar({ focus: "input", counts: counts(), width: W });
		expect(zero).toContain("─ Agents ─");
		expect(zero).toContain("─ Questions ─");
		expect(zero).not.toContain("Agents 0");
	});

	it("accents the blocking Questions label and bolds the active member", () => {
		const bar = composeTabBar({
			focus: "agents",
			counts: counts({ agents: 1, questions: 2, blocking: 1 }),
			width: 90,
			theme: fakeTheme(),
		});
		expect(bar).toContain("<b><accent>[ Agents 1 ]</accent></b>");
		expect(bar).toContain("<accent>─ Questions 2 · 1 blocking ─</accent>");
	});

	it("renders the tab hint extra-dim while a draft owns Tab", () => {
		const theme = fakeTheme();
		const free = composeTabBar({
			focus: "input",
			counts: counts(),
			width: W,
			theme,
		});
		const busy = composeTabBar({
			focus: "input",
			counts: counts(),
			width: W,
			draftBusy: true,
			theme,
		});
		expect(free).toContain("<dim> tab ──</dim>");
		expect(free).not.toContain("\u001b[2m");
		expect(busy).toContain("\u001b[2m<dim> tab ──</dim>\u001b[22m");
	});
});

describe("hudTabCounts", () => {
	it("boils a snapshot down to tab-bar counts", () => {
		expect(
			hudTabCounts({
				agents: [
					{
						key: "a",
						label: "worker · a",
						status: "running",
						startedAt: 0,
						children: [
							{
								key: "c",
								label: "review · a",
								status: "running",
								startedAt: 0,
							},
						],
					},
				],
				plan: { rows: [], done: 5, total: 9 },
				questions: [
					{ key: "q1", asker: "maestro", blocking: true, text: "?" },
					{ key: "q2", asker: "worker · a", blocking: false, text: "?" },
				],
			}),
		).toEqual({
			agents: 2,
			plan: { done: 5, total: 9 },
			questions: 2,
			blocking: 1,
		});
	});
});

describe("MaestroEditor ring walk", () => {
	it("Tab on an empty input enters the ring at Agents and expands", () => {
		const { e, state, panel } = editor();
		e.handleInput("\t");
		expect(state.focus).toBe("agents");
		expect(state.expanded).toBe(true);
		expect(panel.setTab).toHaveBeenCalledWith("agents");
	});

	it("walks Agents → Plan → Questions → collapsed input", () => {
		const { e, state, panel } = editor();
		e.handleInput("\t"); // → agents
		e.handleInput("\t"); // → plan
		expect(state.focus).toBe("plan");
		expect(panel.setTab).toHaveBeenLastCalledWith("plan");
		e.handleInput("\t"); // → questions
		expect(state.focus).toBe("questions");
		e.handleInput("\t"); // → wrap: input gets the keys, panel collapses
		expect(state.focus).toBe("input");
		expect(state.expanded).toBe(false);
		// No extra tab switch occurs while returning to the input.
		expect(panel.setTab).toHaveBeenLastCalledWith("questions");
	});

	it("entering the ring from an expanded input state focuses Agents", () => {
		const { e, state } = editor({
			state: { focus: "input", expanded: true },
		});
		e.handleInput("\t");
		expect(state.focus).toBe("agents");
		expect(state.expanded).toBe(true);
	});
});

describe("MaestroEditor Esc collapse", () => {
	it("Esc from a panel tab focuses the input AND collapses", () => {
		const { e, state } = editor({
			state: { focus: "plan", expanded: true },
		});
		e.handleInput("\u001b");
		expect(state.focus).toBe("input");
		expect(state.expanded).toBe(false);
	});

	it("Esc from the input with a pinned panel collapses it", () => {
		const { e, state } = editor({
			state: { focus: "input", expanded: true },
		});
		e.handleInput("\u001b");
		expect(state.expanded).toBe(false);
	});

	it("Esc with no panel falls through to the default editor behavior", () => {
		const { e, state } = editor();
		const superInput = vi.spyOn(CustomEditor.prototype, "handleInput");
		e.handleInput("\u001b");
		expect(superInput).toHaveBeenCalledWith("\u001b");
		expect(state.focus).toBe("input");
		expect(state.expanded).toBe(false);
	});
});

describe("MaestroEditor draft handling", () => {
	it("a draft keeps Tab for autocomplete (super called, ring not entered)", () => {
		const { e, state } = editor();
		e.setText("half a promp");
		const superInput = vi.spyOn(CustomEditor.prototype, "handleInput");
		e.handleInput("\t");
		expect(superInput).toHaveBeenCalledWith("\t");
		expect(state.focus).toBe("input");
		expect(state.expanded).toBe(false);
	});

	it("normal typing reaches the buffer while the input is focused", () => {
		const { e } = editor();
		e.handleInput("h");
		e.handleInput("i");
		expect(e.getText()).toBe("hi");
	});
});

describe("MaestroEditor panel-key forwarding", () => {
	it("forwards everything except Tab/Esc to the panel while a tab is focused", () => {
		const { e, panel } = editor({
			state: { focus: "agents", expanded: true },
		});
		for (const key of [
			"\u001b[A",
			"\u001b[B",
			"\u001b[C",
			" ",
			"\r",
			"s",
			"i",
			"[",
			"]",
		]) {
			e.handleInput(key);
			expect(panel.handleInput).toHaveBeenLastCalledWith(key);
		}
		// Nothing leaked into the text editor.
		expect(e.getText()).toBe("");
	});

	it("does not forward while pinned — the input owns the keys again", () => {
		const { e, panel } = editor({
			state: { focus: "input", expanded: true },
		});
		e.handleInput("s");
		expect(panel.handleInput).not.toHaveBeenCalled();
		expect(e.getText()).toBe("s");
	});
});

describe("MaestroEditor render", () => {
	it("replaces the editor's top border with the tab bar", () => {
		const { e } = editor();
		const lines = e.render(W);
		expect(lines[0]).toContain("[ Input ]");
		expect(lines[0]).toContain("Agents 4");
		expect(lines[0]).toContain("Plan 5/9");
		expect(lines[0]).toMatch(/ tab ──$/);
		// The rest of the editor box is intact (bottom border last).
		expect(lines[lines.length - 1]).toMatch(/^─+$/);
	});

	it("dims the input body while a panel tab is focused", () => {
		const { e, state } = editor({ theme: fakeTheme() });
		state.focus = "agents";
		state.expanded = true;
		const lines = e.render(W);
		expect(lines[0]).toContain("[ Agents 4 ]");
		for (const line of lines.slice(1)) {
			expect(line.startsWith("\u001b[2m")).toBe(true);
		}
	});
});

describe("answer-mode round-trip", () => {
	it("restores the MaestroEditor factory when answer mode closes", () => {
		const maestroFactory = () => ({}) as never;
		let current: unknown = maestroFactory;
		const ui = {
			setEditorComponent: vi.fn((f: unknown) => {
				current = f;
			}),
			getEditorComponent: vi.fn(() => current),
		};
		const handle = openAnswerMode(ui as never, {
			title: "maestro",
			blocking: false,
			questions: [{ id: "q", question: "Keep the tab bar?" }],
			onAnswer: () => {},
		});
		// Answer mode swapped its own editor in…
		expect(current).not.toBe(maestroFactory);
		handle.close();
		// …and handed the MaestroEditor factory back on close.
		expect(ui.setEditorComponent).toHaveBeenLastCalledWith(maestroFactory);
		expect(current).toBe(maestroFactory);
	});
});

describe("MaestroEditor control chords", () => {
	it("Ctrl+C / Ctrl+D bypass a focused panel and reach the app", () => {
		const { e, state, panel } = editor();
		state.focus = "agents";
		state.expanded = true;
		const superInput = vi.spyOn(CustomEditor.prototype, "handleInput");
		e.handleInput("\u0003");
		e.handleInput("\u0004");
		expect(superInput).toHaveBeenCalledTimes(2);
		expect(panel.handleInput).not.toHaveBeenCalled();
		// The chord is not a focus change — the panel stays focused.
		expect(state.focus).toBe("agents");
		superInput.mockRestore();
	});
});
