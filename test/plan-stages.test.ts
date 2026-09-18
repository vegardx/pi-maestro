// Stages and policy: how a deliverable is compiled, and the dials it sets.
//
// NEITHER IS AUTHORED, and that is the property most of this file is about.
// Version 5 removed `deliverables[].stages` from the document and removed
// `policy` from the `plan` tool: a deliverable's stage list is derived from its
// tasks, its `reviews` and the dials the seat attaches, so there is exactly one
// lowering and a person approving a plan is approving the run it describes.
//
// The refusals are the other half. A review with no lens, a lens id the
// compiled document could not carry, a pinned model this host does not have, a
// fix loop with no bound, a `reads` edge the runtime cannot honour: each is
// refused by name, because the alternative is a plan that a human approves and
// a run then quietly does not do.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanTool } from "../packages/maestro/src/authoring.js";
import {
	DEFAULT_FIX_ROUNDS,
	type Deliverable,
	defaultStagesFor,
	type Plan,
	type PlanHostPort,
	type PlanPolicy,
	type RepoProbe,
	type Review,
	resolvePolicy,
	type Task,
	validatePlan,
	withDefaultStages,
	withExplicitDiverse,
} from "../packages/maestro/src/plan.js";
import { renderPlan } from "../packages/maestro/src/plan-command.js";
import { planDigest } from "../packages/maestro/src/plan-input.js";
import {
	compileStageDocument,
	validateStageDocument,
} from "../packages/maestro/src/stage-document.js";
import { createPlanStore } from "../packages/maestro/src/store.js";
import { fakeHost } from "./fake-host.js";

const cleanRepo: RepoProbe = (path) => ({
	root: path,
	resolved: path,
	dirty: false,
});

const errorsOf = (subject: Plan, host?: PlanHostPort): string[] =>
	validatePlan(subject, cleanRepo, host);

/** The host the review-routing tests are written against. */
const host = fakeHost({
	models: ["anthropic/opus-5"],
	skills: ["contracts-review"],
});

const task = (id: string): Task => ({ id, title: `do ${id}` });

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
	deliverables: [deliverable("api")],
	repos: [{ key: "main", path: "/repo" }],
	...over,
});

/** A plan whose one deliverable is read by exactly these reviewers. */
const reviewed = (reviews: readonly Review[], over: Partial<Plan> = {}): Plan =>
	plan({ deliverables: [deliverable("api", { reviews })], ...over });

describe("a deliverable is lowered into stages, always the same way", () => {
	it("implements, verifies, and fans out over the reviews it lists", () => {
		const d = deliverable("api", {
			tasks: [task("build"), task("tests"), task("docs")],
			reviews: [
				{ lens: "security", tier: "heavy", diverse: true },
				{ lens: "contracts" },
			],
		});
		const stages = withDefaultStages(plan({ deliverables: [d] }))
			.deliverables[0].stages;

		expect(stages).toEqual([
			{ use: "implement", id: "implement" },
			{ use: "verify-and-fix", id: "verify", maxRounds: 1 },
			{
				use: "review-fan-out",
				id: "review",
				synthesis: "optional",
				lenses: [
					// What the review pinned wins; what it left open comes from the
					// policy, which is what `reviewDefault` is for.
					{ id: "security", tier: "heavy", diverse: true },
					{ id: "contracts", tier: "standard", diverse: false },
				],
			},
		]);
	});

	it("declares no review stage when the deliverable lists none", () => {
		// A fan-out over zero lenses is not a cheaper review; it is a stage that
		// cannot be compiled at all. Absent and empty answer alike, because the
		// document says "nobody reads this" either way.
		for (const reviews of [undefined, []])
			expect(
				defaultStagesFor(
					deliverable("api", reviews ? { reviews } : {}),
					resolvePolicy(),
				).map((s) => s.use),
			).toEqual(["implement", "verify-and-fix"]);
	});

	it("takes the fix-round count from the effort the policy set", () => {
		for (const effort of ["cheap", "standard", "deep"] as const) {
			const stages = defaultStagesFor(
				deliverable("api"),
				resolvePolicy({ effort }),
			);
			expect(stages[1]).toEqual({
				use: "verify-and-fix",
				id: "verify",
				maxRounds: DEFAULT_FIX_ROUNDS[effort],
			});
		}
		// And an explicit count beats the effort table.
		expect(
			defaultStagesFor(
				deliverable("api"),
				resolvePolicy({ effort: "cheap", maxFixRounds: 2 }),
			)[1],
		).toEqual({ use: "verify-and-fix", id: "verify", maxRounds: 2 });
	});

	it("produces a stage list the runtime's own schema accepts", () => {
		// The rule that used to be "authored stages obey the same rules as
		// derived ones" has one side left, and it is the side that matters: a
		// plan this validator accepts must lower to a document the runtime would
		// take. There is no author left to disagree with the derivation.
		const authored = plan({
			deliverables: [deliverable("api", { reviews: [{ lens: "security" }] })],
		});
		expect(errorsOf(authored)).toEqual([]);
		expect(validateStageDocument(compileStageDocument(authored))).toEqual([]);
	});

	it("resolves every dial, and keeps a value it does not know out of the way", () => {
		expect(resolvePolicy()).toEqual({
			effort: "standard",
			gates: "approve-plan+ship",
			reviewDefault: { tier: "standard", diverse: false },
			maxFixRounds: 1,
			publish: { mode: "none" },
		});
		// Total on purpose: `inspectPlan` reports the unknown value, and a
		// renderer must not throw on a document the report is about to explain.
		expect(
			resolvePolicy({ effort: "quick" } as unknown as PlanPolicy).effort,
		).toBe("standard");
	});

	it("is pure: deriving the stages changes neither the plan nor its digest", () => {
		const before = plan();
		const digest = planDigest(before);
		const after = withDefaultStages(before);
		expect(
			(before.deliverables[0] as { stages?: unknown }).stages,
		).toBeUndefined();
		expect(planDigest(before)).toBe(digest);
		expect(after.deliverables[0].stages).toHaveLength(2);
	});
});

