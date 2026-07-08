import { describe, expect, it } from "vitest";
import {
	buildAgentSeed,
	buildSummarizeInstruction,
	buildWorkerSeed,
	deliverableBranch,
	isWorkerComplete,
	nextUnblockedAgents,
	resolveBaseBranch,
	workerSummaryConsumer,
} from "../packages/modes/src/agent-lifecycle.js";
import type { AgentSpec, Deliverable } from "../packages/modes/src/schema.js";

function makeDeliverable(overrides: Partial<Deliverable> = {}): Deliverable {
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
	it("includes deliverable title and body", () => {
		const seed = buildWorkerSeed(makeDeliverable(), {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("Auth System");
		expect(seed).toContain("Implement authentication");
	});

	it("includes tasks with bodies", () => {
		const seed = buildWorkerSeed(makeDeliverable(), {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("Login endpoint");
		expect(seed).toContain("POST /login in src/auth.ts");
		expect(seed).toContain("Refresh endpoint");
	});

	it("includes dep summaries before deliverable content", () => {
		const seed = buildWorkerSeed(makeDeliverable(), {
			depSummaries: ["## From: core\nBuilt shared types."],
			siblingeSummaries: [],
		});
		const depIdx = seed.indexOf("From: core");
		const deliverableIdx = seed.indexOf("Auth System");
		expect(depIdx).toBeLessThan(deliverableIdx);
	});

	it("includes worker instructions", () => {
		const seed = buildWorkerSeed(makeDeliverable(), {
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
		const seed = buildAgentSeed(makeDeliverable(), agent, {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("Check for auth vulnerabilities");
		expect(seed).toContain("security");
	});

	it("includes sibling summaries", () => {
		const agent = makeAgent();
		const seed = buildAgentSeed(makeDeliverable(), agent, {
			depSummaries: [],
			siblingeSummaries: ["### worker\nImplemented login."],
		});
		expect(seed).toContain("Prior agent results");
		expect(seed).toContain("Implemented login");
	});

	it("read-only agent gets reviewer instructions", () => {
		const agent = makeAgent({ mode: "read-only" });
		const seed = buildAgentSeed(makeDeliverable(), agent, {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("read-only reviewer");
		expect(seed).toContain("cannot edit files");
	});

	it("full-mode agent gets fix instructions", () => {
		const agent = makeAgent({ mode: "full" });
		const seed = buildAgentSeed(makeDeliverable(), agent, {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("fix issues");
	});
});

describe("resolveBaseBranch", () => {
	const deliverables: Deliverable[] = [
		makeDeliverable({ id: "core" as never, dependsOn: [] }),
		makeDeliverable({ id: "auth" as never, dependsOn: ["core"] }),
	];

	it("returns default branch for root deliverable", () => {
		expect(resolveBaseBranch(deliverables[0], deliverables, "main")).toBe(
			"main",
		);
	});

	it("returns predecessor branch for stacked deliverable", () => {
		expect(resolveBaseBranch(deliverables[1], deliverables, "main")).toBe(
			"feat/core",
		);
	});

	it("returns default branch when stacked=false", () => {
		const g = { ...deliverables[1], stacked: false };
		expect(resolveBaseBranch(g, deliverables, "main")).toBe("main");
	});

	it("returns default branch when dep not found", () => {
		const g = makeDeliverable({ dependsOn: ["nonexistent"] });
		expect(resolveBaseBranch(g, deliverables, "main")).toBe("main");
	});
});

describe("deliverableBranch", () => {
	it("prefixes with feat/", () => {
		expect(deliverableBranch("auth")).toBe("feat/auth");
		expect(deliverableBranch("token-refresh")).toBe("feat/token-refresh");
	});
});

describe("isWorkerComplete", () => {
	it("returns false when tasks remain", () => {
		expect(isWorkerComplete(makeDeliverable())).toBe(false);
	});

	it("returns true when all tasks done", () => {
		const g = makeDeliverable({
			tasks: [
				{ id: "t1" as never, title: "T1", kind: "task", done: true },
				{ id: "t2" as never, title: "T2", kind: "task", done: true },
			],
		});
		expect(isWorkerComplete(g)).toBe(true);
	});

	it("returns false for empty tasks", () => {
		expect(isWorkerComplete(makeDeliverable({ tasks: [] }))).toBe(false);
	});
});

describe("nextUnblockedAgents", () => {
	it("returns agents whose deps are all completed", () => {
		const deliverable = makeDeliverable({
			agents: [
				makeAgent({ name: "review", after: ["worker"] }),
				makeAgent({ name: "fix", after: ["review"] }),
			],
		});
		const unblocked = nextUnblockedAgents(deliverable, new Set(["worker"]));
		expect(unblocked.map((a) => a.name)).toEqual(["review"]);
	});

	it("returns multiple agents when parallel", () => {
		const deliverable = makeDeliverable({
			agents: [
				makeAgent({ name: "security", after: ["worker"] }),
				makeAgent({ name: "perf", after: ["worker"] }),
			],
		});
		const unblocked = nextUnblockedAgents(deliverable, new Set(["worker"]));
		expect(unblocked.map((a) => a.name)).toEqual(["security", "perf"]);
	});

	it("returns nothing when deps not met", () => {
		const deliverable = makeDeliverable({
			agents: [makeAgent({ name: "fix", after: ["review"] })],
		});
		const unblocked = nextUnblockedAgents(deliverable, new Set(["worker"]));
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
		const consumer = workerSummaryConsumer(makeDeliverable(), agents);
		expect(consumer).toContain("security");
		expect(consumer).toContain("auth vulns");
	});

	it("mentions downstream deliverables when no next agents", () => {
		const consumer = workerSummaryConsumer(makeDeliverable(), []);
		expect(consumer).toContain("Downstream deliverables");
	});
});
