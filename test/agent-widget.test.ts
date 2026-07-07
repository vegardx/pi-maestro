import { describe, expect, it } from "vitest";
import {
	type AgentTableAgent,
	type AgentTableGroup,
	buildAgentTable,
	formatElapsed,
	formatTokens,
	hasActiveAgents,
	styleAgentTable,
} from "../packages/modes/src/runtime/agent-widget.js";
import {
	clearAgentWidget,
	syncAgentWidget,
} from "../packages/modes/src/runtime/dashboard.js";

const NOW = 1_000_000_000;

function agent(
	status: string,
	opts: {
		input?: number;
		output?: number;
		cacheRatio?: number;
		elapsedMs?: number;
	} = {},
): AgentTableAgent {
	return {
		status,
		startedAt: NOW - (opts.elapsedMs ?? 0),
		tokens: { input: opts.input ?? 0, output: opts.output ?? 0, turns: 1 },
		...(opts.cacheRatio !== undefined ? { cacheRatio: opts.cacheRatio } : {}),
	};
}

/** The approved-design population: two groups, one with a fix round. */
function sampleAgents(): Map<string, AgentTableAgent> {
	return new Map([
		[
			"clamp/worker",
			agent("working", {
				input: 13_200,
				output: 2_200,
				cacheRatio: 0.54,
				elapsedMs: 252_000, // 4m12s
			}),
		],
		[
			"clamp/reviewer",
			agent("summarizing", {
				input: 4_300,
				output: 900,
				cacheRatio: 0,
				elapsedMs: 100_000, // 1m40s
			}),
		],
		[
			"average/worker",
			agent("working", {
				input: 8_800,
				output: 1_400,
				cacheRatio: 0.57,
				elapsedMs: 63_000, // 1m03s
			}),
		],
		["done-group/worker", agent("done", { input: 9_999 })],
		["pending-group/worker", agent("pending")],
	]);
}

function sampleGroups(): Map<string, AgentTableGroup> {
	return new Map([
		["clamp", { round: 1 }],
		["average", { round: 0 }],
	]);
}

describe("formatTokens", () => {
	it("renders one-decimal k from 100 tokens up, raw digits below", () => {
		expect(formatTokens(13_200)).toBe("13.2k");
		expect(formatTokens(2_200)).toBe("2.2k");
		expect(formatTokens(900)).toBe("0.9k");
		expect(formatTokens(100)).toBe("0.1k");
		expect(formatTokens(99)).toBe("99");
		expect(formatTokens(0)).toBe("0");
	});
});

describe("formatElapsed", () => {
	it("matches the done-card duration shape", () => {
		expect(formatElapsed(3_000)).toBe("3s");
		expect(formatElapsed(63_000)).toBe("1m03s");
		expect(formatElapsed(100_000)).toBe("1m40s");
		expect(formatElapsed(252_000)).toBe("4m12s");
		expect(formatElapsed(3_720_000)).toBe("1h02m");
	});
});

describe("buildAgentTable", () => {
	it("returns [] with no snapshot or no active agents", () => {
		expect(
			buildAgentTable({ agents: undefined, width: 100, now: NOW }),
		).toEqual([]);
		expect(
			buildAgentTable({ agents: new Map(), width: 100, now: NOW }),
		).toEqual([]);
		expect(
			buildAgentTable({
				agents: new Map([
					["g/worker", agent("done")],
					["g/reviewer", agent("failed")],
					["h/worker", agent("pending")],
				]),
				width: 100,
				now: NOW,
			}),
		).toEqual([]);
	});

	it("renders an aligned full-width box at width 100", () => {
		const lines = buildAgentTable({
			agents: sampleAgents(),
			groups: sampleGroups(),
			width: 100,
			now: NOW,
		});
		// Box: top border + header + 3 agent rows + bottom border.
		expect(lines).toHaveLength(6);
		for (const line of lines) expect(line).toHaveLength(100);
		expect(lines[0].startsWith("┌─ agents ─")).toBe(true);
		expect(lines[0].endsWith("─┐")).toBe(true);
		expect(lines[lines.length - 1]).toBe(`└${"─".repeat(98)}┘`);

		expect(lines[1]).toContain(
			"GROUP    AGENT     STATUS       TOKENS        CACHE  ELAPSED",
		);
		expect(lines[2]).toContain(
			"clamp    worker    fixing r1    13.2k / 2.2k  54%    4m12s",
		);
		expect(lines[3]).toContain(
			"clamp    reviewer  summarizing   4.3k / 0.9k   0%    1m40s",
		);
		expect(lines[4]).toContain(
			"average  worker    working       8.8k / 1.4k  57%    1m03s",
		);

		// Columns align: every row starts each column at the same offset.
		const agentCol = lines[1].indexOf("AGENT");
		expect(lines[2].indexOf("worker")).toBe(agentCol);
		expect(lines[3].indexOf("reviewer")).toBe(agentCol);
	});

	it("shows fixing rN only for workers of groups with round > 0", () => {
		const lines = buildAgentTable({
			agents: sampleAgents(),
			groups: sampleGroups(),
			width: 100,
			now: NOW,
		});
		expect(lines[2]).toContain("fixing r1"); // clamp worker
		expect(lines[3]).toContain("summarizing"); // clamp reviewer keeps status
		expect(lines[4]).toContain("working"); // average round 0
	});

	it("drops the CACHE column at width 60", () => {
		const lines = buildAgentTable({
			agents: sampleAgents(),
			groups: sampleGroups(),
			width: 60,
			now: NOW,
		});
		for (const line of lines) expect(line).toHaveLength(60);
		expect(lines[1]).toContain("TOKENS");
		expect(lines[1]).toContain("ELAPSED");
		expect(lines[1]).not.toContain("CACHE");
		expect(lines[2]).not.toContain("54%");
		expect(lines[2]).toContain("4m12s");
	});

	it("drops ELAPSED too when even narrower", () => {
		const lines = buildAgentTable({
			agents: sampleAgents(),
			groups: sampleGroups(),
			width: 50,
			now: NOW,
		});
		for (const line of lines) expect(line).toHaveLength(50);
		expect(lines[1]).not.toContain("CACHE");
		expect(lines[1]).not.toContain("ELAPSED");
		expect(lines[1]).toContain("TOKENS");
	});

	it("truncates long group/agent names with an ellipsis", () => {
		const agents = new Map([
			[
				"a-very-long-group-name-indeed/an-extremely-long-agent-name",
				agent("working", { input: 1_000, output: 100, elapsedMs: 1_000 }),
			],
		]);
		const lines = buildAgentTable({ agents, width: 80, now: NOW });
		expect(lines[2]).toContain("a-very-long-gro…");
		expect(lines[2]).toContain("an-extremely-lo…");
		for (const line of lines) expect(line).toHaveLength(80);
	});

	it("adds a full-width truncated row for a blocked group", () => {
		const groups = new Map<string, AgentTableGroup>([
			["clamp", { round: 1 }],
			["average", { round: 0, blocked: `review stalled: ${"x".repeat(200)}` }],
		]);
		const lines = buildAgentTable({
			agents: sampleAgents(),
			groups,
			width: 80,
			now: NOW,
		});
		const blocked = lines.find((line) => line.includes("⚠"));
		expect(blocked).toBeDefined();
		expect(blocked).toContain("⚠ average blocked: review stalled:");
		expect(blocked).toContain("…");
		expect(blocked).toHaveLength(80);
		// Blocked row sits between the agent rows and the bottom border.
		expect(lines.indexOf(blocked as string)).toBe(lines.length - 2);
	});
});