describe("what a `reviews` list may not say", () => {
	it("refuses a review with no lens, and says what a task is for", () => {
		// The shape four by-hand passes produced: `review: { lens: "" }` on work
		// that was never a review. The refusal has to name the way out, because
		// the model that wrote it sent the same document four times over.
		for (const lens of ["", "   ", undefined as unknown as string]) {
			const errors = errorsOf(reviewed([{ lens }]));
			expect(errors).toEqual([
				"api.reviews[0]: a review needs a lens; a task that is not a review " +
					"is simply a task, and belongs in `tasks` with no review entry",
			]);
		}
	});

	it("refuses more reviews than a fan-out can carry", () => {
		expect(
			errorsOf(
				reviewed(Array.from({ length: 17 }, (_, i) => ({ lens: `lens-${i}` }))),
			),
		).toContainEqual(expect.stringContaining("17 reviews"));
		expect(
			errorsOf(
				reviewed(Array.from({ length: 16 }, (_, i) => ({ lens: `lens-${i}` }))),
			),
		).toEqual([]);
	});

	it("refuses a lens id the compiled document could not carry", () => {
		// A lens id is a fan-out key and reaches `@vegardx/pi-workflow` inside the
		// compiled stage document, whose schema accepts `^[a-z][a-z0-9-]*$`. A
		// deliverable id may start with a digit; a lens id may not, or the plan
		// validates here and compiles nowhere. Every one is reported at once.
		const errors = errorsOf(
			reviewed([{ lens: "2fa" }, { lens: "-leading" }, { lens: "contracts" }]),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("`2fa` is not a safe review lens"),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("`-leading` is not a safe review lens"),
		);
		// The message carries the pattern itself, so an author who wrote a
		// mis-shaped id learns the rule rather than only that it broke one.
		expect(errors.join("\n")).toContain("^[a-z][a-z0-9-]{0,63}$");
		expect(errors).toHaveLength(2);
		expect(errorsOf(reviewed([{ lens: "a2" }]))).toEqual([]);
	});

	it("refuses routing that is not in the vocabulary", () => {
		const errors = errorsOf(
			reviewed([
				{ lens: "replay", model: "fable" },
				{ lens: "contracts", tier: "exhaustive" as "heavy" },
			]),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("must be a concrete provider/model ID"),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("`exhaustive` is not a review tier"),
		);
	});

	// The two questions only the session can answer, asked where the routing is
	// written. @see PlanHostPort
	it("holds `model` and `skill` to the host", () => {
		const errors = errorsOf(
			reviewed([
				{ lens: "contracts", model: "anthropic/opus-9" },
				{ lens: "replay", skill: "replay-review" },
				{ lens: "sound", model: "anthropic/opus-5", skill: "contracts-review" },
			]),
			host,
		);
		expect(errors).toEqual([
			"api.reviews[0]: `anthropic/opus-9` is not a model this host " +
				"has — this host's registered providers are `anthropic`. `model` is " +
				"optional: drop it and pin `tier` instead unless the reviewer must be " +
				"one exact model",
			"api.reviews[1]: `replay-review` is not a skill this session " +
				"has loaded — the skills loaded here are `contracts-review`. `skill` " +
				"is optional: drop it and let the lens prompt find what it needs",
		]);
	});

	// FAIL CLOSED: a pin nothing could check is refused, never stored unchecked.
	it("refuses a review that pins anything when there is no host", () => {
		expect(
			errorsOf(reviewed([{ lens: "contracts", model: "anthropic/opus-5" }])),
		).toEqual([
			"api.reviews[0]: `model` pins `anthropic/opus-5` and there is " +
				"no model catalogue here to check it against, so it is refused rather " +
				"than stored unchecked — drop `model` and pin `tier` instead",
		]);
	});

	it("reports every wrong review at once", () => {
		// The whole list is walked even after a bad entry: an author fixing one
		// review per round trip is an author who starts guessing.
		const errors = errorsOf(
			reviewed([{ lens: "" }, { lens: "2fa" }, { lens: "x", model: "fable" }]),
		);
		expect(errors.length).toBeGreaterThanOrEqual(3);
	});
});

