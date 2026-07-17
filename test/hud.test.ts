// HUD panel render snapshots: fixed-width string arrays over a static
// HudSnapshot (no terminal). The panel is the expand-above stratum — the tab
// bar lives in MaestroEditor (test/maestro-editor.test.ts). Covers the
// collapsed [] state, the expanded+focused view (cap rule + hint row), the
// pinned/passive view (muted, no hint, no selection), per-tab rows, fold
// rules (auto + sticky manual overrides), the 10-line self-cap with
// selection scrolling, and the render cache.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	type HudActions,
	HudComponent,
	type HudFocusState,
	type HudSnapshot,
	hudElapsed,
} from "../packages/modes/src/runtime/hud.js";

const W = 72;
const NOW = 1_000_000;

function actions() {
	return {
		attach: vi.fn<(targetId: string) => void>(),
		steer: vi.fn<(targetId: string) => void>(),
		interrupt: vi.fn<(targetId: string) => void>(),
		kill: vi.fn<(targetId: string) => void>(),
		answer: vi.fn(),
	} satisfies HudActions;
}

/** Marker-style fake theme so styling is assertable as plain text. */
function fakeTheme(): Theme {
	return {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `<b>${text}</b>`,
	} as unknown as Theme;
}

function hud(
	snap: HudSnapshot,
	opts: {
		acts?: HudActions;
		state?: HudFocusState;
		theme?: Theme;
	} = {},
): { c: HudComponent; state: HudFocusState } {
	const state = opts.state ?? { focus: "agents", expanded: true };
	const c = new HudComponent({
		state,
		data: () => snap,
		actions: opts.acts ?? actions(),
		now: () => NOW,
		...(opts.theme ? { theme: () => opts.theme } : {}),
	});
	return { c, state };
}

const EMPTY: HudSnapshot = { agents: [], plan: undefined, questions: [] };

function agentsSnap(): HudSnapshot {
	return {
		agents: [
			{
				key: "auth-api/worker",
				label: "worker · auth-api",
				status: "running",
				startedAt: NOW - 252_000,
				model: "fable-5",
				effort: "high",
				note: "fable-5",
				targetId: "worker:auth-api/worker",
				capabilities: { view: true, steer: true, interrupt: true, kill: true },
				children: [
					{
						key: "run:r1",
						label: "review/security · auth-api",
						status: "running",
						startedAt: NOW - 30_000,
						note: "gate: review",
						targetId: "run:r1",
						capabilities: {
							view: true,
							steer: true,
							interrupt: true,
							kill: true,
						},
					},
					{
						key: "run:r2",
						label: "verify/tests · auth-api",
						status: "done",
						startedAt: NOW - 90_000,
						targetId: "run:r2",
						capabilities: {
							view: true,
							steer: false,
							interrupt: false,
							kill: true,
						},
					},
				],
			},
			{
				key: "billing/worker",
				label: "worker · billing",
				status: "done",
				startedAt: NOW - 600_000,
				completedAt: NOW - 300_000,
				note: "fable-5",
				targetId: "worker:billing/worker",
				children: [
					{
						key: "run:r3",
						label: "review/style · billing",
						status: "done",
						startedAt: NOW - 500_000,
						completedAt: NOW - 400_000,
						targetId: "run:r3",
					},
				],
			},
			{
				key: "run:r9",
				label: "research · caching-strategy",
				status: "running",
				startedAt: NOW - 45_000,
				note: "haiku",
				targetId: "run:r9",
				children: [],
			},
		],
		plan: { rows: [], done: 1, total: 3 },
		questions: [],
	};
}

describe("hudElapsed", () => {
	it("formats seconds, minutes and hours", () => {
		expect(hudElapsed(9_000)).toBe("9s");
		expect(hudElapsed(252_000)).toBe("4m12s");
		expect(hudElapsed(3_660_000)).toBe("1h01m");
	});
});

describe("HUD collapsed state", () => {
	it("renders zero lines while collapsed (the tab bar carries the counts)", () => {
		const { c } = hud(agentsSnap(), {
			state: { focus: "input", expanded: false },
		});
		expect(c.render(W)).toEqual([]);
	});

	it("renders zero lines even on an empty snapshot", () => {
		const { c } = hud(EMPTY, { state: { focus: "input", expanded: false } });
		expect(c.render(W)).toEqual([]);
	});
});

