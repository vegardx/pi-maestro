// HUD render snapshots: fixed-width string arrays over a static HudSnapshot
// (no terminal). Covers the idle collapse, the tab rule, per-tab rows, fold
// rules (auto + sticky manual overrides), focus hints, the 10-line self-cap
// with selection scrolling, and the render cache (identical array back when
// nothing changed).

import { describe, expect, it, vi } from "vitest";
import {
	type HudActions,
	HudComponent,
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
		answer: vi.fn(),
	} satisfies HudActions;
}

function hud(snap: HudSnapshot, acts: HudActions = actions()): HudComponent {
	return new HudComponent({
		data: () => snap,
		actions: acts,
		now: () => NOW,
	});
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
				note: "fable-5",
				targetId: "worker:auth-api/worker",
				children: [
					{
						key: "run:r1",
						label: "review/security · auth-api",
						status: "running",
						startedAt: NOW - 30_000,
						note: "gate: review",
						targetId: "run:r1",
					},
					{
						key: "run:r2",
						label: "verify/tests · auth-api",
						status: "done",
						startedAt: NOW - 90_000,
						targetId: "run:r2",
					},
				],
			},
			{
				key: "billing/worker",
				label: "worker · billing",
				status: "done",
				startedAt: NOW - 600_000,
				note: "fable-5",
				targetId: "worker:billing/worker",
				children: [
					{
						key: "run:r3",
						label: "review/style · billing",
						status: "done",
						startedAt: NOW - 500_000,
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

describe("HUD idle state", () => {
	it("collapses to one summary line plus the rule", () => {
		const lines = hud({
			agents: [],
			plan: { rows: [], done: 4, total: 5 },
			questions: [],
		}).render(40);
		expect(lines).toEqual(["  agents idle · plan 4/5", "─".repeat(40)]);
	});

	it("omits the plan fragment when no plan exists", () => {
		expect(hud(EMPTY).render(30)).toEqual(["  agents idle", "─".repeat(30)]);
	});
});

describe("HUD tab rule", () => {
	it("marks the active tab and carries the counts", () => {
		const snap: HudSnapshot = {
			agents: agentsSnap().agents,
			plan: { rows: [], done: 2, total: 5 },
			questions: [
				{ key: "q1", asker: "maestro", blocking: true, text: "Pick a tier" },
				{ key: "q2", asker: "worker · auth", blocking: false, text: "hm" },
			],
		};
		const c = hud(snap);
		const [rule] = c.render(W);
		expect(rule).toContain("[ Agents 6 ]");
		expect(rule).toContain("Plan 2/5");
		expect(rule).toContain("Questions 2 · 1 blocking");
		expect(rule).toMatch(/ tab ──$/);
		expect(rule.length).toBeLessThanOrEqual(W + 20); // plain, no ANSI
	});
});

describe("HUD agents tab", () => {
	it("nests running children under an auto-expanded worker", () => {
		const c = hud(agentsSnap());
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
		expect(lines[lines.length - 1]).toBe("─".repeat(W));
	});

	it("manual folds are sticky and beat the auto rule", () => {
		const snap = agentsSnap();
		const c = hud(snap);
		c.focused = true;
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

	it("enter attaches, s steers, i interrupts the selected row", () => {
		const acts = actions();
		const c = hud(agentsSnap(), acts);
		c.focused = true;
		c.render(W);
		c.handleInput("\r");
		expect(acts.attach).toHaveBeenCalledWith("worker:auth-api/worker");
		c.handleInput("\u001b[B"); // first child
		c.handleInput("s");
		expect(acts.steer).toHaveBeenCalledWith("run:r1");
		c.handleInput("i");
		expect(acts.interrupt).toHaveBeenCalledWith("run:r1");
	});

	it("replaces the last content row with the hint row when focused", () => {
		const c = hud(agentsSnap());
		c.focused = true;
		const lines = c.render(W);
		expect(lines[lines.length - 2]).toContain("enter attach");
		expect(lines[lines.length - 2]).toContain("s steer");
		expect(lines[lines.length - 2]).toContain("i interrupt");
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
		const c = hud(bigSnap());
		const lines = c.render(W);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(lines[lines.length - 1]).toContain("↓ 6 more");
	});

	it("scrolls the window with the selection", () => {
		const c = hud(bigSnap());
		c.focused = true;
		for (let i = 0; i < 9; i++) c.handleInput("\u001b[B");
		const lines = c.render(W);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(lines.join("\n")).toContain("worker · d9");
		expect(lines[lines.length - 1]).toContain("↑ 3 more");
		expect(lines[lines.length - 1]).toContain("↓ 4 more");
	});
});

describe("HUD tab switching", () => {
	it("[ and ] cycle tabs and reset the selection", () => {
		const snap: HudSnapshot = {
			agents: agentsSnap().agents,
			plan: { rows: [], done: 0, total: 0 },
			questions: [],
		};
		const c = hud(snap);
		c.focused = true;
		expect(c.activeTab).toBe("agents");
		c.handleInput("]");
		expect(c.activeTab).toBe("plan");
		c.handleInput("]");
		expect(c.activeTab).toBe("questions");
		c.handleInput("]");
		expect(c.activeTab).toBe("agents");
		c.handleInput("[");
		expect(c.activeTab).toBe("questions");
	});
});

describe("HUD render cache", () => {
	it("returns the identical array when nothing changed", () => {
		const c = hud(agentsSnap());
		const first = c.render(W);
		const second = c.render(W);
		expect(second).toBe(first);
		const other = c.render(W - 10);
		expect(other).not.toBe(first);
	});
});
