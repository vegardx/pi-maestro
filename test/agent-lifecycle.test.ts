import { describe, expect, it } from "vitest";
import {
	buildSummarizeInstruction,
	buildWorkerSeed,
	deliverableBranch,
	isWorkerComplete,
	workerSummaryConsumer,
} from "../packages/modes/src/agent-lifecycle.js";
import type { PlanNode } from "../packages/modes/src/plan/schema.js";

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
	return {
		type: "node" as const,
		createdAt: "t",
		updatedAt: "t",
		id: "auth",
		agent: "worker",
		persona: "coder",
		title: "Auth System",
		body: "Implement authentication",
		status: "active",
		branch: "feat/auth",
		authoredBy: "plan",
		tasks: [
			{
				id: "t1",
				title: "Login endpoint",
				body: "POST /login in src/auth.ts",
				done: false,
				createdAt: "t",
				updatedAt: "t",
			},
			{
				id: "t2",
				title: "Refresh endpoint",
				body: "",
				done: false,
				createdAt: "t",
				updatedAt: "t",
			},
		],
		...overrides,
	};
}

describe("buildWorkerSeed", () => {
	it("includes node title and body", () => {
		const seed = buildWorkerSeed(makeNode(), {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("Auth System");
		expect(seed).toContain("Implement authentication");
	});

	it("includes tasks with bodies", () => {
		const seed = buildWorkerSeed(makeNode(), {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("Login endpoint");
		expect(seed).toContain("POST /login in src/auth.ts");
		expect(seed).toContain("Refresh endpoint");
	});

	it("includes dep summaries before node content", () => {
		const seed = buildWorkerSeed(makeNode(), {
			depSummaries: ["## From: core\nBuilt shared types."],
			siblingeSummaries: [],
		});
		const depIdx = seed.indexOf("From: core");
		const nodeIdx = seed.indexOf("Auth System");
		expect(depIdx).toBeLessThan(nodeIdx);
	});

	it("includes worker instructions", () => {
		const seed = buildWorkerSeed(makeNode(), {
			depSummaries: [],
			siblingeSummaries: [],
		});
		expect(seed).toContain("Toggle each task");
		expect(seed).toContain("maestro handles pushing");
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
		expect(isWorkerComplete(makeNode())).toBe(false);
	});

	it("returns true when all tasks done", () => {
		const node = makeNode({
			tasks: [
				{
					id: "t1",
					title: "T1",
					body: "",
					done: true,
					createdAt: "t",
					updatedAt: "t",
				},
				{
					id: "t2",
					title: "T2",
					body: "",
					done: true,
					createdAt: "t",
					updatedAt: "t",
				},
			],
		});
		expect(isWorkerComplete(node)).toBe(true);
	});

	it("returns false for empty tasks", () => {
		expect(isWorkerComplete(makeNode({ tasks: [] }))).toBe(false);
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
	it("mentions next nodes when present", () => {
		const next = [
			makeNode({
				id: "security",
				agent: "reviewer",
				persona: "reviewer",
				title: "Security review",
				branch: undefined,
				tasks: [],
			}),
		];
		const consumer = workerSummaryConsumer(makeNode(), next);
		expect(consumer).toContain("security");
		expect(consumer).toContain("Security review");
	});

	it("mentions downstream deliverables when no next nodes", () => {
		const consumer = workerSummaryConsumer(makeNode(), []);
		expect(consumer).toContain("Downstream deliverables");
	});
});