describe("HUD expanded + focused", () => {
	it("caps with a plain top rule and ends with the hint row", () => {
		const { c } = hud(agentsSnap());
		const lines = c.render(W);
		// First line: the stratum's own top edge — a full-width plain rule.
		expect(lines[0]).toBe("─".repeat(W));
		// Last line: selected-row capabilities drive contextual hints.
		expect(lines[lines.length - 1]).toContain("↵ view");
		expect(lines[lines.length - 1]).toContain("S steer");
		expect(lines[lines.length - 1]).toContain("I stop");
		expect(lines[lines.length - 1]).toContain("K fail");
	});

	it("shows placeholder rows on an empty snapshot (never idle-collapses)", () => {
		const { c } = hud(EMPTY);
		const lines = c.render(W);
		expect(lines[0]).toBe("─".repeat(W));
		expect(lines[1]).toContain("no agents");
		expect(lines[lines.length - 1]).toContain("[/] tab");
	});
});

describe("HUD pinned (passive) state", () => {
	it("mutes every line, drops the hint row and the selection", () => {
		const theme = fakeTheme();
		const snap: HudSnapshot = {
			...agentsSnap(),
			questions: [
				{ key: "q1", asker: "maestro", blocking: true, text: "Pick a tier" },
			],
		};
		const { c, state } = hud(snap, { theme });
		// Focused first: hint present, selection inverse band on a row.
		let lines = c.render(W);
		expect(lines.some((l) => l.includes("\u001b[7m"))).toBe(true);
		expect(lines[lines.length - 1]).toContain("[/] tab");
		// Pin: focus back on the input, panel stays expanded.
		state.focus = "input";
		lines = c.render(W);
		// No hint row, no selection highlight.
		expect(lines.join("\n")).not.toContain("[/] tab");
		expect(lines.some((l) => l.includes("\u001b[7m"))).toBe(false);
		// Rules dim; every content line muted; tone accents suppressed.
		expect(lines[0]).toBe(`<dim>${"─".repeat(W)}</dim>`);
		for (const line of lines.slice(1)) {
			expect(line).toMatch(/^<muted>/);
		}
		expect(lines.join("\n")).not.toContain("<accent>");
	});
});