describe("what version 5 moved, refused by name", () => {
	it("refuses a review written onto a task", () => {
		const errors = errorsOf(
			plan({
				deliverables: [
					deliverable("api", {
						tasks: [
							{
								...task("build"),
								review: { lens: "security" },
							} as unknown as Task,
						],
					}),
				],
			}),
		);
		expect(errors).toEqual([
			"api.tasks[0]: task `build` carries `review`, which plan schema v5 " +
				"moved to `deliverables[].reviews`: a task is work, and a deliverable " +
				"lists who reads that work once, beside its tasks. There is no " +
				"migration",
		]);
	});

	it("refuses the version 3 name too, so a model writing from memory hears it", () => {
		const errors = errorsOf(
			plan({
				deliverables: [
					deliverable("api", {
						tasks: [
							{ ...task("build"), by: { lens: "security" } } as unknown as Task,
						],
					}),
				],
			}),
		);
		expect(errors).toEqual([
			"api.tasks[0]: task `build` carries `by`, which plan schema v5 moved to " +
				"`deliverables[].reviews`: `by` was a version 3 field, version 4 " +
				"renamed it `review`, and version 5 took reviews off the task " +
				"altogether. There is no migration",
		]);
	});

	it("refuses an authored stage list", () => {
		const errors = errorsOf(
			plan({
				deliverables: [
					{
						...deliverable("api"),
						stages: [{ use: "implement", id: "build" }],
					} as unknown as Deliverable,
				],
			}),
		);
		expect(errors).toEqual([
			"api: carries `stages`, which plan schema v5 removed: a deliverable's " +
				"run is derived from its tasks, its `reviews` and the policy the seat " +
				"attaches, so there is nothing here for an author to write. Drop " +
				"`stages`",
		]);
	});
});

describe("what a policy may not say", () => {
	const policied = (policy: PlanPolicy): string[] => errorsOf(plan({ policy }));

	it("takes only the vocabulary that has meaning", () => {
		expect(policied({ effort: "quick" as "cheap" })).toContainEqual(
			expect.stringContaining("`quick` is not an effort"),
		);
		expect(policied({ gates: "none" as "approve-plan" })).toContainEqual(
			expect.stringContaining("is not a gate policy"),
		);
		expect(policied({ maxFixRounds: 3 as 2 })).toContainEqual(
			expect.stringContaining("`maxFixRounds` is 0, 1, 2"),
		);
		expect(
			policied({ reviewDefault: { tier: "exhaustive" as "heavy" } }),
		).toContainEqual(expect.stringContaining("is not a review tier"));
		expect(policied({ publish: { mode: "merge" as "pr" } })).toContainEqual(
			expect.stringContaining("is not a publication mode"),
		);
	});

	it("refuses a base branch Git could not check out", () => {
		expect(
			policied({ publish: { mode: "pr", base: "my branch" } }),
		).toContainEqual(expect.stringContaining("is not a valid branch name"));
		expect(policied({ publish: { mode: "pr", base: "a..b" } })).toContainEqual(
			expect.stringContaining("is not a valid branch name"),
		);
		// `mode: "pr"` needs `gh`, which is a fact about the host at readiness
		// time, not about the document.
		expect(policied({ publish: { mode: "pr", base: "main" } })).toEqual([]);
	});

	it("accepts a plan the seat gave every dial", () => {
		expect(
			policied({
				effort: "deep",
				gates: "every-deliverable",
				reviewDefault: { tier: "heavy", diverse: true },
				maxFixRounds: 2,
				publish: { mode: "branch", base: "main" },
			}),
		).toEqual([]);
	});
});

