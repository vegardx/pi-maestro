import type { TokenSnapshot } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import { renderDashboard } from "../packages/modes/src/agents-dashboard.js";

const tokens: TokenSnapshot = {
	input: 12000,
	output: 3200,
	cacheRead: 60000,
	cacheWrite: 0,
	totalTokens: 15200,
	cost: 0.42,
	turns: 5,
};

// biome-ignore lint/suspicious/noExplicitAny: exercising the pure renderer
const rows: any[] = [
	{
		agentId: "d1",
		state: { status: "working", agentName: "grand-frost", tokens },
		title: "multiply",
		done: 2,
		total: 4,
		tasks: [
			{ title: "Implement", done: true },
			{ title: "Ship", done: false },
		],
		pending: undefined,
	},
	{
		agentId: "d2",
		state: { status: "awaiting-decision", agentName: "crisp-flint", tokens },
		title: "divide",
		done: 1,
		total: 4,
		tasks: [],
		pending: "What error type for division by zero?",
	},
];

describe("agents dashboard render", () => {
	it("renders rows, selection, tasks, pending and a totals footer", () => {
		const ledger = {
			record() {},
			snapshot: () => ({ bySource: new Map(), totals: tokens }),
		};
		const lines = renderDashboard(rows, 1, ledger, 100);
		const text = lines.join("\n");
		expect(text).toContain("multiply");
		expect(text).toContain("2/4 tasks");
		expect(text).toContain("✓ Implement");
		expect(text).toContain("? What error type");
		expect(text).toContain("CH:83%"); // 60000/(12000+60000)
		expect(text).toContain("Agents:");
		// selected row (index 1) is marked
		expect(lines.some((l) => l.includes("▸") && l.includes("divide"))).toBe(
			true,
		);
	});

	it("renders an empty state", () => {
		const lines = renderDashboard([], 0, undefined, 80);
		expect(lines.join("\n")).toContain("(no agents)");
	});
});