describe("HUD agents tab", () => {
	it("nests running children under an auto-expanded worker", () => {
		const { c } = hud(agentsSnap());
		const lines = c.render(W);
		// worker with a RUNNING child auto-expands with tree connectors.
		expect(lines[1]).toContain("▾ worker · auth-api");
		expect(lines[1]).toContain("running · 4m12s · fable-5");
		expect(lines[2]).toContain("├─ review/security · auth-api");
		expect(lines[3]).toContain("└─ verify/tests · auth-api");
		// done worker collapses to one line with the subagent count.
		expect(lines[4]).toContain("▸ worker · billing · 1 subagents");
		// maestro-direct run at root, no fold marker.
		expect(lines[5]).toContain("research · caching-strategy");
		// No bottom rule when nothing scrolls (hint is the last line).
		expect(lines[lines.length - 2]).not.toMatch(/^─+$/);
	});

	it("freezes terminal elapsed while live rows continue ticking", () => {
		let now = NOW;
		const snap = agentsSnap();
		const state: HudFocusState = { focus: "agents", expanded: true };
		const c = new HudComponent({
			state,
			data: () => snap,
			actions: actions(),
			now: () => now,
		});
		c.handleInput("\u001b[D"); // collapse auth so billing is visible
		const first = c.render(W).join("\n");
		expect(first).toContain("worker · billing · 1 subagents");
		expect(first).toContain("done · 5m00s");
		expect(first).toContain("running · 4m12s");
		now += 60_000;
		const second = c.render(W).join("\n");
		expect(second).toContain("done · 5m00s");
		expect(second).toContain("running · 5m12s");
	});

	it("drops telemetry progressively as width narrows", () => {
		const snap = agentsSnap();
		const worker = snap.agents[0] as (typeof snap.agents)[number];
		const rich: HudSnapshot = {
			...snap,
			agents: [
				{
					...worker,
					input: 125_000,
					output: 8_000,
					cacheRead: 100_000,
					cacheWrite: 5_000,
				},
			],
		};
		const { c } = hud(rich);
		const wide = c.render(100)[1];
		expect(wide).toContain("↑125k ↓8k");
		expect(wide).toContain("CH 80%");
		expect(wide).toContain("fable-5 (high)");
		const medium = c.render(58)[1];
		expect(medium).toContain("running · 4m12s");
		expect(medium).not.toContain("fable-5 (high)");
		const narrow = c.render(34)[1];
		expect(narrow).toContain("worker · a");
		expect(narrow).toContain("running · 4m12s");
		expect(narrow).not.toContain("↑125k");
	});

	it("manual folds are sticky and beat the auto rule", () => {
		const { c } = hud(agentsSnap());
		c.render(W);
		// Selection starts on the auth worker; left arrow folds it manually.
		c.handleInput("\u001b[D");
		let lines = c.render(W);
		expect(lines[1]).toContain("▸ worker · auth-api · 2 subagents");
		// Still folded on re-render (sticky), despite a running child.
		lines = c.render(W);
		expect(lines[1]).toContain("▸ worker · auth-api · 2 subagents");
		// Right arrow expands the done billing worker (auto rule says collapse).
		c.handleInput("\u001b[B"); // → billing row (auth children now hidden)
		c.handleInput("\u001b[C");
		lines = c.render(W);
		expect(lines[2]).toContain("▾ worker · billing");
		expect(lines[3]).toContain("└─ review/style · billing");
	});

	it("enter attaches, S steers, I interrupts, and K fails the selected owner", () => {
		const acts = actions();
		const { c } = hud(agentsSnap(), { acts });
		c.render(W);
		c.handleInput("\r");
		expect(acts.attach).toHaveBeenCalledWith("worker:auth-api/worker");
		c.handleInput("\u001b[B"); // first child
		c.handleInput("S");
		expect(acts.steer).toHaveBeenCalledWith("run:r1");
		c.handleInput("I");
		expect(acts.interrupt).toHaveBeenCalledWith("run:r1");
		c.handleInput("K");
		expect(acts.kill).toHaveBeenCalledWith("run:r1");
	});
});

describe("HUD plan tab", () => {
	function planSnap(): HudSnapshot {
		return {
			agents: [],
			plan: {
				done: 1,
				total: 3,
				rows: [
					{ id: "d1", title: "Ship the API", state: "shipped", tasks: [] },
					{
						id: "d2",
						title: "Wire the HUD",
						state: "active",
						worker: "worker running",
						tasks: [
							{ id: "t1", title: "shell", done: true },
							{ id: "t2", title: "tabs", done: false },
						],
					},
					{
						id: "d3",
						title: "Docs",
						state: "queued",
						tasks: [{ id: "t3", title: "usage", done: false }],
					},
				],
			},
			questions: [
				{ key: "q", asker: "maestro", blocking: false, text: "keep hud?" },
			],
		};
	}

	it("renders checkbox rows, names the worker, and auto-expands the active row", () => {
		const { c } = hud(planSnap(), { state: { focus: "plan", expanded: true } });
		c.setTab("plan");
		const lines = c.render(W);
		expect(lines[1]).toContain("[x] Ship the API");
		expect(lines[2]).toContain("[~] Wire the HUD · worker running");
		expect(lines[3]).toContain("[x] shell");
		expect(lines[4]).toContain("[ ] tabs");
		expect(lines[5]).toContain("[ ] ▸ Docs");
		expect(lines.join("\n")).not.toContain("usage");
	});

	it("enter collapses/expands with a sticky override", () => {
		const { c } = hud(planSnap(), { state: { focus: "plan", expanded: true } });
		c.setTab("plan");
		c.render(W);
		c.handleInput("\u001b[B"); // select the active deliverable
		c.handleInput("\r"); // collapse it (override the auto-expand)
		let lines = c.render(W);
		expect(lines[2]).toContain("[~] ▸ Wire the HUD");
		expect(lines.join("\n")).not.toContain("[ ] tabs");
		// Sticky across re-renders.
		lines = c.render(W);
		expect(lines[2]).toContain("[~] ▸ Wire the HUD");
	});
});

