import type { TokenSnapshot } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import {
	CollapsibleDashboardComponent,
	type DashboardRenderState,
	type Row,
	renderDashboard,
} from "../packages/modes/src/agents-dashboard.js";

const tokens: TokenSnapshot = {
	input: 12000,
	output: 3200,
	cacheRead: 60000,
	cacheWrite: 0,
	totalTokens: 15200,
	cost: 0.42,
	turns: 5,
};

const rows: Row[] = [
	{
		agentId: "d1",
		state: {
			status: "working",
			agentName: "grand-frost",
			tokens,
			deliverableId: "d1",
			worktreePath: "/tmp/d1",
			sessionFile: "/tmp/d1.json",
			startedAt: Date.now() - 92_000,
			shutdownSent: false,
			assessmentSent: false,
			idleCount: 0,
			lensRuns: 1,
			reviewCycles: 1,
		},
		title: "multiply",
		done: 2,
		total: 4,
		tasks: [
			{ title: "Implement", done: true },
			{ title: "Ship", done: false },
		],
		pending: undefined,
		elapsedMs: 92_000,
	},
	{
		agentId: "d2",
		state: {
			status: "awaiting-decision",
			agentName: "crisp-flint",
			tokens,
			deliverableId: "d2",
			worktreePath: "/tmp/d2",
			sessionFile: "/tmp/d2.json",
			startedAt: Date.now() - 45_000,
			shutdownSent: false,
			assessmentSent: false,
			idleCount: 0,
			lensRuns: 0,
			reviewCycles: 0,
		},
		title: "divide",
		done: 1,
		total: 4,
		tasks: [],
		pending: "What error type for division by zero?",
		elapsedMs: 45_000,
	},
	{
		agentId: "d3",
		state: {
			status: "done",
			agentName: "swift-pine",
			tokens,
			deliverableId: "d3",
			worktreePath: "/tmp/d3",
			sessionFile: "/tmp/d3.json",
			startedAt: Date.now() - 180_000,
			shutdownSent: false,
			assessmentSent: false,
			idleCount: 0,
			lensRuns: 2,
			reviewCycles: 0,
		},
		title: "config-loader",
		done: 3,
		total: 3,
		tasks: [
			{ title: "Load config", done: true },
			{ title: "Validate", done: true },
			{ title: "Export", done: true },
		],
		pending: undefined,
		elapsedMs: 180_000,
	},
];

function render(
	testRows: Row[],
	state: DashboardRenderState = { activeTab: "all", selected: 0 },
	width = 100,
) {
	return renderDashboard(testRows, state, undefined, width);
}

describe("agents dashboard render", () => {
	it("renders box borders", () => {
		const lines = render(rows);
		expect(lines[0]).toMatch(/^╭─ Agents ─+╮$/);
		expect(lines[lines.length - 1]).toMatch(/^╰─+╯$/);
		expect(lines.some((l) => l.startsWith("│") && l.includes("─"))).toBe(true);
	});

	it("renders tab bar with counts", () => {
		const text = render(rows).join("\n");
		expect(text).toContain("All 3");
		expect(text).toContain("Working 1");
		expect(text).toContain("Waiting 1");
		expect(text).toContain("Done 1");
		expect(text).toContain("Failed 0");
	});

	it("renders agent rows with tokens and cache hit", () => {
		const text = render(rows).join("\n");
		expect(text).toContain("multiply");
		expect(text).toContain("2/4");
		expect(text).toContain("CH:83%"); // 60000/(12000+60000)
		expect(text).toContain("↑12.0k");
		expect(text).toContain("↓3.2k");
	});

	it("renders elapsed time", () => {
		const text = render(rows).join("\n");
		expect(text).toContain("1m32s"); // 92000ms
		expect(text).toContain("3m"); // 180000ms
	});

	it("expands only the selected row with tasks", () => {
		const lines = render(rows, { activeTab: "all", selected: 0 });
		const text = lines.join("\n");
		// Selected row (multiply) expands with tasks
		expect(text).toContain("✓");
		expect(text).toContain("Implement");
		expect(text).toContain("Ship");
		expect(text).toContain("┊");
		// Non-selected rows do NOT show their tasks inline
		// config-loader tasks should not appear
		expect(text).not.toContain("Load config");
		expect(text).not.toContain("Validate");
	});

	it("shows pending question for selected agent", () => {
		const lines = render(rows, { activeTab: "all", selected: 1 });
		const text = lines.join("\n");
		expect(text).toContain("What error type for division by zero?");
	});

	it("filters by tab", () => {
		const lines = render(rows, { activeTab: "working", selected: 0 });
		const text = lines.join("\n");
		expect(text).toContain("multiply");
		expect(text).not.toContain("divide");
		expect(text).not.toContain("config-loader");
	});

	it("filters waiting tab shows only awaiting agents", () => {
		const lines = render(rows, { activeTab: "waiting", selected: 0 });
		const text = lines.join("\n");
		expect(text).toContain("divide");
		expect(text).not.toContain("multiply");
	});

	it("filters done tab shows only done agents", () => {
		const lines = render(rows, { activeTab: "done", selected: 0 });
		const text = lines.join("\n");
		expect(text).toContain("config-loader");
		expect(text).not.toContain("multiply");
	});

	it("shows (none) for empty filter", () => {
		const lines = render(rows, { activeTab: "failed", selected: 0 });
		const text = lines.join("\n");
		expect(text).toContain("(none)");
	});

	it("renders totals with tokens, not cost", () => {
		const text = render(rows).join("\n");
		expect(text).toContain("Total:");
		expect(text).toContain("turns:");
		expect(text).not.toContain("$");
	});

	it("renders keybinding hints", () => {
		const text = render(rows).join("\n");
		expect(text).toContain("[←/→] filter");
		expect(text).toContain("[↑↓] select");
		expect(text).toContain("[w]atch");
		expect(text).toContain("[esc] close");
	});

	it("renders selected row with ▸ prefix", () => {
		const lines = render(rows, { activeTab: "all", selected: 1 });
		expect(lines.some((l) => l.includes("▸") && l.includes("divide"))).toBe(
			true,
		);
	});

	it("renders an empty state within bordered frame", () => {
		const lines = render([]);
		const text = lines.join("\n");
		expect(lines[0]).toMatch(/^╭─ Agents ─+╮$/);
		expect(lines[lines.length - 1]).toMatch(/^╰─+╯$/);
		expect(text).toContain("(no agents)");
	});

	it("does not show cost anywhere", () => {
		const text = render(rows).join("\n");
		expect(text).not.toContain("$0.42");
		expect(text).not.toContain("cost");
	});
});

