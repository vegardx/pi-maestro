// The compiled stage document pi-maestro derives for itself.
//
// Two documents have to agree about one specification: this compiler and
// `plan-to-ship`'s. Nothing can import the other, so what pins this side is
// (a) the closed TypeBox mirror of pi-workflow's own schema, which every
// compile is checked against, and (b) the spec's §2.1 example, written out
// below as the exact JSON it must produce. When the two sides disagree, one of
// these two is what fails first.

import { describe, expect, it } from "vitest";
import type { Plan } from "../packages/maestro/src/plan.js";
import {
	compileStageDocument,
	disambiguateLensIds,
	planWithStageDocument,
	renderStageDocument,
	StageDocumentError,
	validateStageDocument,
	verifyRoundsFor,
} from "../packages/maestro/src/stage-document.js";

/** The example from the spec's §2.1, verbatim. */
const EXAMPLE: Plan = {
	slug: "compose-catalogue",
	title: "Component catalogue",
	repos: [
		{ key: "wf", path: "/Users/vegardx/src/github.com/vegardx/pi-workflow" },
	],
	policy: {
		effort: "standard",
		gates: "approve-plan+ship",
		maxFixRounds: 1,
		publish: { mode: "pr", base: "main" },
	},
	deliverables: [
		{
			id: "catalogue",
			title: "Ship the component catalogue",
			after: [],
			reads: [],
			tasks: [
				{ id: "impl", title: "Write src/components/*.ts" },
				{
					id: "rev-contracts",
					title: "Contract review",
					review: { lens: "contracts", tier: "heavy", diverse: true },
				},
			],
			stages: [
				{ use: "implement", id: "build" },
				{
					use: "verify-and-fix",
					id: "green",
					maxRounds: 2,
					escalate: "thinking",
				},
				{
					use: "review-fan-out",
					id: "review",
					synthesis: "required",
					lenses: [
						{ id: "contracts", tier: "heavy", diverse: true },
						{ id: "replay", tier: "standard" },
					],
				},
			],
		},
	],
};

describe("compileStageDocument", () => {
	it("compiles the spec's example to exactly this document", () => {
		expect(compileStageDocument(EXAMPLE)).toEqual({
			deliverables: [
				{
					id: "catalogue",
					stages: [
						{ use: "implement", id: "build" },
						{
							use: "verify-and-fix",
							id: "green",
							// The plan counts FIX rounds and the component counts
							// VERIFY rounds: 2 fixes are 3 verifies.
							maxRounds: 3,
							escalate: "thinking",
						},
						{
							use: "review-fan-out",
							id: "review",
							lenses: [
								{ id: "contracts", tier: "heavy", diverse: true },
								{ id: "replay", tier: "standard" },
							],
							synthesis: "required",
						},
					],
				},
			],
			effort: "standard",
			gates: "approve-plan+ship",
		});
	});

	it("derives the default stage list from the policy for a deliverable with none", () => {
		const plan: Plan = {
			...EXAMPLE,
			policy: { effort: "deep", gates: "every-deliverable" },
			deliverables: [
				{
					id: "one",
					title: "One",
					after: [],
					reads: [],
					tasks: [
						{ id: "impl", title: "Do it" },
						{
							id: "rev",
							title: "Review it",
							review: { lens: "contracts" },
						},
					],
				},
			],
		};
		expect(compileStageDocument(plan)).toEqual({
			deliverables: [
				{
					id: "one",
					stages: [
						{ use: "implement", id: "implement" },
						// `deep` defaults to 2 fix rounds, so 3 verify rounds.
						{ use: "verify-and-fix", id: "verify", maxRounds: 3 },
						{
							use: "review-fan-out",
							id: "review",
							// Seeded from `tasks[].review`, tier and diverse from the
							// policy's own review default.
							lenses: [{ id: "contracts", tier: "standard", diverse: false }],
							synthesis: "optional",
						},
					],
				},
			],
			effort: "deep",
			gates: "every-deliverable",
		});
	});

	it("omits the review stage when nothing in the deliverable asked for one", () => {
		const plan: Plan = {
			...EXAMPLE,
			policy: { effort: "cheap" },
			deliverables: [
				{
					id: "one",
					title: "One",
					after: [],
					reads: [],
					tasks: [{ id: "impl", title: "Do it" }],
				},
			],
		};
		const document = compileStageDocument(plan);
		expect(document.deliverables[0]?.stages).toEqual([
			{ use: "implement", id: "implement" },
			{ use: "verify-and-fix", id: "verify", maxRounds: 1 },
		]);
		expect(document.gates).toBe("approve-plan+ship");
	});

	it("suffixes duplicate lens ids by declaration ordinal", () => {
		expect(
			disambiguateLensIds([
				{ id: "contracts", model: "a/one" },
				{ id: "replay" },
				{ id: "contracts", model: "b/two" },
				{ id: "contracts", model: "c/three" },
			]).map((lens) => lens.id),
		).toEqual(["contracts", "replay", "contracts-2", "contracts-3"]);
	});

	it("maps fix rounds to verify rounds", () => {
		expect([0, 1, 2].map(verifyRoundsFor)).toEqual([1, 2, 3]);
	});

	it("refuses a reserved stage kind rather than dropping it", () => {
		const plan: Plan = {
			...EXAMPLE,
			deliverables: [
				{
					...EXAMPLE.deliverables[0],
					stages: [
						{ use: "implement", id: "build" },
						{ use: "dynamic", id: "later", brief: "decide at run time" },
					],
				},
			],
		} as Plan;
		expect(() => compileStageDocument(plan)).toThrow(StageDocumentError);
		expect(() => compileStageDocument(plan)).toThrow(
			/dynamic.* are not compiled yet/,
		);
	});

	it("refuses a document the runtime's own schema would reject", () => {
		// A lens id the plan schema allows (it may start with a digit) and the
		// compiled schema does not. The drift fails here, not at the runtime.
		const plan: Plan = {
			...EXAMPLE,
			deliverables: [
				{
					...EXAMPLE.deliverables[0],
					stages: [
						{ use: "implement", id: "build" },
						{ use: "verify-and-fix", id: "green" },
						{ use: "review-fan-out", id: "review", lenses: [{ id: "2fa" }] },
					],
				},
			],
		} as Plan;
		expect(() => compileStageDocument(plan)).toThrow(StageDocumentError);
	});

	it("renders the graph a human is shown", () => {
		const rendered = renderStageDocument(compileStageDocument(EXAMPLE));
		expect(rendered).toContain("effort standard, gates approve-plan+ship");
		expect(rendered).toContain("verify-and-fix green — 3 verify rounds");
		expect(rendered).toContain("contracts/heavy/diverse");
	});
});

