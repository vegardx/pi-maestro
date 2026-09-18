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
				{ id: "tests", title: "Cover each component" },
			],
			reviews: [
				{ lens: "contracts", tier: "heavy", diverse: true },
				{ lens: "replay", tier: "standard" },
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
						{ use: "implement", id: "implement" },
						{
							use: "verify-and-fix",
							id: "verify",
							// The plan counts FIX rounds and the component counts
							// VERIFY rounds: 1 fix is 2 verifies.
							maxRounds: 2,
						},
						{
							use: "review-fan-out",
							id: "review",
							lenses: [
								{ id: "contracts", tier: "heavy", diverse: true },
								// What the review left open comes from the policy's
								// own review default.
								{ id: "replay", tier: "standard", diverse: false },
							],
							synthesis: "optional",
						},
					],
				},
			],
			effort: "standard",
			gates: "approve-plan+ship",
		});
	});

	it("derives the stage list from the policy and the reviews", () => {
		const plan: Plan = {
			...EXAMPLE,
			policy: { effort: "deep", gates: "every-deliverable" },
			deliverables: [
				{
					id: "one",
					title: "One",
					after: [],
					reads: [],
					tasks: [{ id: "impl", title: "Do it" }],
					reviews: [{ lens: "contracts" }],
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
							// Seeded from `deliverables[].reviews`, tier and diverse
							// from the policy's own review default.
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

	it("refuses a document the runtime's own schema would reject", () => {
		// A lens id the plan schema allows (it may start with a digit) and the
		// compiled schema does not. The drift fails here, not at the runtime.
		const plan: Plan = {
			...EXAMPLE,
			deliverables: [
				{ ...EXAMPLE.deliverables[0], reviews: [{ lens: "2fa" }] },
			],
		} as Plan;
		expect(() => compileStageDocument(plan)).toThrow(StageDocumentError);
	});

	it("renders the graph a human is shown", () => {
		const rendered = renderStageDocument(compileStageDocument(EXAMPLE));
		expect(rendered).toContain("effort standard, gates approve-plan+ship");
		expect(rendered).toContain("verify-and-fix verify — 2 verify rounds");
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
	// What the editor behind the compiled-document dialog is for: changing who
	// reviews what. Version 5 removed authored `stages`, so a review lens is the
	// one thing in the compiled graph that a plan can still hold.
	it("writes edited lenses back into the plan's reviews", () => {
		const document = compileStageDocument(EXAMPLE);
		const edited = {
			...document,
			deliverables: [
				{
					id: "catalogue",
					stages: [
						{ use: "implement", id: "implement" },
						{ use: "verify-and-fix", id: "verify", maxRounds: 2 },
						{
							use: "review-fan-out",
							id: "review",
							// As the person sees it in the editor: the compiled document
							// they were shown carries `diverse` on every lens.
							lenses: [{ id: "security", tier: "light", diverse: false }],
							synthesis: "optional",
						},
					],
				},
			],
		};
		const { plan, problems } = planWithStageDocument(EXAMPLE, edited);
		expect(problems).toEqual([]);
		expect(plan?.deliverables[0]?.reviews).toEqual([
			{ lens: "security", tier: "light", diverse: false },
		]);
		// And it round-trips: the document the edit asked for is the document
		// the plan now compiles to.
		expect(plan && compileStageDocument(plan)).toEqual(edited);
	});

	it("reads an edit that removed the fan-out as a deliverable nobody reads", () => {
		const { plan, problems } = planWithStageDocument(EXAMPLE, {
			...compileStageDocument(EXAMPLE),
			deliverables: [
				{
					id: "catalogue",
					stages: [
						{ use: "implement", id: "implement" },
						{ use: "verify-and-fix", id: "verify", maxRounds: 2 },
					],
				},
			],
		});
		expect(problems).toEqual([]);
		expect(plan?.deliverables[0]?.reviews).toEqual([]);
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

	// The honest half of the write-back: an edit the plan cannot hold is named,
	// never accepted and then recompiled away behind the person who made it.
	it("refuses an edit the document has nowhere to put", () => {
		const { plan, problems } = planWithStageDocument(EXAMPLE, {
			...compileStageDocument(EXAMPLE),
			deliverables: [
				{
					id: "catalogue",
					stages: [
						{ use: "implement", id: "implement" },
						{ use: "gate", id: "ok", question: "Ship it?" },
					],
				},
			],
		});
		expect(plan).toBeUndefined();
		expect(problems.join("\n")).toContain("cannot hold a `gate` stage");
		expect(problems.join("\n")).toContain("`policy.gates`");
	});

	it("refuses an edit that reviews one deliverable twice", () => {
		const fanOut = {
			use: "review-fan-out",
			id: "review",
			lenses: [{ id: "contracts" }],
		};
		const { plan, problems } = planWithStageDocument(EXAMPLE, {
			...compileStageDocument(EXAMPLE),
			deliverables: [
				{
					id: "catalogue",
					stages: [
						{ use: "implement", id: "implement" },
						fanOut,
						{ ...fanOut, id: "review-again" },
					],
				},
			],
		});
		expect(plan).toBeUndefined();
		expect(problems.join("\n")).toContain(
			"a deliverable lists its reviews once",
		);
	});

	it("refuses an edit that is not a compiled document at all", () => {
		const { plan, problems } = planWithStageDocument(EXAMPLE, { nope: true });
		expect(plan).toBeUndefined();
		expect(problems.length).toBeGreaterThan(0);
	});
});
