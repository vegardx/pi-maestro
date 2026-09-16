// The hand-off to a workflow run: the plan by value, and a digest of it.
//
// What the digest has to survive is a round trip through a serializer that
// does not promise key order — the store writes JSON, something reads it back,
// and the object that comes out is the same plan with its keys in whatever
// order the parser produced. A digest that changed there would make an
// approval look stale for no reason anybody could see.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Plan } from "../packages/maestro/src/plan.js";
import {
	canonicalJson,
	DEFAULT_EFFORT,
	planDigest,
	toWorkflowInput,
	UnknownEffortError,
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
				{
					id: "review",
					title: "Review it",
					by: { lens: "security", tier: "heavy", diverse: true },
				},
			],
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
	it("carries the plan by value, its digest, and the effort", () => {
		const input = toWorkflowInput(fixture, "deep");
		expect(input.plan).toBe(fixture);
		expect(input.planDigest).toBe(planDigest(fixture));
		expect(input.effort).toBe("deep");
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
			effort: DEFAULT_EFFORT,
		});
	});

	it("defaults to standard when the author said nothing", () => {
		expect(toWorkflowInput(fixture).effort).toBe("standard");
		expect(toWorkflowInput(fixture, undefined).effort).toBe("standard");
	});

	it("takes the plan's own policy effort when the caller names none", () => {
		// `policy.effort` is on the document because a human chose it and the
		// digest covers it. A hand-off that overrode it with a default would be
		// spending a budget nobody chose.
		const deep: Plan = { ...fixture, policy: { effort: "deep" } };
		expect(toWorkflowInput(deep).effort).toBe("deep");
		expect(toWorkflowInput(deep, undefined).effort).toBe("deep");
		// A caller that does name one still wins: `/plan run <slug> cheap` is a
		// human saying something about this run.
		expect(toWorkflowInput(deep, "cheap").effort).toBe("cheap");
	});

	it("resolves a stored effort it does not know the way the policy does", () => {
		// `resolvePolicy` is total and `inspectPlan` is what reports this, so a
		// document with an effort from another build still hands off — at the
		// default, exactly as it would compile.
		const odd = {
			...fixture,
			policy: { effort: "thorough" },
		} as unknown as Plan;
		expect(toWorkflowInput(odd).effort).toBe("standard");
		// A caller's own typo is still worth throwing over.
		expect(() => toWorkflowInput(odd, "thorough")).toThrow(UnknownEffortError);
	});

	it("refuses an effort it does not know, rather than guessing one", () => {
		// "standrd" is one keystroke away, and a typo that silently became
		// `standard` would spend a deep run's budget, or fail to.
		expect(() => toWorkflowInput(fixture, "standrd")).toThrow(
			UnknownEffortError,
		);
		expect(() => toWorkflowInput(fixture, "")).toThrow(/one of cheap/);
		expect(() => toWorkflowInput(fixture, 3)).toThrow(UnknownEffortError);
	});
});