describe("validateStageDocument", () => {
	it("accepts what the compiler produces", () => {
		expect(validateStageDocument(compileStageDocument(EXAMPLE))).toEqual([]);
	});

	it("names every problem it finds", () => {
		const problems = validateStageDocument({
			deliverables: [{ id: "one", stages: [{ use: "nope", id: "x" }] }],
			effort: "standard",
			gates: "approve-plan+ship",
			extra: true,
		});
		expect(problems.length).toBeGreaterThan(0);
	});

	it("refuses a document with no deliverables at all", () => {
		expect(
			validateStageDocument({
				deliverables: [],
				effort: "cheap",
				gates: "approve-plan",
			}).length,
		).toBeGreaterThan(0);
	});
});

describe("planWithStageDocument", () => {
	it("writes an edited document back into the plan's stages", () => {
		const document = compileStageDocument(EXAMPLE);
		const edited = {
			...document,
			deliverables: [
				{
					id: "catalogue",
					stages: [
						{ use: "implement", id: "build" },
						{ use: "verify-and-fix", id: "green", maxRounds: 1 },
					],
				},
			],
		};
		const { plan, problems } = planWithStageDocument(EXAMPLE, edited);
		expect(problems).toEqual([]);
		expect(plan?.deliverables[0]?.stages).toEqual([
			{ use: "implement", id: "build" },
			// One verify round back to zero fix rounds.
			{ use: "verify-and-fix", id: "green", maxRounds: 0 },
		]);
		// And it round-trips.
		expect(plan && compileStageDocument(plan)).toEqual(edited);
	});

	it("refuses a document that names a deliverable the plan does not have", () => {
		const { plan, problems } = planWithStageDocument(EXAMPLE, {
			deliverables: [{ id: "other", stages: [] }],
			effort: "standard",
			gates: "approve-plan+ship",
		});
		expect(plan).toBeUndefined();
		expect(problems.join("\n")).toContain("`other` is not a deliverable");
	});

	it("refuses a verify stage that would never verify", () => {
		const { plan, problems } = planWithStageDocument(EXAMPLE, {
			deliverables: [
				{
					id: "catalogue",
					stages: [
						{ use: "implement", id: "build" },
						{ use: "verify-and-fix", id: "green", maxRounds: 0 },
					],
				},
			],
			effort: "standard",
			gates: "approve-plan+ship",
		});
		expect(plan).toBeUndefined();
		expect(problems.join("\n")).toContain("at least 1");
	});

	it("refuses an edit that is not a compiled document at all", () => {
		const { plan, problems } = planWithStageDocument(EXAMPLE, { nope: true });
		expect(plan).toBeUndefined();
		expect(problems.length).toBeGreaterThan(0);
	});
});
