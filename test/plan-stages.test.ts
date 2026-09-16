// Stages and policy: how a deliverable is compiled, and the dials it sets.
//
// Both are OPTIONAL, and that is the property most of this file is about. A
// document written before stages existed is still valid, still hashes to the
// same digest, and still compiles to the three stages it always compiled to —
// which is only true if the defaults are derived rather than stored.
//
// The refusals are the other half. A stage kind nothing compiles, a fix loop
// with no bound, a gate in the middle of a deliverable, a `reads` edge the
// runtime cannot honour: each is refused by name, because the alternative is a
// plan that a human approves and a run then quietly does not do.

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
	type PlanPolicy,
	type RepoProbe,
	resolvePolicy,
	type Stage,
	type Task,
	validatePlan,
	withDefaultStages,
} from "../packages/maestro/src/plan.js";
import { renderPlan } from "../packages/maestro/src/plan-command.js";
import { planDigest } from "../packages/maestro/src/plan-input.js";
import { createPlanStore } from "../packages/maestro/src/store.js";

const cleanRepo: RepoProbe = (path) => ({
	root: path,
	resolved: path,
	dirty: false,
});

const errorsOf = (subject: Plan): string[] => validatePlan(subject, cleanRepo);

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
	deliverables: [deliverable("api")],
	repos: [{ key: "main", path: "/repo" }],
	...over,
});

/** A plan whose one deliverable declares exactly these stages. */
const staged = (stages: readonly Stage[], over: Partial<Plan> = {}): Plan =>
	plan({ deliverables: [deliverable("api", { stages })], ...over });

const implement: Stage = { use: "implement", id: "build" };

