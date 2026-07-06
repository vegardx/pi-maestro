import { describe, expect, it } from "vitest";
import type { WorkGroup } from "../packages/modes/src/schema.js";
import { buildPrBody, shouldShip } from "../packages/modes/src/shipping.js";

function makeGroup(overrides: Partial<WorkGroup> = {}): WorkGroup {
	return {
		id: "test-group" as never,
		title: "Test Group",
		body: "Group description",
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
	it("returns true for complete terminal group", () => {
		expect(shouldShip(makeGroup(), false)).toBe(true);
	});

	it("returns false for complete non-terminal group", () => {
		expect(shouldShip(makeGroup(), true)).toBe(false);
	});

	it("returns false for non-complete group", () => {
		expect(shouldShip(makeGroup({ status: "active" }), false)).toBe(false);
	});

	it("returns false for already-shipped group", () => {
		expect(shouldShip(makeGroup({ status: "shipped" }), false)).toBe(false);
	});
});

describe("buildPrBody", () => {
	it("includes group body", () => {
		const body = buildPrBody(makeGroup(), []);
		expect(body).toContain("Group description");
	});

	it("renders task checklist", () => {
		const body = buildPrBody(makeGroup(), []);
		expect(body).toContain("- [x] Task one");
		expect(body).toContain("- [x] Task two");
	});

	it("includes agent reports", () => {
		const body = buildPrBody(makeGroup(), [
			"### Worker\nDid stuff.",
			"### Review\nLooks good.",
		]);
		expect(body).toContain("### Worker");
		expect(body).toContain("Did stuff.");
		expect(body).toContain("### Review");
		expect(body).toContain("Looks good.");
	});

	it("omits sections when empty", () => {
		const body = buildPrBody(makeGroup({ body: "", tasks: [] }), []);
		expect(body).toBe("");
	});

	it("omits tasks section for groups with no tasks", () => {
		const body = buildPrBody(makeGroup({ tasks: [] }), ["Report"]);
		expect(body).not.toContain("## Tasks");
		expect(body).toContain("Report");
	});
});