describe("a `reads` edge the runtime cannot honour", () => {
	it("is refused by name rather than compiled and dropped", () => {
		const errors = errorsOf(
			plan({
				deliverables: [
					deliverable("api"),
					deliverable("ui", { after: ["api"], reads: ["api"] }),
				],
			}),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("reads `api` in the same repository"),
		);
	});

	it("still allows reading across repositories, which is reference, not code", () => {
		const errors = errorsOf(
			plan({
				repos: [
					{ key: "wf", path: "/wf" },
					{ key: "ms", path: "/ms" },
				],
				deliverables: [
					deliverable("api", { repo: "wf" }),
					deliverable("ui", { repo: "ms", after: ["api"], reads: ["api"] }),
				],
			}),
		);
		expect(errors).toEqual([]);
	});
});

describe("the digest covers the new fields", () => {
	it("changes when the reviews change", () => {
		const before = plan();
		const after = reviewed([{ lens: "security" }]);
		expect(planDigest(after)).not.toBe(planDigest(before));
		expect(
			planDigest(reviewed([{ lens: "security", tier: "heavy" }])),
		).not.toBe(planDigest(after));
	});

	it("changes when the policy changes", () => {
		expect(planDigest(plan({ policy: { effort: "deep" } }))).not.toBe(
			planDigest(plan({ policy: { effort: "cheap" } })),
		);
		expect(planDigest(plan({ policy: { publish: { mode: "pr" } } }))).not.toBe(
			planDigest(plan()),
		);
		// And when the plan's own body does, which is part of the document a
		// blind reviewer is shown.
		expect(planDigest(plan({ body: "why" }))).not.toBe(planDigest(plan()));
	});
});

