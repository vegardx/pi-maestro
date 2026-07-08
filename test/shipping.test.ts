import { describe, expect, it } from "vitest";
import type { Deliverable } from "../packages/modes/src/schema.js";
import { buildPrBody, shouldShip } from "../packages/modes/src/shipping.js";

function makeDeliverable(overrides: Partial<Deliverable> = {}): Deliverable {
	return {
		id: "test-deliverable" as never,
		title: "Test Deliverable",
		body: "Deliverable description",
		status: "complete",
		dependsOn: [],
		stacked: true,
		tasks: [
			{ id: "t1" as never, title: "Task one", kind: "task", done: true },
			{ id: "t2" as never, title: "Task two", kind: "task", done: true },
		],
		worker: { mode: "full" },
		agents: [],
		...overrides,
	};
}

describe("shouldShip", () => {
	it("returns true for complete terminal deliverable", () => {
		expect(shouldShip(makeDeliverable(), false)).toBe(true);
	});

	it("returns false for complete non-terminal deliverable", () => {
		expect(shouldShip(makeDeliverable(), true)).toBe(false);
	});

	it("returns false for non-complete deliverable", () => {
		expect(shouldShip(makeDeliverable({ status: "active" }), false)).toBe(
			false,
		);
	});

	it("returns false for already-shipped deliverable", () => {
		expect(shouldShip(makeDeliverable({ status: "shipped" }), false)).toBe(
			false,
		);
	});
});

describe("buildPrBody", () => {
	it("includes deliverable body", () => {
		const body = buildPrBody(makeDeliverable(), []);
		expect(body).toContain("Deliverable description");
	});

	it("renders task checklist", () => {
		const body = buildPrBody(makeDeliverable(), []);
		expect(body).toContain("- [x] Task one");
		expect(body).toContain("- [x] Task two");
	});

	it("includes agent reports", () => {
		const body = buildPrBody(makeDeliverable(), [
			"### Worker\nDid stuff.",
			"### Review\nLooks good.",
		]);
		expect(body).toContain("### Worker");
		expect(body).toContain("Did stuff.");
		expect(body).toContain("### Review");
		expect(body).toContain("Looks good.");
	});

	it("omits sections when empty", () => {
		const body = buildPrBody(makeDeliverable({ body: "", tasks: [] }), []);
		expect(body).toBe("");
	});

	it("omits tasks section for deliverables with no tasks", () => {
		const body = buildPrBody(makeDeliverable({ tasks: [] }), ["Report"]);
		expect(body).not.toContain("## Tasks");
		expect(body).toContain("Report");
	});
});