describe("CollapsibleDashboardComponent", () => {
	const tokens: TokenSnapshot = {
		input: 1000,
		output: 500,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1500,
		cost: 0,
		turns: 3,
	};

	const rows: Row[] = [
		{
			agentId: "a1",
			state: {
				agentName: "keen-otter",
				status: "working",
				tokens,
				startedAt: Date.now() - 5000,
				deliverableId: "a1",
				worktreePath: "/tmp/a1",
				sessionFile: "/tmp/a1.json",
				shutdownSent: false,
				assessmentSent: false,
				idleCount: 0,
				lensRuns: 0,
				reviewCycles: 0,
			},
			title: "Fix bug",
			done: 1,
			total: 3,
			tasks: [],
			elapsedMs: 5000,
		},
		{
			agentId: "a2",
			state: {
				agentName: "lively-heron",
				status: "awaiting-decision",
				tokens,
				startedAt: Date.now() - 2000,
				deliverableId: "a2",
				worktreePath: "/tmp/a2",
				sessionFile: "/tmp/a2.json",
				shutdownSent: false,
				assessmentSent: false,
				idleCount: 0,
				lensRuns: 0,
				reviewCycles: 0,
			},
			title: "Write docs",
			done: 0,
			total: 2,
			tasks: [],
			pending: "How?",
			elapsedMs: 2000,
		},
	];

	function makeComp() {
		const results: Array<unknown> = [];
		const comp = new CollapsibleDashboardComponent(rows, undefined, (action) =>
			results.push(action),
		);
		const handle = {
			focused: false,
			focus() {
				this.focused = true;
			},
			unfocus() {
				this.focused = false;
			},
		};
		comp.setHandle(handle);
		return { comp, handle, results };
	}

	it("renders collapsed state with agent counts", () => {
		const { comp } = makeComp();
		const lines = comp.render(70);
		expect(lines.length).toBe(2);
		const text = lines.join("\n");
		expect(text).toContain("2 agents");
		expect(text).toContain("1 working");
		expect(text).toContain("1 waiting");
		expect(text).toContain("Tab to expand");
	});

	it("expands on Tab and collapses on Tab again", () => {
		const { comp, handle } = makeComp();
		comp.focused = true;
		expect(comp.render(70).length).toBe(2);

		comp.handleInput("\t");
		const expanded = comp.render(70);
		expect(expanded.length).toBeGreaterThan(2);
		expect(expanded.join("\n")).toContain("Agents");
		expect(handle.focused).toBe(true);

		comp.handleInput("\t");
		expect(comp.render(70).length).toBe(2);
		expect(handle.focused).toBe(false);
	});

	it("navigates filter tabs with arrows when expanded", () => {
		const { comp } = makeComp();
		comp.focused = true;
		comp.handleInput("\t"); // expand

		// Right arrow cycles filter
		comp.handleInput("\u001b[C");
		const lines = comp.render(70).join("\n");
		expect(lines).toContain("[Working");
	});

	it("collapses on Esc", () => {
		const { comp, handle } = makeComp();
		comp.focused = true;
		comp.handleInput("\t");
		expect(comp.render(70).length).toBeGreaterThan(2);

		comp.handleInput("\u001b");
		expect(comp.render(70).length).toBe(2);
		expect(handle.focused).toBe(false);
	});
});