describe("a deliverable that declares no stages gets the default ones", () => {
	it("implements, verifies, and reviews what the tasks asked to be reviewed", () => {
		const d = deliverable("api", {
			tasks: [
				task("build"),
				task("sec", { lens: "security", tier: "heavy", diverse: true }),
				task("contracts", { lens: "contracts" }),
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
					// What the task pinned wins; what it left open comes from the
					// policy, which is what `reviewDefault` is for.
					{ id: "security", tier: "heavy", diverse: true },
					{ id: "contracts", tier: "standard", diverse: false },
				],
			},
		]);
	});

	it("declares no review stage when nothing asked for a review", () => {
		// A fan-out over zero lenses is not a cheaper review; it is a stage that
		// cannot be compiled at all.
		const stages = defaultStagesFor(deliverable("api"), resolvePolicy());
		expect(stages.map((s) => s.use)).toEqual(["implement", "verify-and-fix"]);
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

	it("produces a stage list that validates on its own terms", () => {
		// The defaults have to obey the same rules as anything authored, or the
		// rules are about typing rather than about running.
		const authored = plan({
			deliverables: [
				deliverable("api", {
					tasks: [task("build"), task("sec", { lens: "security" })],
				}),
			],
		});
		expect(errorsOf(authored)).toEqual([]);
		expect(errorsOf(withDefaultStages(authored))).toEqual([]);
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

	it("is pure: filling the defaults in changes neither the plan nor its digest", () => {
		const before = plan();
		const digest = planDigest(before);
		const after = withDefaultStages(before);
		expect(before.deliverables[0].stages).toBeUndefined();
		expect(planDigest(before)).toBe(digest);
		expect(after.deliverables[0].stages).toHaveLength(2);
	});
});

describe("what a stage list may not say", () => {
	it("refuses a kind nothing compiles", () => {
		const errors = errorsOf(
			staged([implement, { use: "deploy", id: "ship" } as unknown as Stage]),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("`deploy` is not a stage kind"),
		);
	});

	it("refuses `dynamic`, which is reserved and not compiled yet", () => {
		const errors = errorsOf(
			staged([
				implement,
				{ use: "dynamic", id: "decide", brief: "figure it out" },
			]),
		);
		expect(errors).toContainEqual(
			"api.stages[1]: dynamic stages are not compiled yet",
		);
	});

	it("refuses a stage id that cannot be a workflow namespace, or a repeated one", () => {
		expect(
			errorsOf(staged([{ use: "implement", id: "Build It" }])),
		).toContainEqual(expect.stringContaining("cannot be a stage id"));
		expect(
			errorsOf(staged([implement, { use: "verify-and-fix", id: "build" }])),
		).toContainEqual("api: duplicate stage id `build`");
	});

	it("refuses a deliverable that implements nothing, or implements twice", () => {
		expect(
			errorsOf(staged([{ use: "verify-and-fix", id: "verify" }])),
		).toContainEqual(expect.stringContaining("declare no `implement` stage"));
		expect(
			errorsOf(staged([implement, { use: "implement", id: "build-2" }])),
		).toContainEqual(expect.stringContaining("2 `implement` stages"));
	});

	it("refuses a verify stage that runs before there is anything to verify", () => {
		const errors = errorsOf(
			staged([{ use: "verify-and-fix", id: "verify" }, implement]),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("follows the `implement` stage"),
		);
	});

	it("refuses an unbounded fix loop", () => {
		const errors = errorsOf(
			staged([
				implement,
				{ use: "verify-and-fix", id: "verify", maxRounds: 3 as 2 },
			]),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("`maxRounds` is 0, 1, 2"),
		);
	});

	it("refuses a gate anywhere but last, and one that shows what has not run", () => {
		expect(
			errorsOf(
				staged([
					implement,
					{ use: "gate", id: "ok", question: "Ship it?" },
					{ use: "verify-and-fix", id: "verify" },
				]),
			),
		).toContainEqual(expect.stringContaining("is the last stage"));
		expect(
			errorsOf(
				staged([
					implement,
					{ use: "gate", id: "ok", question: "Ship it?", show: ["ghost"] },
				]),
			),
		).toContainEqual(expect.stringContaining("shows `ghost`"));
		// An earlier sibling is exactly what it may show.
		expect(
			errorsOf(
				staged([
					implement,
					{ use: "gate", id: "ok", question: "Ship it?", show: ["build"] },
				]),
			),
		).toEqual([]);
	});

	it("refuses a stage field that smuggles in code or a path", () => {
		expect(
			errorsOf(
				staged([
					implement,
					{
						use: "gate",
						id: "ok",
						question: "Is /Users/vegardx/src/thing.ts right?",
					},
				]),
			),
		).toContainEqual(expect.stringContaining("names a filesystem path"));
		expect(
			errorsOf(
				staged([
					implement,
					{ use: "gate", id: "ok", question: "Does const x = 1 hold?" },
				]),
			),
		).toContainEqual(expect.stringContaining("contains code"));
		expect(
			errorsOf(
				staged([
					{ use: "implement", id: "build", tools: ["./scripts/run.sh"] },
				]),
			),
		).toContainEqual(expect.stringContaining("is not a tool name"));
	});

	it("refuses a fan-out with no lenses, or more than sixteen", () => {
		expect(
			errorsOf(
				staged([
					implement,
					{ use: "review-fan-out", id: "review", lenses: [] },
				]),
			),
		).toContainEqual(expect.stringContaining("no lenses"));
		expect(
			errorsOf(
				staged([
					implement,
					{
						use: "review-fan-out",
						id: "review",
						lenses: Array.from({ length: 17 }, (_, i) => ({ id: `lens-${i}` })),
					},
				]),
			),
		).toContainEqual(expect.stringContaining("17 lenses"));
	});

	it("holds a lens to the same routing rules as a task's `by`", () => {
		const errors = errorsOf(
			staged([
				implement,
				{
					use: "review-fan-out",
					id: "review",
					lenses: [
						{ id: "Security" },
						{ id: "replay", model: "fable" },
						{ id: "contracts", tier: "exhaustive" as "heavy" },
					],
				},
			]),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("`Security` is not a safe review lens"),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("must be a concrete provider/model ID"),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("`exhaustive` is not a review tier"),
		);
	});

	it("refuses a lens id the compiled document could not carry", () => {
		// A lens id is a fan-out key and reaches `@vegardx/pi-workflow` inside the
		// compiled stage document, whose schema accepts `^[a-z][a-z0-9-]*$`. A
		// deliverable id may start with a digit; a lens id may not, or the plan
		// validates here and compiles nowhere. Both places that name a lens are
		// held to it, and every one of them is reported at once.
		const errors = errorsOf(
			staged([
				implement,
				{
					use: "review-fan-out",
					id: "review",
					lenses: [{ id: "2fa" }, { id: "-leading" }, { id: "contracts" }],
				},
			]),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("`2fa` is not a safe review lens"),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("`-leading` is not a safe review lens"),
		);
		expect(errors.join("\n")).toContain("starts with a lowercase letter");
		expect(
			errors.filter((error) => error.includes("not a safe review lens")),
		).toHaveLength(2);

		// The same rule, and the same message, for a task's own `by`.
		const byLens = errorsOf(
			plan({
				deliverables: [
					deliverable("api", { tasks: [task("t", { lens: "2fa" })] }),
				],
			}),
		);
		expect(byLens).toContainEqual(
			expect.stringContaining("`2fa` is not a safe review lens"),
		);
		expect(
			errorsOf(
				plan({
					deliverables: [
						deliverable("api", { tasks: [task("t", { lens: "a2" })] }),
					],
				}),
			),
		).toEqual([]);
	});

	it("reports every wrong stage at once", () => {
		// The whole list is walked even after a bad stage: an author fixing one
		// stage per round trip is an author who starts guessing.
		const errors = errorsOf(
			staged([
				{ use: "gate", id: "early", question: "Now?" },
				{ use: "wat", id: "x" } as unknown as Stage,
				{ use: "dynamic", id: "later", brief: "tbd" },
			]),
		);
		expect(errors.length).toBeGreaterThanOrEqual(4);
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

	it("accepts a plan that sets every dial", () => {
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
	it("changes when the stages change", () => {
		const before = plan();
		const after = staged([implement]);
		expect(planDigest(after)).not.toBe(planDigest(before));
		expect(
			planDigest(staged([implement, { use: "verify-and-fix", id: "v" }])),
		).not.toBe(planDigest(after));
	});

	it("changes when the policy changes", () => {
		expect(planDigest(plan({ policy: { effort: "deep" } }))).not.toBe(
			planDigest(plan({ policy: { effort: "cheap" } })),
		);
		expect(planDigest(plan({ policy: { publish: { mode: "pr" } } }))).not.toBe(
			planDigest(plan()),
		);
	});
});

describe("stages and policy survive the store", () => {
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

	function fixture(root: string): Plan {
		return {
			slug: "arc",
			title: "Arc",
			repos: [{ key: "main", path: root }],
			policy: {
				effort: "standard",
				gates: "approve-plan+ship",
				maxFixRounds: 1,
				publish: { mode: "pr", base: "main" },
			},
			deliverables: [
				{
					id: "api",
					title: "The API",
					after: [],
					reads: [],
					tasks: [task("build"), task("sec", { lens: "security" })],
					stages: [
						{ use: "implement", id: "build", tools: ["read", "bash"] },
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
	}

	it("round-trips byte for byte, digest included", () => {
		const store = createPlanStore(temp("store"));
		const written = fixture(repo());
		store.savePlan(written);
		const read = store.loadPlan("arc");
		expect(read).toEqual(written);
		expect(planDigest(read as Plan)).toBe(planDigest(written));
	});

	it("is written by the plan tool, which offers both fields", () => {
		const cwd = repo();
		const store = createPlanStore(temp("store"));
		const tool = createPlanTool({ store, cwd: () => cwd });
		const schema = JSON.stringify(tool.parameters);
		expect(schema).toContain('"stages"');
		expect(schema).toContain('"policy"');
		for (const kind of [
			"implement",
			"verify-and-fix",
			"review-fan-out",
			"gate",
		])
			expect(schema).toContain(`"${kind}"`);
		// `dynamic` is reserved in the schema and refused by validation, so
		// offering it here would only spend a turn to learn that.
		expect(schema).not.toContain('"dynamic"');

		const authored = fixture(cwd);
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
			expect(store.loadPlan("arc")).toEqual(authored);
			// Echoed back, so an author can see the stages they just wrote.
			expect(result.content[0].text).toContain("stages build → green → review");
		});
	});

	it("reads back in `/plan show` as what will run", () => {
		const text = renderPlan(fixture("/repo"));
		expect(text).toContain("Policy:");
		expect(text).toContain("effort standard, gates approve-plan+ship");
		expect(text).toContain("publish pr from main");
		expect(text).toContain("build — implement, tools read, bash");
		expect(text).toContain(
			"green — verify-and-fix, up to 2 fix rounds, escalating to thinking",
		);
		expect(text).toContain(
			"review — review-fan-out over contracts (tier heavy, diverse), replay (tier standard), synthesis required",
		);
	});

	it("shows a plan that declared nothing as the stages it will get anyway", () => {
		const text = renderPlan(
			plan({
				deliverables: [
					deliverable("api", {
						tasks: [task("build"), task("sec", { lens: "security" })],
					}),
				],
			}),
		);
		expect(text).toContain(
			"Policy (the plan sets none — these are the defaults)",
		);
		expect(text).toContain("stages (default):");
		expect(text).toContain("implement — implement");
		expect(text).toContain("verify — verify-and-fix, up to 1 fix round");
		expect(text).toContain(
			"review — review-fan-out over security (tier standard), synthesis optional",
		);
	});
});
