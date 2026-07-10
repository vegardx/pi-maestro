import { describe, expect, it } from "vitest";
import {
	type AgentTableAgent,
	type AgentTableDeliverable,
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
		model?: string;
		effort?: string;
		adaptive?: boolean;
	} = {},
): AgentTableAgent {
	return {
		status,
		startedAt: NOW - (opts.elapsedMs ?? 0),
		tokens: { input: opts.input ?? 0, output: opts.output ?? 0, turns: 1 },
		...(opts.cacheRatio !== undefined ? { cacheRatio: opts.cacheRatio } : {}),
		...(opts.model ? { model: opts.model } : {}),
		...(opts.effort ? { effort: opts.effort } : {}),
		...(opts.adaptive !== undefined ? { adaptive: opts.adaptive } : {}),
	};
}

/** The approved-design population: a spread of live agents across deliverables. */
function sampleAgents(): Map<string, AgentTableAgent> {
	return new Map([
		[
			"clamp/worker",
			agent("working", {
				input: 13_200,
				output: 2_200,
				cacheRatio: 0.54,
				elapsedMs: 252_000, // 4m12s
				model: "fable-5",
				effort: "medium",
				adaptive: true,
			}),
		],
		[
			"clamp/reviewer",
			agent("summarizing", {
				input: 4_300,
				output: 900,
				cacheRatio: 0,
				elapsedMs: 100_000, // 1m40s
				model: "opus-4-8",
				effort: "high",
				adaptive: true,
			}),
		],
		[
			"average/worker",
			agent("working", {
				input: 8_800,
				output: 1_400,
				cacheRatio: 0.57,
				elapsedMs: 63_000, // 1m03s
				model: "haiku-4-5",
				effort: "low",
			}),
		],
		["done-deliverable/worker", agent("done", { input: 9_999 })],
		["pending-deliverable/worker", agent("pending")],
	]);
}

function sampleDeliverables(): Map<string, AgentTableDeliverable> {
	return new Map([
		["clamp", {}],
		["average", {}],
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
			deliverables: sampleDeliverables(),
			width: 100,
			now: NOW,
		});
		// Box: header rule + 3 agent rows + bottom border (no title row).
		expect(lines).toHaveLength(5);
		for (const line of lines) expect(line).toHaveLength(100);
		// Headers live in the top rule; the "agents" title is gone.
		expect(lines[0].startsWith("┌─ DELIV ")).toBe(true);
		expect(lines[0]).not.toContain("agents");
		for (const h of [
			"AGENT",
			"STATUS",
			"MODEL",
			"EFF",
			"TOKENS",
			"CACHE",
			"ELAPSED",
		]) {
			expect(lines[0]).toContain(` ${h} `);
		}
		expect(lines[0].endsWith("┐")).toBe(true);
		expect(lines[lines.length - 1]).toBe(`└${"─".repeat(98)}┘`);

		// Row content, checked by component (column spacing is layout-dependent).
		for (const part of [
			"worker",
			"working",
			"fable-5",
			"A/M",
			"13.2k / 2.2k",
			"54%",
			"4m12s",
		]) {
			expect(lines[1]).toContain(part);
		}
		for (const part of [
			"reviewer",
			"opus-4-8",
			"A/H",
			"4.3k / 0.9k",
			"1m40s",
		]) {
			expect(lines[2]).toContain(part);
		}
		// Fixed-effort model shows a bare level (no A/ prefix).
		for (const part of ["haiku-4-5", "8.8k / 1.4k", "57%", "1m03s"]) {
			expect(lines[3]).toContain(part);
		}
		expect(lines[3]).toContain(" L "); // bare low, not A/L

		// DELIVERABLE flexes: rows fill the full width, labels sit one cell right
		// of their column (the rule's "┌─ " prefix vs the rows' "│ ").
		const agentLabel = lines[0].indexOf("AGENT");
		expect(lines[1].indexOf("worker")).toBe(agentLabel - 1);
		expect(lines[2].indexOf("reviewer")).toBe(agentLabel - 1);
	});

	it("drops CACHE/ELAPSED before MODEL as width shrinks", () => {
		const lines = buildAgentTable({
			agents: sampleAgents(),
			deliverables: sampleDeliverables(),
			width: 60,
			now: NOW,
		});
		for (const line of lines) expect(line).toHaveLength(60);
		expect(lines[0]).toContain("TOKENS");
		// MODEL survives; CACHE/ELAPSED are shed first.
		expect(lines[0]).toContain("MODEL");
		expect(lines[0]).not.toContain("CACHE");
		expect(lines[1]).not.toContain("54%");
	});

	it("drops ELAPSED too when even narrower", () => {
		const lines = buildAgentTable({
			agents: sampleAgents(),
			deliverables: sampleDeliverables(),
			width: 50,
			now: NOW,
		});
		for (const line of lines) expect(line).toHaveLength(50);
		expect(lines[0]).not.toContain("CACHE");
		expect(lines[0]).not.toContain("ELAPSED");
		expect(lines[0]).toContain("TOKENS");
	});

	it("truncates long deliverable/agent names with an ellipsis", () => {
		const agents = new Map([
			[
				"a-very-long-deliverable-name-indeed/an-extremely-long-agent-name",
				agent("working", { input: 1_000, output: 100, elapsedMs: 1_000 }),
			],
		]);
		const lines = buildAgentTable({ agents, width: 80, now: NOW });
		// DELIVERABLE flexes but still clips when the name exceeds the flexed width.
		expect(lines[1]).toMatch(/a-very-[a-z-]*…/);
		expect(lines[1]).toContain("an-extremely-lo…");
		for (const line of lines) expect(line).toHaveLength(80);
	});

	it("adds a full-width truncated row for a blocked deliverable", () => {
		const deliverables = new Map<string, AgentTableDeliverable>([
			["clamp", {}],
			["average", { blocked: `review stalled: ${"x".repeat(200)}` }],
		]);
		const lines = buildAgentTable({
			agents: sampleAgents(),
			deliverables,
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
		const deliverables = new Map<string, AgentTableDeliverable>([
			["average", { blocked: "reviewer stalled" }],
		]);
		const lines = buildAgentTable({
			agents: sampleAgents(),
			deliverables,
			width: 80,
			now: NOW,
		});
		const styled = styleAgentTable(lines, theme);
		expect(styled[0]).toMatch(/^<dim>┌─ DELIV/);
		expect(styled[styled.length - 1]).toMatch(/^<dim>└/);
		// Agent rows: frame dimmed, content untouched — color never bleeds
		// into the box characters.
		expect(styled[1]).toMatch(/^<dim>│ <\/dim>/);
		expect(styled[1]).toContain("worker");
		expect(styled[1]).not.toContain("<error>");
		const blocked = styled.find((line) => line.includes("⚠"));
		expect(blocked).toMatch(/^<dim>│ <\/dim><error>/);
		expect(blocked).toMatch(/<\/error><dim> │<\/dim>$/);
	});
});

