import { describe, expect, it } from "vitest";
import {
	buildAgentSeed,
	buildSummarizeInstruction,
	buildWorkerSeed,
	groupBranch,
	isWorkerComplete,
	nextUnblockedAgents,
	resolveBaseBranch,
	workerSummaryConsumer,
} from "../packages/modes/src/agent-lifecycle.js";
import type { AgentSpec, WorkGroup } from "../packages/modes/src/schema.js";

function makeGroup(overrides: Partial<WorkGroup> = {}): WorkGroup {
	return {
		id: "auth" as never,
		title: "Auth System",
		body: "Implement authentication",
		status: "active",
		dependsOn: [],
		stacked: true,
		tasks: [
			{
				id: "t1" as never,
				title: "Login endpoint",
				body: "POST /login in src/auth.ts",
				kind: "task",
				done: false,
			},
			{
				id: "t2" as never,
				title: "Refresh endpoint",
				kind: "task",
				done: false,
			},
		],
		worker: { mode: "full" },
		agents: [],
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

describe("buildWorkerSeed", () => {
	it("includes group title and body", () => {
		const seed = buildWorkerSeed(makeGroup(), {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("Auth System");
		expect(seed).toContain("Implement authentication");
	});

	it("includes tasks with bodies", () => {
		const seed = buildWorkerSeed(makeGroup(), {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("Login endpoint");
		expect(seed).toContain("POST /login in src/auth.ts");
		expect(seed).toContain("Refresh endpoint");
	});

	it("includes dep summaries before group content", () => {
		const seed = buildWorkerSeed(makeGroup(), {
			depSummaries: ["## From: core\nBuilt shared types."],
			siblingeSummaries: [],
		});
		const depIdx = seed.indexOf("From: core");
		const groupIdx = seed.indexOf("Auth System");
		expect(depIdx).toBeLessThan(groupIdx);
	});

	it("includes worker instructions", () => {
		const seed = buildWorkerSeed(makeGroup(), {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("Toggle each task");
		expect(seed).toContain("maestro handles pushing");
	});
});

describe("buildAgentSeed", () => {
	it("includes agent focus", () => {
		const agent = makeAgent();
		const seed = buildAgentSeed(makeGroup(), agent, {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("Check for auth vulnerabilities");
		expect(seed).toContain("security");
	});

	it("includes sibling summaries", () => {
		const agent = makeAgent();
		const seed = buildAgentSeed(makeGroup(), agent, {
			depSummaries: [],
			siblingeSummaries: ["### worker\nImplemented login."],
		});
		expect(seed).toContain("Prior agent results");
		expect(seed).toContain("Implemented login");
	});

	it("read-only agent gets reviewer instructions", () => {
		const agent = makeAgent({ mode: "read-only" });
		const seed = buildAgentSeed(makeGroup(), agent, {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("read-only reviewer");
		expect(seed).toContain("cannot edit files");
	});

	it("full-mode agent gets fix instructions", () => {
		const agent = makeAgent({ mode: "full" });
		const seed = buildAgentSeed(makeGroup(), agent, {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("fix issues");
	});
});

describe("resolveBaseBranch", () => {
	const groups: WorkGroup[] = [
		makeGroup({ id: "core" as never, dependsOn: [] }),
		makeGroup({ id: "auth" as never, dependsOn: ["core"] }),
	];

	it("returns default branch for root group", () => {
		expect(resolveBaseBranch(groups[0], groups, "main")).toBe("main");
	});

	it("returns predecessor branch for stacked group", () => {
		expect(resolveBaseBranch(groups[1], groups, "main")).toBe("feat/core");
	});

	it("returns default branch when stacked=false", () => {
		const g = { ...groups[1], stacked: false };
		expect(resolveBaseBranch(g, groups, "main")).toBe("main");
	});

	it("returns default branch when dep not found", () => {
		const g = makeGroup({ dependsOn: ["nonexistent"] });
		expect(resolveBaseBranch(g, groups, "main")).toBe("main");
	});
});

describe("groupBranch", () => {
	it("prefixes with feat/", () => {
		expect(groupBranch("auth")).toBe("feat/auth");
		expect(groupBranch("token-refresh")).toBe("feat/token-refresh");
	});
});

describe("isWorkerComplete", () => {
	it("returns false when tasks remain", () => {
		expect(isWorkerComplete(makeGroup())).toBe(false);
	});

	it("returns true when all tasks done", () => {
		const g = makeGroup({
			tasks: [
				{ id: "t1" as never, title: "T1", kind: "task", done: true },
				{ id: "t2" as never, title: "T2", kind: "task", done: true },
			],
		});
		expect(isWorkerComplete(g)).toBe(true);
	});

	it("returns false for empty tasks", () => {
		expect(isWorkerComplete(makeGroup({ tasks: [] }))).toBe(false);
	});
});

describe("nextUnblockedAgents", () => {
	it("returns agents whose deps are all completed", () => {
		const group = makeGroup({
			agents: [
				makeAgent({ name: "review", after: ["worker"] }),
				makeAgent({ name: "fix", after: ["review"] }),
			],
		});
		const unblocked = nextUnblockedAgents(group, new Set(["worker"]));
		expect(unblocked.map((a) => a.name)).toEqual(["review"]);
	});

	it("returns multiple agents when parallel", () => {
		const group = makeGroup({
			agents: [
				makeAgent({ name: "security", after: ["worker"] }),
				makeAgent({ name: "perf", after: ["worker"] }),
			],
		});
		const unblocked = nextUnblockedAgents(group, new Set(["worker"]));
		expect(unblocked.map((a) => a.name)).toEqual(["security", "perf"]);
	});

	it("returns nothing when deps not met", () => {
		const group = makeGroup({
			agents: [makeAgent({ name: "fix", after: ["review"] })],
		});
		const unblocked = nextUnblockedAgents(group, new Set(["worker"]));
		expect(unblocked).toEqual([]);
	});
});

describe("buildSummarizeInstruction", () => {
	it("produces summarize message", () => {
		const msg = buildSummarizeInstruction("security review", "## Header");
		expect(msg.type).toBe("summarize");
		expect(msg.consumer).toBe("security review");
		expect(msg.preamble).toBe("## Header");
	});
});

describe("workerSummaryConsumer", () => {
	it("mentions next agents when present", () => {
		const agents = [makeAgent({ name: "security", focus: "auth vulns" })];
		const consumer = workerSummaryConsumer(makeGroup(), agents);
		expect(consumer).toContain("security");
		expect(consumer).toContain("auth vulns");
	});

	it("mentions downstream groups when no next agents", () => {
		const consumer = workerSummaryConsumer(makeGroup(), []);
		expect(consumer).toContain("Downstream groups");
	});
});
