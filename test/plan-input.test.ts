// The hand-off to a workflow run: the plan by value, and a digest of it.
//
// What the digest has to survive is a round trip through a serializer that
// does not promise key order — the store writes JSON, something reads it back,
// and the object that comes out is the same plan with its keys in whatever
// order the parser produced. A digest that changed there would make an
// approval look stale for no reason anybody could see.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATES, type Plan } from "../packages/maestro/src/plan.js";
import {
	canonicalJson,
	planDigest,
	toWorkflowInput,
} from "../packages/maestro/src/plan-input.js";

const fixture: Plan = {
	slug: "arc",
	title: "Arc",
	repos: [{ key: "main", path: "/repo" }],
	deliverables: [
		{
			id: "api",
			title: "The API",
			body: "What it is for.",
			after: [],
			reads: [],
			repo: "main",
			tasks: [
				{ id: "build", title: "Build it" },
				{ id: "test", title: "Test it" },
			],
			reviews: [{ lens: "security", tier: "heavy", diverse: true }],
		},
		{
			id: "ui",
			title: "The UI",
			after: ["api"],
			// Ordering only: a deliverable that READS another's hand-off in the same
			// repository is refused by the plan model, so it cannot be a fixture.
			reads: [],
			tasks: [{ id: "build", title: "Build it" }],
		},
	],
};

/** The same plan, written with every object's keys in a different order. */
const shuffled = JSON.parse(
	JSON.stringify(fixture, (_key, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).reverse())
			: value,
	),
) as Plan;

describe("canonical JSON", () => {
	it("sorts keys at every depth and writes no whitespace", () => {
		expect(
			canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } }),
		).toBe('{"a":{"c":null,"d":[1,{"e":3,"f":2}]},"b":1}');
	});

	it("drops an absent optional, so `undefined` and missing are one plan", () => {
		expect(canonicalJson({ lens: "security", model: undefined })).toBe(
			'{"lens":"security"}',
		);
	});

	it("keeps array order, because position is meaning in a graph", () => {
		expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
		expect(canonicalJson(["b", "a"])).not.toBe(canonicalJson(["a", "b"]));
	});
});

describe("the digest names the bytes that were approved", () => {
	it("is stable under key order", () => {
		expect(Object.keys(shuffled)).not.toEqual(Object.keys(fixture));
		expect(planDigest(shuffled)).toBe(planDigest(fixture));
	});

	it("is the sha256 of the canonical JSON, and nothing else", () => {
		expect(planDigest(fixture)).toBe(
			createHash("sha256").update(canonicalJson(fixture), "utf8").digest("hex"),
		);
		expect(planDigest(fixture)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("changes when anything in the plan changes", () => {
		const moved: Plan = {
			...fixture,
			deliverables: [...fixture.deliverables].reverse(),
		};
		expect(planDigest(moved)).not.toBe(planDigest(fixture));
		expect(planDigest({ ...fixture, title: "Arc " })).not.toBe(
			planDigest(fixture),
		);
	});
});

describe("the workflow input", () => {
	it("carries the plan by value and its digest, and nothing else", () => {
		const input = toWorkflowInput(fixture);
		expect(input.plan).toBe(fixture);
		expect(input.planDigest).toBe(planDigest(fixture));
		// v8: there is no field on this input the digest does not cover. `effort`
		// was the one that was not, and it is gone.
		expect(Object.keys(input).sort()).toEqual(["plan", "planDigest"]);
	});

	it("round-trips a fixture plan through canonical JSON unchanged", () => {
		// The run receives JSON, not this object. If canonicalisation lost or
		// reordered anything that matters, the approved plan and the authored
		// plan would be different documents.
		const input = toWorkflowInput(fixture);
		expect(JSON.parse(canonicalJson(input.plan))).toEqual(fixture);
		expect(JSON.parse(canonicalJson(input))).toEqual({
			plan: fixture,
			planDigest: planDigest(fixture),
		});
	});

	// v7: the gates travel inside the plan, so what the run is gated by is what
	// the exit attached. An approve gate would be refused by pi-workflow's compile
	// by name, so it must never be in these bytes at all.
	it("sends the gates the exit attached, and no approve gate", () => {
		const planned: Plan = { ...fixture, policy: { gates: DEFAULT_GATES } };
		const input = toWorkflowInput(planned);
		expect(input.plan.policy?.gates).toBe("ship");
		expect(canonicalJson(input)).toContain('"gates":"ship"');
		expect(canonicalJson(input)).not.toContain("approve-plan");
	});

	// v8: `auto` writes `none`, and the run reads it off the document the digest
	// covers rather than off anything beside it.
	it("sends `none` for a plan the auto hand-off gated", () => {
		const planned: Plan = { ...fixture, policy: { gates: "none" } };
		const input = toWorkflowInput(planned);
		expect(canonicalJson(input)).toContain('"gates":"none"');
	});

	// The whole reason the field went: a dial beside the document was a dial the
	// digest did not cover, so a run and the bytes somebody approved could differ
	// in it and no receipt would show the difference. Nothing beside the plan
	// survives, whatever a document from another build happens to carry inside it.
	it("puts nothing beside the plan, whatever a stored plan carries", () => {
		const legacy = {
			...fixture,
			policy: { gates: DEFAULT_GATES, effort: "deep" },
		} as unknown as Plan;
		const input = toWorkflowInput(legacy);
		expect(Object.keys(input).sort()).toEqual(["plan", "planDigest"]);
		// And the digest still covers every byte of it, stray field and all.
		expect(input.planDigest).toBe(planDigest(legacy));
	});
});
