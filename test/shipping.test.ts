import { describe, expect, it } from "vitest";
import type { PlanNode } from "../packages/modes/src/plan/schema.js";
import { buildPrBody, shouldShip } from "../packages/modes/src/shipping.js";

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
	return {
		type: "node" as const,
		createdAt: "t",
		updatedAt: "t",
		id: "test-deliverable",
		agent: "worker",
		persona: "coder",
		title: "Test Deliverable",
		body: "Deliverable description",
		status: "complete",
		branch: "feat/test-deliverable",
		authoredBy: "plan",
		tasks: [
			{
				id: "t1",
				title: "Task one",
				body: "",
				done: true,
				createdAt: "t",
				updatedAt: "t",
			},
			{
				id: "t2",
				title: "Task two",
				body: "",
				done: true,
				createdAt: "t",
				updatedAt: "t",
			},
		],
		...overrides,
	};
}

describe("shouldShip", () => {
	it("returns true for complete terminal node", () => {
		expect(shouldShip(makeNode(), false)).toBe(true);
	});

	it("returns false for complete non-terminal node", () => {
		expect(shouldShip(makeNode(), true)).toBe(false);
	});

	it("returns false for non-complete node", () => {
		expect(shouldShip(makeNode({ status: "active" }), false)).toBe(false);
	});

	it("returns false for already-shipped node", () => {
		expect(shouldShip(makeNode({ status: "shipped" }), false)).toBe(false);
	});
});

describe("buildPrBody", () => {
	it("includes node body", () => {
		const body = buildPrBody(makeNode(), []);
		expect(body).toContain("Deliverable description");
	});

	it("renders task checklist", () => {
		const body = buildPrBody(makeNode(), []);
		expect(body).toContain("- [x] Task one");
		expect(body).toContain("- [x] Task two");
	});

	it("includes agent reports", () => {
		const body = buildPrBody(makeNode(), [
			"### Worker\nDid stuff.",
			"### Review\nLooks good.",
		]);
		expect(body).toContain("### Worker");
		expect(body).toContain("Did stuff.");
		expect(body).toContain("### Review");
		expect(body).toContain("Looks good.");
	});

	it("omits sections when empty", () => {
		const body = buildPrBody(makeNode({ body: "", tasks: [] }), []);
		expect(body).toBe("");
	});

	it("omits tasks section for nodes with no tasks", () => {
		const body = buildPrBody(makeNode({ tasks: [] }), ["Report"]);
		expect(body).not.toContain("## Tasks");
		expect(body).toContain("Report");
	});
});