describe("HUD questions tab", () => {
	function questionsSnap(): HudSnapshot {
		return {
			agents: [],
			plan: undefined,
			questions: [
				{
					key: "ask:tier",
					asker: "maestro",
					blocking: true,
					text: "Which tier should the workers use?",
				},
				{
					key: "queue:auth/worker:q1",
					asker: "worker · auth",
					blocking: false,
					text: "Keep the legacy endpoint?",
				},
				{
					key: "ask:old",
					asker: "maestro",
					blocking: false,
					deferred: true,
					text: "Deferred one",
				},
			],
		};
	}

	it("renders asker, blocking marker, and question text", () => {
		const { c } = hud(questionsSnap(), {
			state: { focus: "questions", expanded: true },
		});
		c.setTab("questions");
		const lines = c.render(W);
		expect(lines[1]).toContain("maestro · blocking — Which tier");
		expect(lines[2]).toContain("worker · auth — Keep the legacy endpoint?");
		expect(lines[3]).toContain("maestro · deferred — Deferred one");
	});

	it("enter on a question row invokes the answer action", () => {
		const acts = actions();
		const { c } = hud(questionsSnap(), {
			acts,
			state: { focus: "questions", expanded: true },
		});
		c.setTab("questions");
		c.render(W);
		c.handleInput("\r");
		expect(acts.answer).toHaveBeenCalledWith(
			expect.objectContaining({ key: "ask:tier", blocking: true }),
		);
	});
});

describe("HUD 10-line self-cap and scrolling", () => {
	function bigSnap(): HudSnapshot {
		return {
			agents: Array.from({ length: 14 }, (_, i) => ({
				key: `d${i}/worker`,
				label: `worker · d${i}`,
				status: "running" as const,
				startedAt: NOW - 10_000,
				targetId: `worker:d${i}/worker`,
				children: [],
			})),
			plan: undefined,
			questions: [],
		};
	}

	it("never exceeds 10 lines and reports overflow in the bottom rule", () => {
		// Pinned view: no hint row, so the row budget is one line larger.
		const { c } = hud(bigSnap(), { state: { focus: "input", expanded: true } });
		const lines = c.render(W);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(lines[lines.length - 1]).toContain("↓ 6 more");
	});

	it("scrolls the window with the selection while focused", () => {
		const { c } = hud(bigSnap());
		for (let i = 0; i < 9; i++) c.handleInput("\u001b[B");
		const lines = c.render(W);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(lines.join("\n")).toContain("worker · d9");
		expect(lines[lines.length - 1]).toContain("↑ 3 more");
		expect(lines[lines.length - 1]).toContain("↓ 4 more");
	});
});

describe("HUD tab switching", () => {
	it("[ and ] cycle tabs, reset the selection and track the shared focus", () => {
		const snap: HudSnapshot = {
			agents: agentsSnap().agents,
			plan: { rows: [], done: 0, total: 0 },
			questions: [],
		};
		const { c, state } = hud(snap);
		expect(c.activeTab).toBe("agents");
		c.handleInput("]");
		expect(c.activeTab).toBe("plan");
		expect(state.focus).toBe("plan");
		c.handleInput("]");
		expect(c.activeTab).toBe("questions");
		expect(state.focus).toBe("questions");
		c.handleInput("]");
		expect(c.activeTab).toBe("agents");
		c.handleInput("[");
		expect(c.activeTab).toBe("questions");
		expect(state.focus).toBe("questions");
	});
});

describe("HUD render cache", () => {
	it("returns the identical array when nothing changed", () => {
		const { c } = hud(agentsSnap());
		const first = c.render(W);
		const second = c.render(W);
		expect(second).toBe(first);
		const other = c.render(W - 10);
		expect(other).not.toBe(first);
	});

	it("invalidates when the focus state flips to pinned", () => {
		const { c, state } = hud(agentsSnap());
		const focused = c.render(W);
		state.focus = "input";
		const pinned = c.render(W);
		expect(pinned).not.toBe(focused);
	});
});