describe("syncAgentWidget", () => {
	type SetWidgetCall = [string, unknown];

	function fakes(
		agents: Map<string, AgentTableAgent> | undefined,
		researchRuns = new Map(),
	) {
		const calls: SetWidgetCall[] = [];
		let reasserts = 0;
		const rt = {
			agentWidgetTimer: undefined,
			agentWidgetMounted: false,
			agentWidgetRefresh: undefined,
			researchRuns,
			overlayManager: {
				reassert: () => {
					reasserts++;
				},
			},
			reasserts: () => reasserts,
			execution: agents
				? {
						snapshot: () => ({
							agents,
							deliverables: new Map<string, AgentTableDeliverable>(),
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

	it("mounts once: re-syncs refresh in place, never re-set the widget", () => {
		// Regression: re-setting the widget per sync reshuffled pi's widget
		// stack (setWidget deletes + re-appends) and forced every overlay to be
		// re-set too — the readiness/ask dialog visibly blinked on every tick
		// and agent state change.
		const agents = new Map([
			["g/worker", agent("working", { input: 1_500, elapsedMs: 3_000 })],
		]);
		const { calls, rt, ctx } = fakes(agents);
		let renders = 0;
		syncAgentWidget(rt as any, ctx as any);
		// Simulate pi invoking the factory (captures the refresh handle).
		const factory = calls[0][1] as (tui: unknown, theme: unknown) => unknown;
		factory(
			{ requestRender: () => renders++ },
			{ fg: (_c: string, s: string) => s },
		);

		syncAgentWidget(rt as any, ctx as any);
		syncAgentWidget(rt as any, ctx as any);

		expect(calls).toHaveLength(1); // never re-set
		expect((rt as any).reasserts()).toBe(1); // ordering fixed once
		expect(renders).toBe(2); // later syncs re-render in place

		clearAgentWidget(rt as any, ctx as any);
		expect((rt as any).agentWidgetMounted).toBe(false);
		// After a clear, the next sync mounts fresh.
		syncAgentWidget(rt as any, ctx as any);
		expect(calls.filter(([, c]) => c !== undefined)).toHaveLength(2);
	});

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
		expect(rendered[0]).toContain("DELIV");
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

	it("shows research runs without an execution handle (plan mode)", () => {
		const research = new Map([
			[
				"run-1",
				{
					id: "run-1",
					question: "how do TUI libraries debounce resize?",
					label: "how-do-tui-libraries",
					kind: "web",
					status: "running",
					startedAt: NOW - 42_000,
					tokensIn: 8_200,
					tokensOut: 400,
					activity: "websearch",
				},
			],
		]);
		const { calls, rt, ctx } = fakes(undefined, research);
		syncAgentWidget(rt as any, ctx as any);
		expect(calls).toHaveLength(1);
		const factory = calls[0][1] as (
			tui: unknown,
			theme: unknown,
		) => { render(width: number): string[] };
		const theme = { fg: (_c: string, s: string) => s };
		const rendered = factory(undefined, theme).render(90);
		const joined = rendered.join("\n");
		expect(joined).toContain("research");
		// AGENT column clips at NAME_CAP (16 cells) with an ellipsis.
		expect(joined).toContain("how-do-tui-libr…");
		expect(joined).toContain("searching");
		expect(joined).toContain("8.2k / 0.4k");
		clearAgentWidget(rt as any, ctx as any);
	});
});

describe("no-usage providers", () => {
	it("renders – instead of 0 / 0 once turns exist without tokens", () => {
		const lines = buildAgentTable({
			agents: new Map([
				["arch/worker", agent("working", { elapsedMs: 60_000 })], // turns: 1, 0/0
			]),
			width: 100,
			now: NOW,
		});
		const row = lines[1];
		expect(row).toContain("–");
		expect(row).not.toContain("0 / 0");
	});

	it("keeps real zero-token display for agents that have not turned yet", () => {
		const fresh = {
			status: "working",
			startedAt: NOW,
			tokens: { input: 0, output: 0, turns: 0 },
		};
		const lines = buildAgentTable({
			agents: new Map([["arch/worker", fresh]]),
			width: 100,
			now: NOW,
		});
		expect(lines[1]).toContain("0 / 0");
	});
});