describe("hasActiveAgents", () => {
	it("is true only for working/summarizing agents", () => {
		expect(hasActiveAgents(undefined)).toBe(false);
		expect(hasActiveAgents(new Map([["g/worker", agent("done")]]))).toBe(false);
		expect(hasActiveAgents(new Map([["g/worker", agent("working")]]))).toBe(
			true,
		);
		expect(
			hasActiveAgents(new Map([["g/reviewer", agent("summarizing")]])),
		).toBe(true);
	});
});

describe("styleAgentTable", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	} as unknown as Parameters<typeof styleAgentTable>[1];

	it("dims borders and header, colors blocked rows, leaves rows plain", () => {
		const groups = new Map<string, AgentTableGroup>([
			["average", { round: 0, blocked: "reviewer stalled" }],
		]);
		const lines = buildAgentTable({
			agents: sampleAgents(),
			groups,
			width: 80,
			now: NOW,
		});
		const styled = styleAgentTable(lines, theme);
		expect(styled[0]).toMatch(/^<dim>┌/);
		expect(styled[1]).toMatch(/^<dim>│.*GROUP/);
		expect(styled[styled.length - 1]).toMatch(/^<dim>└/);
		expect(styled[2]).toBe(lines[2]); // agent row untouched
		const blocked = styled.find((line) => line.includes("⚠"));
		expect(blocked).toMatch(/^<error>│ ⚠/);
	});
});

describe("syncAgentWidget", () => {
	type SetWidgetCall = [string, unknown];

	function fakes(agents: Map<string, AgentTableAgent> | undefined) {
		const calls: SetWidgetCall[] = [];
		const rt = {
			agentWidgetTimer: undefined,
			execution: agents
				? {
						snapshot: () => ({
							agents,
							groups: new Map<string, AgentTableGroup>(),
						}),
					}
				: undefined,
		};
		const ctx = {
			ui: {
				setWidget: (key: string, content: unknown) => {
					calls.push([key, content]);
				},
			},
		};
		return { calls, rt, ctx };
	}

	it("sets a themed component for active agents and starts the timer", () => {
		const agents = new Map([
			["g/worker", agent("working", { input: 1_500, elapsedMs: 3_000 })],
		]);
		const { calls, rt, ctx } = fakes(agents);
		syncAgentWidget(rt as any, ctx as any);

		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe("maestro-agents");
		const factory = calls[0][1] as (
			tui: unknown,
			theme: unknown,
		) => { render(width: number): string[] };
		expect(typeof factory).toBe("function");
		const theme = { fg: (_c: string, s: string) => s };
		const rendered = factory(undefined, theme).render(80);
		expect(rendered[0]).toContain("agents");
		expect(rendered.join("\n")).toContain("g");
		expect(rt.agentWidgetTimer).toBeDefined();

		clearAgentWidget(rt as any, ctx as any);
		expect(rt.agentWidgetTimer).toBeUndefined();
		expect(calls[calls.length - 1]).toEqual(["maestro-agents", undefined]);
	});

	it("clears the widget when no agents are active or execution is gone", () => {
		const inactive = new Map([["g/worker", agent("done")]]);
		for (const agents of [inactive, undefined]) {
			const { calls, rt, ctx } = fakes(agents);
			syncAgentWidget(rt as any, ctx as any);
			expect(calls).toEqual([["maestro-agents", undefined]]);
			expect(rt.agentWidgetTimer).toBeUndefined();
		}
	});
});
