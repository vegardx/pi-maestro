import { describe, expect, it } from "vitest";
import {
	APPROX_CHARS_PER_TOKEN,
	buildSeed,
	FINDINGS_FRAME,
	FINDINGS_HEADER,
	FOCUS_FRAME,
	FOCUS_HEADER,
	PRIOR_WORK_FRAME,
	PRIOR_WORK_HEADER,
	type SeedSummaries,
	TASKS_FRAME,
	TASKS_HEADER,
	TRUNCATION_MARKER,
	truncateSummary,
} from "../packages/modes/src/exec/seeds.js";
import type {
	AgentSpec,
	Plan,
	WorkGroup,
	WorkItem,
} from "../packages/modes/src/schema.js";

const NOW = "2026-01-01T00:00:00.000Z";

function makeTask(overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		type: "work-item",
		id: "t1",
		title: "Login endpoint",
		body: "POST /login in src/auth.ts",
		done: false,
		kind: "task",
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function makeAgent(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name: "security",
		mode: "read-only",
		slot: "alternate",
		effort: "high",
		focus: "Check for auth vulnerabilities",
		after: ["worker"],
		...overrides,
	};
}

function makeGroup(overrides: Partial<WorkGroup> = {}): WorkGroup {
	return {
		type: "group",
		id: "auth",
		title: "Auth System",
		body: "Implement authentication",
		status: "active",
		worker: { mode: "full" },
		agents: [],
		tasks: [makeTask()],
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function makePlan(groups: WorkGroup[]): Pick<Plan, "groups"> {
	return { groups };
}

function summaries(
	groups: [string, string][] = [],
	agents: [string, string][] = [],
): SeedSummaries {
	return { groups: new Map(groups), agents: new Map(agents) };
}

/** Deterministic LCG-based shuffle so property runs are reproducible. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
	const out = [...items];
	let state = seed;
	for (let i = out.length - 1; i > 0; i--) {
		state = (state * 1103515245 + 12345) % 2147483648;
		const j = state % (i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

describe("buildSeed determinism", () => {
	it("produces byte-identical output across 50 shuffled map insertion orders", () => {
		const deps = ["core", "db", "api"].map((id) =>
			makeGroup({ id, title: `Group ${id}` }),
		);
		const group = makeGroup({
			dependsOn: ["core", "db", "api"],
			agents: [
				makeAgent({ name: "security", after: ["worker"] }),
				makeAgent({ name: "perf", after: ["security"] }),
				makeAgent({ name: "docs", after: ["perf"] }),
			],
		});
		const plan = makePlan([...deps, group]);
		const groupEntries: [string, string][] = [
			["core", "core summary"],
			["db", "db summary"],
			["api", "api summary"],
		];
		const agentEntries: [string, string][] = [
			["worker", "worker built it"],
			["security", "no vulns found"],
			["perf", "fast enough"],
		];

		const baseline = buildSeed({
			plan,
			group,
			agentName: "docs",
			summaries: summaries(groupEntries, agentEntries),
		});

		for (let i = 1; i <= 50; i++) {
			const seed = buildSeed({
				plan,
				group,
				agentName: "docs",
				summaries: {
					groups: new Map(shuffled(groupEntries, i)),
					agents: new Map(shuffled(agentEntries, i * 7 + 1)),
				},
			});
			expect(Buffer.from(seed).equals(Buffer.from(baseline))).toBe(true);
		}
	});

	it("is a pure function — repeated calls with the same input are identical", () => {
		const group = makeGroup();
		const plan = makePlan([group]);
		const a = buildSeed({
			plan,
			group,
			agentName: "worker",
			summaries: summaries(),
		});
		const b = buildSeed({
			plan,
			group,
			agentName: "worker",
			summaries: summaries(),
		});
		expect(a).toBe(b);
	});

	it("contains no timestamps", () => {
		const group = makeGroup({ dependsOn: ["core"] });
		const plan = makePlan([makeGroup({ id: "core", title: "Core" }), group]);
		const seed = buildSeed({
			plan,
			group,
			agentName: "worker",
			summaries: summaries([["core", "core summary"]]),
		});
		expect(seed).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
	});
});

describe("buildSeed section ordering + framing", () => {
	it("orders sections Prior Work → Findings → Your Tasks with frames", () => {
		const group = makeGroup({
			dependsOn: ["core"],
			agents: [makeAgent({ name: "security" })],
		});
		const plan = makePlan([makeGroup({ id: "core", title: "Core" }), group]);
		const seed = buildSeed({
			plan,
			group,
			agentName: "worker",
			summaries: summaries(
				[["core", "core summary"]],
				[["security", "found a bug"]],
			),
		});

		const prior = seed.indexOf(PRIOR_WORK_HEADER);
		const findings = seed.indexOf(FINDINGS_HEADER);
		const tasks = seed.indexOf(TASKS_HEADER);
		expect(prior).toBeGreaterThanOrEqual(0);
		expect(findings).toBeGreaterThan(prior);
		expect(tasks).toBeGreaterThan(findings);
		expect(seed).toContain(PRIOR_WORK_FRAME);
		expect(seed).toContain(FINDINGS_FRAME);
		expect(seed).toContain(TASKS_FRAME);
	});

	it("orders dep summaries by dependsOn array order, not map order", () => {
		const group = makeGroup({ dependsOn: ["zeta", "alpha"] });
		const plan = makePlan([
			makeGroup({ id: "alpha", title: "Alpha" }),
			makeGroup({ id: "zeta", title: "Zeta" }),
			group,
		]);
		const seed = buildSeed({
			plan,
			group,
			agentName: "worker",
			summaries: summaries([
				["alpha", "alpha summary"],
				["zeta", "zeta summary"],
			]),
		});
		expect(seed.indexOf("zeta summary")).toBeLessThan(
			seed.indexOf("alpha summary"),
		);
	});

	it("orders sibling summaries topologically, not by map order", () => {
		const group = makeGroup({
			agents: [
				makeAgent({ name: "second", after: ["first"] }),
				makeAgent({ name: "first", after: ["worker"] }),
				makeAgent({ name: "third", after: ["second"] }),
			],
		});
		const plan = makePlan([group]);
		const seed = buildSeed({
			plan,
			group,
			agentName: "third",
			summaries: summaries(
				[],
				[
					["second", "second findings"],
					["first", "first findings"],
					["worker", "worker findings"],
				],
			),
		});
		const worker = seed.indexOf("worker findings");
		const first = seed.indexOf("first findings");
		const second = seed.indexOf("second findings");
		expect(worker).toBeLessThan(first);
		expect(first).toBeLessThan(second);
	});

	it("excludes the agent's own summary from findings", () => {
		const group = makeGroup({ agents: [makeAgent({ name: "security" })] });
		const seed = buildSeed({
			plan: makePlan([group]),
			group,
			agentName: "security",
			summaries: summaries([], [["security", "my own old summary"]]),
		});
		expect(seed).not.toContain("my own old summary");
	});

	it("worker seed includes group body and task list with done markers", () => {
		const group = makeGroup({
			tasks: [
				makeTask({ id: "t1", title: "Login endpoint", done: true }),
				makeTask({
					id: "t2",
					title: "Refresh endpoint",
					body: "",
					done: false,
				}),
			],
		});
		const seed = buildSeed({
			plan: makePlan([group]),
			group,
			agentName: "worker",
			summaries: summaries(),
		});
		expect(seed).toContain("## Group: Auth System");
		expect(seed).toContain("Implement authentication");
		expect(seed).toContain("- [x] **Login endpoint**");
		expect(seed).toContain("- [ ] **Refresh endpoint**");
	});

	it("support agent gets Your Focus (framed), not Your Tasks", () => {
		const group = makeGroup({ agents: [makeAgent({ name: "security" })] });
		const seed = buildSeed({
			plan: makePlan([group]),
			group,
			agentName: "security",
			summaries: summaries(),
		});
		expect(seed).toContain(FOCUS_HEADER);
		expect(seed).toContain(FOCUS_FRAME);
		expect(seed).toContain("Check for auth vulnerabilities");
		expect(seed).not.toContain(TASKS_HEADER);
	});

	it("throws for an unknown agent name", () => {
		const group = makeGroup();
		expect(() =>
			buildSeed({
				plan: makePlan([group]),
				group,
				agentName: "ghost",
				summaries: summaries(),
			}),
		).toThrow(/ghost/);
	});
});

describe("buildSeed empty-section omission", () => {
	it("omits Prior Work and Findings entirely when there are no summaries", () => {
		const group = makeGroup({ dependsOn: ["core"] });
		const plan = makePlan([makeGroup({ id: "core" }), group]);
		const seed = buildSeed({
			plan,
			group,
			agentName: "worker",
			summaries: summaries(),
		});
		expect(seed).not.toContain(PRIOR_WORK_HEADER);
		expect(seed).not.toContain(FINDINGS_HEADER);
		expect(seed.startsWith(TASKS_HEADER)).toBe(true);
	});

	it("omits deps that have no stored summary", () => {
		const group = makeGroup({ dependsOn: ["core", "db"] });
		const plan = makePlan([
			makeGroup({ id: "core", title: "Core" }),
			makeGroup({ id: "db", title: "DB" }),
			group,
		]);
		const seed = buildSeed({
			plan,
			group,
			agentName: "worker",
			summaries: summaries([["db", "db summary"]]),
		});
		expect(seed).toContain("## DB (db)");
		expect(seed).not.toContain("## Core (core)");
	});
});

describe("truncateSummary", () => {
	it("returns short summaries unchanged", () => {
		expect(truncateSummary("short", 10)).toBe("short");
	});

	it("truncates at a paragraph boundary and appends the fixed marker", () => {
		const paragraph = "x".repeat(80);
		const input = [paragraph, paragraph, paragraph].join("\n\n");
		const budget = 40; // 160 chars — fits one paragraph, not two
		const out = truncateSummary(input, budget);
		expect(out).toBe(`${paragraph}\n\n${TRUNCATION_MARKER}`);
		expect(out.length).toBeLessThanOrEqual(budget * APPROX_CHARS_PER_TOKEN);
	});

	it("hard-cuts when there is no paragraph boundary", () => {
		const input = "y".repeat(1000);
		const out = truncateSummary(input, 50);
		expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(50 * APPROX_CHARS_PER_TOKEN);
	});

	it("is deterministic", () => {
		const input = Array.from(
			{ length: 50 },
			(_, i) => `para ${i} ${"z".repeat(60)}`,
		).join("\n\n");
		const a = truncateSummary(input, 25);
		const b = truncateSummary(input, 25);
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
	});
});
