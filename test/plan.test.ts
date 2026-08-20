// The plan model: what was authored, validated on its own terms.
//
// The rules here are the ones the old model could not state. `after` being
// sibling-scoped meant a deliverable could not depend on anything outside its
// parent's children, which made research-before-work and review-after-a-diff
// structurally impossible. And because authored intent shared an object with
// run state, "is this plan valid" was never answerable from the plan alone.

import { describe, expect, it } from "vitest";
import {
	type Deliverable,
	type Plan,
	type Task,
	validatePlan,
} from "../packages/maestro/src/plan.js";

const task = (id: string, by?: Task["by"]): Task => ({
	id,
	title: `do ${id}`,
	...(by ? { by } : {}),
});

const deliverable = (
	id: string,
	over: Partial<Deliverable> = {},
): Deliverable => ({
	id,
	title: `Deliverable ${id}`,
	after: [],
	reads: [],
	tasks: [task(`${id}-1`)],
	...over,
});

const plan = (over: Partial<Plan> = {}): Plan => ({
	slug: "arc",
	title: "Arc",
	deliverables: [],
	repos: [{ key: "main", path: "/repo" }],
	...over,
});

describe("a deliverable is work, or it is nothing", () => {
	it("rejects one with no tasks", () => {
		// Legal in the old model: a support node with zero tasks rendered an
		// empty "## Focus" to a live agent that then had nothing to do.
		const errors = validatePlan(
			plan({ deliverables: [deliverable("a", { tasks: [] })] }),
		);
		expect(errors).toContainEqual(expect.stringContaining("no tasks"));
	});

	it("accepts the minimum: an id, a title, and one task", () => {
		expect(validatePlan(plan({ deliverables: [deliverable("a")] }))).toEqual(
			[],
		);
	});
});

describe("waiting and reading are different things", () => {
	it("accepts waiting without reading — ordering alone is legitimate", () => {
		// "the repo must exist first" is pure ordering. It should not drag the
		// predecessor's whole hand-off into this deliverable's context.
		const errors = validatePlan(
			plan({
				deliverables: [
					deliverable("setup"),
					deliverable("build", { after: ["setup"], reads: [] }),
				],
			}),
		);
		expect(errors).toEqual([]);
	});

	it("refuses reading from work it does not wait for", () => {
		const errors = validatePlan(
			plan({
				deliverables: [
					deliverable("api"),
					deliverable("ui", { after: [], reads: ["api"] }),
				],
			}),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("without waiting for it"),
		);
	});

	it("names an edge that resolves to nothing", () => {
		const errors = validatePlan(
			plan({ deliverables: [deliverable("a", { after: ["ghost"] })] }),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("no such deliverable"),
		);
	});

	it("catches a deliverable waiting for itself", () => {
		const errors = validatePlan(
			plan({ deliverables: [deliverable("a", { after: ["a"] })] }),
		);
		expect(errors).toContainEqual(expect.stringContaining("waits for itself"));
	});

	it("reports a cycle once, however it is entered", () => {
		const errors = validatePlan(
			plan({
				deliverables: [
					deliverable("a", { after: ["c"] }),
					deliverable("b", { after: ["a"] }),
					deliverable("c", { after: ["b"] }),
				],
			}),
		);
		const cycles = errors.filter((e) => e.startsWith("cycle:"));
		expect(cycles).toHaveLength(1);
	});
});

describe("delegated tasks are workflow-native review launches", () => {
	it("accepts the same lens assigned to more than one model", () => {
		const errors = validatePlan(
			plan({
				deliverables: [
					deliverable("a", {
						tasks: [
							task("implement"),
							task("review", {
								lens: "security",
								skill: "security-review",
								model: "anthropic/opus-5",
							}),
							task("review-again", {
								lens: "security",
								model: "xai/grok-4.5",
							}),
						],
					}),
				],
			}),
		);
		expect(errors).toEqual([]);
	});
});

describe("everything wrong is reported, not just the first thing", () => {
	it("collects unrelated errors in one pass", () => {
		const errors = validatePlan(
			plan({
				deliverables: [
					deliverable("a", { tasks: [], repo: "nope" }),
					deliverable("a", { after: ["ghost"] }),
				],
			}),
		);
		expect(errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("duplicate id"),
				expect.stringContaining("no tasks"),
				expect.stringContaining("unknown repo"),
				expect.stringContaining("no such deliverable"),
			]),
		);
	});
});