describe("reviews and policy survive the store", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0)
			rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	function temp(label: string): string {
		const dir = mkdtempSync(join(tmpdir(), `maestro-${label}-`));
		dirs.push(dir);
		return dir;
	}

	// A plan's repository path is checked against the world, so the fixture is a
	// real repository. A fake one would test only that validation was off.
	function repo(): string {
		const dir = temp("stages-repo");
		execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
		return dir;
	}

	const policy: PlanPolicy = {
		effort: "standard",
		gates: "approve-plan+ship",
		maxFixRounds: 1,
		publish: { mode: "pr", base: "main" },
	};

	function fixture(root: string): Plan {
		return {
			slug: "arc",
			title: "Arc",
			body: "Why the arc is worth building.",
			repos: [{ key: "main", path: root }],
			policy,
			deliverables: [
				{
					id: "api",
					title: "The API",
					after: [],
					reads: [],
					tasks: [task("build"), task("tests")],
					reviews: [
						{ lens: "contracts", tier: "heavy", diverse: true },
						{ lens: "replay", tier: "standard" },
					],
				},
			],
		};
	}

	it("round-trips byte for byte, digest included", () => {
		const store = createPlanStore({
			cwd: repo(),
			agentDir: temp("store"),
		});
		const written = fixture(repo());
		store.savePlan(written);
		const read = store.loadPlan("arc");
		expect(read).toEqual(written);
		expect(planDigest(read as Plan)).toBe(planDigest(written));
	});

	it("is written by the plan tool, which offers reviews and never the dials", () => {
		const cwd = repo();
		const store = createPlanStore({
			cwd,
			agentDir: temp("store"),
		});
		const tool = createPlanTool({
			store,
			cwd: () => cwd,
			// The seat's own attachment: the dials a human already decided.
			policy: () => policy,
		});
		const schema = JSON.stringify(tool.parameters);
		expect(schema).toContain('"reviews"');
		expect(schema).toContain('"lens"');
		// Neither is the author's to write, so neither is a parameter.
		expect(schema).not.toContain('"stages"');
		expect(schema).not.toContain('"policy"');

		const stored = fixture(cwd);
		// What the model sends is the document WITHOUT the dials; what is stored
		// is that document with them attached.
		const { policy: _dials, ...authored } = stored;
		return (
			tool.execute as unknown as (
				id: string,
				p: unknown,
			) => Promise<{
				content: { text: string }[];
				details: { stored: boolean; errors: readonly string[] };
			}>
		)("call-1", authored).then((result) => {
			expect(result.details.errors).toEqual([]);
			expect(result.details.stored).toBe(true);
			expect(store.loadPlan("arc")).toEqual(stored);
			// Echoed back by lens, so an author sees who they just asked for.
			expect(result.content[0].text).toContain("read by contracts, replay");
		});
	});

	it("reads back in `/plan show` as what will run", () => {
		const text = renderPlan(fixture("/repo"));
		expect(text).toContain("Policy:");
		expect(text).toContain("effort standard, gates approve-plan+ship");
		expect(text).toContain("publish pr from main");
		expect(text).toContain("Why the arc is worth building.");
		expect(text).toContain("read by contracts, tier heavy, diverse");
		expect(text).toContain("stages (derived):");
		expect(text).toContain("implement — implement");
		expect(text).toContain("verify — verify-and-fix, up to 1 fix round");
		expect(text).toContain(
			"review — review-fan-out over contracts (tier heavy, diverse), replay (tier standard), synthesis optional",
		);
	});

	it("shows a plan the seat gave no dials as the defaults it will run at", () => {
		const text = renderPlan(reviewed([{ lens: "security" }]));
		expect(text).toContain(
			"Policy (the plan sets none — these are the defaults)",
		);
		expect(text).toContain(
			"review — review-fan-out over security (tier standard), synthesis optional",
		);
	});
});

// ── Heavy implies diverse, written down ──────────────────────────────────────
//
// The plan-mode exit normalises a stored plan through this before anything
// compiles it. The property that matters is that it is a REWRITE of the
// document and not a default applied on the way to a compiler: two compilers
// read this plan, and an undefined field is where they disagreed.

describe("writing `diverse` onto every heavy reviewer", () => {
	it("fills in every undecided heavy review, and only those", () => {
		const subject = plan({
			deliverables: [
				deliverable("api", {
					reviews: [
						{ lens: "security", tier: "heavy" },
						{ lens: "contracts", tier: "heavy", diverse: false },
						{ lens: "tests", tier: "standard" },
					],
				}),
				deliverable("web", {
					reviews: [
						{ lens: "risk", tier: "heavy" },
						{ lens: "replay", tier: "light" },
					],
				}),
			],
		});

		const next = withExplicitDiverse(subject);
		if (!next)
			throw new Error("a heavy reviewer with no answer was not filled in");
		expect(next.deliverables[0]?.reviews?.map((r) => r.diverse)).toEqual([
			true,
			// Already answered, and answering it again would overrule the author.
			false,
			undefined,
		]);
		expect(next.deliverables[1]?.reviews).toEqual([
			{ lens: "risk", tier: "heavy", diverse: true },
			{ lens: "replay", tier: "light" },
		]);
		// The input is untouched: the caller decides whether to store the result.
		expect(subject.deliverables[0]?.reviews?.[0]?.diverse).toBeUndefined();
		// And the rewritten document is still a plan.
		expect(errorsOf(next)).toEqual([]);
	});

	it("answers `undefined` when there is nothing to write, so the digest holds", () => {
		const untouched = reviewed([{ lens: "tests" }]);
		expect(withExplicitDiverse(untouched)).toBeUndefined();
		expect(planDigest(untouched)).toBe(planDigest(untouched));
	});

	it("reaches the compiled stage list, which is the point of writing it down", () => {
		const next = withExplicitDiverse(
			reviewed([{ lens: "security", tier: "heavy" }]),
		);
		if (!next) throw new Error("nothing was written down");
		const stages = withDefaultStages(next).deliverables[0]?.stages;
		const review = stages?.find((stage) => stage.use === "review-fan-out");
		expect(review).toMatchObject({
			lenses: [{ id: "security", tier: "heavy", diverse: true }],
		});
	});
});
