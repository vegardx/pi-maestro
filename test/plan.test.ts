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
	readyDeliverables,
	strandedByFailure,
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
	preflight: [],
	deliverables: [],
	postflight: [],
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

describe("writers are authored, never spawned", () => {
	it("refuses a task delegating to a worker", () => {
		const errors = validatePlan(
			plan({
				deliverables: [
					deliverable("a", {
						tasks: [
							task("t", {
								agent: "worker" as never,
								persona: "coder",
							}),
						],
					}),
				],
			}),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("a writer is authored as a deliverable"),
		);
	});

	it("accepts the read-only kinds, including a fan-out", () => {
		const errors = validatePlan(
			plan({
				deliverables: [
					deliverable("a", {
						tasks: [
							task("survey", {
								agent: "explorer",
								persona: "codebase-research",
							}),
							task("implement"),
							task("review", {
								agent: "reviewer",
								persona: "security-review",
								fanOut: true,
							}),
							task("act-on-findings"),
						],
					}),
				],
			}),
		);
		// Research BEFORE the work and review AFTER a diff exists, in one list.
		// Both were structurally impossible when support agents were children.
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

	it("checks plan-level preflight and postflight too", () => {
		const errors = validatePlan(
			plan({
				preflight: [task("p"), task("p")],
				postflight: [{ id: "q", title: "" }],
			}),
		);
		expect(errors).toContainEqual(expect.stringContaining("duplicate task id"));
		expect(errors).toContainEqual(
			expect.stringContaining("postflight.tasks[0]"),
		);
	});
});

describe("readiness is the whole scheduling rule", () => {
	const p = plan({
		deliverables: [
			deliverable("stats"),
			deliverable("validate"),
			deliverable("advanced", {
				after: ["stats", "validate"],
				reads: ["stats"],
			}),
		],
	});

	it("starts everything with nothing to wait for", () => {
		expect(readyDeliverables(p, new Set(), new Set()).map((d) => d.id)).toEqual(
			["stats", "validate"],
		);
	});

	it("holds a deliverable until every predecessor is terminal", () => {
		expect(
			readyDeliverables(p, new Set(["stats"]), new Set(["stats"])).map(
				(d) => d.id,
			),
		).toEqual(["validate"]);
	});

	it("releases it once they are", () => {
		const done = new Set(["stats", "validate"]);
		expect(readyDeliverables(p, done, done).map((d) => d.id)).toEqual([
			"advanced",
		]);
	});

	it("never re-offers work already started", () => {
		expect(
			readyDeliverables(p, new Set(), new Set(["stats"])).map((d) => d.id),
		).toEqual(["validate"]);
	});

	it("does NOT release a dependent when a predecessor failed", () => {
		// Succeeded, not merely terminal. Running `advanced` on a `validate` that
		// never produced anything yields a confident wrong answer — worse than
		// not running it.
		const succeeded = new Set(["stats"]);
		const started = new Set(["stats", "validate"]);
		expect(readyDeliverables(p, succeeded, started)).toEqual([]);
	});
});

describe("a failure stops its dependents and nothing else", () => {
	const p = plan({
		deliverables: [
			deliverable("api"),
			deliverable("ui", { after: ["api"], reads: ["api"] }),
			deliverable("docs", { after: ["ui"] }),
			deliverable("unrelated"),
		],
	});

	it("strands the whole chain below the failure, with its cause", () => {
		const stranded = strandedByFailure(p, new Set(["api"]));
		expect([...stranded.keys()].sort()).toEqual(["docs", "ui"]);
		expect(stranded.get("ui")).toBe("api");
		// `docs` never named `api` — it is stranded through `ui`, and the report
		// should say which link actually broke.
		expect(stranded.get("docs")).toBe("ui");
	});

	it("leaves independent work alone — that is the whole point", () => {
		const stranded = strandedByFailure(p, new Set(["api"]));
		expect(stranded.has("unrelated")).toBe(false);
		expect(
			readyDeliverables(p, new Set(), new Set(["api"])).map((d) => d.id),
		).toEqual(["unrelated"]);
	});

	it("strands nothing when nothing failed", () => {
		expect(strandedByFailure(p, new Set()).size).toBe(0);
	});
});
