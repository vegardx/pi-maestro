// Authoring: the whole plan, every error at once, and no tool anywhere.
//
// The shape being tested is the absence of two things. There is no incremental
// API — no add-a-deliverable, no move-a-task — so there are no rules about what
// may be edited once something has started, no ordering between calls, and no
// half-written state that is valid only because the next call has not arrived.
// And there is no TOOL: `defineTool` used to check the arguments against the
// schema before `execute` ran, and a harness that asks a model directly has
// nothing doing that for it. So the whole path is plain functions over a parsed
// JSON value — `authoredPlanProblems` → `withoutEmptyOptionals` → `planFrom` →
// `inspectPlan` → `savePlan` — and that is what these tests drive.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DESCRIPTION_SYSTEM_PROMPT,
	renderDocumentSystemPrompt,
} from "../packages/maestro/src/authoring.js";
import { inspectPlan, type Plan } from "../packages/maestro/src/plan.js";
import {
	type AuthoredPlan,
	authoredPlanProblems,
	PLAN_DOCUMENT_GUIDE,
	PlanSchema,
	planFrom,
	withoutEmptyOptionals,
} from "../packages/maestro/src/plan-document.js";
import { createPlanStore } from "../packages/maestro/src/store.js";
import { fakeHost } from "./fake-host.js";

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

// The seat sits in a real repository, and a plan's repo path is validated
// against one, so the fixture is a real repository too. A fake path here would
// test only that validation had been switched off.
function repo(): string {
	const dir = temp("authoring-repo");
	execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
	return dir;
}

/**
 * The harness's own path, in one function.
 *
 * Exactly what `runExitFlow` does with an answer from the model, in the same
 * order: the schema, the empty-optional drop, the stored shape, the validator,
 * and only then disk. Written once here so the test and the flow cannot come to
 * disagree about which reading of a document is the reading.
 */
function authoring(cwd: string = repo()) {
	const root = temp("authoring");
	// One host for the validation and the store, as the seat wires them: a plan
	// the exit accepted and the store then refused would be a second opinion
	// about what is legal, and that is the bug the shared seam exists to prevent.
	const host = () =>
		fakeHost({
			models: ["anthropic/fable-5"],
			skills: ["correctness-review", "contracts-review"],
		});
	const store = createPlanStore({
		cwd,
		agentDir: root,
		sessionId: () => "authoring-session",
		host,
	});
	const write = (
		document: unknown,
	): {
		stored: boolean;
		errors: readonly string[];
		warnings: readonly string[];
		plan?: Plan;
	} => {
		const schema = authoredPlanProblems(document);
		if (schema.length > 0)
			return { stored: false, errors: schema, warnings: [] };
		const plan = planFrom(withoutEmptyOptionals(document as AuthoredPlan), {
			cwd,
		});
		const { errors, warnings } = inspectPlan(plan, undefined, host());
		if (errors.length > 0) return { stored: false, errors, warnings };
		store.savePlan(plan);
		return { stored: true, errors, warnings, plan };
	};
	return { store, write, cwd };
}

const minimal = {
	slug: "arc",
	title: "Arc",
	deliverables: [
		{
			id: "api",
			title: "The API",
			tasks: [{ id: "build", title: "Build it" }],
		},
	],
};

describe("a plan is written whole", () => {
	it("stores the graph the document describes", () => {
		const a = authoring();
		const result = a.write({
			...minimal,
			deliverables: [
				minimal.deliverables[0],
				{
					id: "ui",
					title: "The UI",
					after: ["api"],
					reads: [],
					tasks: [
						{ id: "build", title: "Build it" },
						{ id: "test", title: "Test it" },
					],
					reviews: [
						{
							lens: "correctness",
							skill: "correctness-review",
							model: "anthropic/fable-5",
						},
					],
				},
			],
		});

		expect(result.stored).toBe(true);
		const stored = a.store.loadPlan("arc");
		expect(stored?.deliverables).toHaveLength(2);
		expect(stored?.deliverables[1]).toMatchObject({
			id: "ui",
			after: ["api"],
			reads: [],
		});
		expect(stored?.deliverables[1]?.tasks).toHaveLength(2);
	});

	it("drops an optional value the author left empty, rather than refusing it", () => {
		// The by-hand pass that produced this rule lost a whole document to ten
		// errors of exactly this shape: "`` is not a safe ambient skill name" and
		// "delegated task model must be a concrete provider/model ID", for a
		// document whose author had meant to say nothing at all.
		const a = authoring();
		const result = a.write({
			slug: "arc",
			title: "Arc",
			deliverables: [
				{
					id: "api",
					title: "The API",
					body: "   ",
					after: [""],
					reads: [],
					repo: "",
					tasks: [{ id: "build", title: "Build it", body: "" }],
					reviews: [{ lens: "contracts", skill: "", model: "", tier: "light" }],
				},
			],
			body: "  ",
		});
		expect(result.errors).toEqual([]);
		expect(result.stored).toBe(true);

		// Nothing empty reached the stored document — which is the document the
		// digest covers and the blind reviewer reads.
		const stored = a.store.loadPlan("arc");
		const json = JSON.stringify(stored);
		expect(json).not.toContain('""');
		expect(json).not.toContain('[""]');
		const deliverable = stored?.deliverables[0];
		expect(deliverable && "body" in deliverable).toBe(false);
		expect(deliverable && "repo" in deliverable).toBe(false);
		expect(deliverable?.after).toEqual([]);
		expect(stored && "body" in stored).toBe(false);
		expect(deliverable?.reviews).toEqual([
			{ lens: "contracts", tier: "light" },
		]);
	});

	it("still refuses a REQUIRED field left empty, by name", () => {
		// The drop is narrow on purpose: an empty `id` is a claim this document
		// makes, and a silent drop would turn it into a different error later.
		const a = authoring();
		const result = a.write({
			slug: "arc",
			title: "Arc",
			deliverables: [
				{
					id: "",
					title: "The API",
					tasks: [{ id: "build", title: "Build it" }],
					reviews: [{ lens: "" }],
				},
			],
		});
		expect(result.stored).toBe(false);
		expect(result.errors).toEqual([
			"deliverables[0]: no id",
			"deliverables[0].reviews[0]: a review needs a lens; a task that is not " +
				"a review is simply a task, and belongs in `tasks` with no review entry",
		]);
		expect(a.store.loadPlan("arc")).toBeNull();
	});

	it("defaults the repo to where the maestro is sitting", () => {
		const a = authoring();
		a.write(minimal);
		expect(a.store.loadPlan("arc")?.repos).toEqual([
			{ key: "main", path: a.cwd },
		]);
	});

	it("stores a plan whose repository is dirty, and says so", () => {
		// Non-fatal on purpose: authoring a plan while the tree has edits in it
		// is the normal case. It is reported because every worktree the run
		// creates branches from HEAD, so those edits are not in the run.
		const a = authoring();
		writeFileSync(join(a.cwd, "scratch.txt"), "in progress\n", "utf8");
		const result = a.write(minimal);
		expect(result.stored).toBe(true);
		expect(result.warnings).toContainEqual(
			expect.stringContaining("uncommitted changes"),
		);
	});

	it("refuses a repository path that is not a working-tree root", () => {
		const a = authoring();
		const result = a.write({
			...minimal,
			repos: [{ key: "main", path: temp("not-a-repo") }],
		});
		expect(result.stored).toBe(false);
		expect(result.errors.join("\n")).toContain(
			"is not an existing Git working-tree root",
		);
	});

	it("takes the same slug again as a rewrite, needing no merge", () => {
		// Extending a plan is sending it again with more in it. There is no
		// merge, so there is nothing to get wrong about merging.
		const a = authoring();
		a.write(minimal);
		a.write({
			...minimal,
			title: "Arc, extended",
			deliverables: [
				...minimal.deliverables,
				{ id: "ui", title: "The UI", tasks: [{ id: "b", title: "Build" }] },
			],
		});
		const plan = a.store.loadPlan("arc");
		expect(plan?.title).toBe("Arc, extended");
		expect(plan?.deliverables.map((d) => d.id)).toEqual(["api", "ui"]);
	});
});

describe("a rejected plan comes back with everything wrong with it", () => {
	it("reports every error in one pass, and stores nothing", () => {
		// One error per round trip through five round trips is an author that
		// starts guessing.
		const a = authoring();
		const result = a.write({
			slug: "arc",
			title: "Arc",
			deliverables: [
				{ id: "Bad Id", title: "One", tasks: [{ id: "t", title: "T" }] },
				{
					id: "two",
					title: "",
					after: ["ghost"],
					tasks: [{ id: "t", title: "T" }],
				},
				{
					id: "three",
					title: "Three",
					reads: ["two"],
					tasks: [{ id: "t", title: "T" }],
				},
			],
		});

		expect(result.stored).toBe(false);
		const text = result.errors.join("\n");
		expect(text).toContain("cannot be a workflow id");
		expect(text).toContain("no such deliverable");
		expect(text).toContain("without waiting for it");
		expect(a.store.loadPlan("arc")).toBeNull();
	});

	it("is refused by the schema before the validator ever sees it", () => {
		// The schema is the first reader, because `defineTool` is not one of the
		// readers any more: a deliverable with no tasks is a shape this build
		// cannot read, and that is a different sentence from a graph it can read
		// and does not like.
		const a = authoring();
		const result = a.write({
			...minimal,
			deliverables: [{ id: "api", title: "The API", tasks: [] }],
		});
		expect(result.stored).toBe(false);
		expect(result.errors.join("\n")).toContain("/deliverables/0/tasks");
		expect(a.store.loadPlan("arc")).toBeNull();
	});

	it("leaves an already-stored plan untouched when a rewrite is rejected", () => {
		// The store refuses invalid writes, so a bad rewrite cannot damage what
		// is already there — but it is worth pinning, because "I broke the plan
		// while trying to extend it" is unrecoverable in a way an error is not.
		const a = authoring();
		a.write(minimal);
		a.write({
			...minimal,
			deliverables: [{ id: "api", title: "x", tasks: [] }],
		});
		expect(a.store.loadPlan("arc")?.deliverables[0]?.tasks).toHaveLength(1);
	});
});

/** Every `properties` key anywhere in a JSON schema, at any depth. */
function propertyNames(
	schema: unknown,
	into: Set<string> = new Set(),
): Set<string> {
	if (!schema || typeof schema !== "object") return into;
	for (const [key, value] of Object.entries(
		schema as Record<string, unknown>,
	)) {
		if (key === "properties" && value && typeof value === "object")
			for (const name of Object.keys(value as Record<string, unknown>))
				into.add(name);
		propertyNames(value, into);
	}
	return into;
}

// ── The guidance is short because the shape is right ─────────────────────────
//
// Version 4's description ran to about four kilobytes across thirty-three field
// notes, most of them capitalised warnings, and four by-hand passes wrote every
// field it warned against anyway. The bound is here so the notes cannot creep
// back one refusal at a time: when the answer to a failed run is another
// sentence in a field description, the shape is what needs changing.

describe("the document's own guidance", () => {
	/** Every `description` the document carries: its own, and every field's. */
	function descriptions(node: unknown, into: string[] = []): string[] {
		if (!node || typeof node !== "object") return into;
		for (const [key, value] of Object.entries(node)) {
			if (key === "description" && typeof value === "string") into.push(value);
			descriptions(value, into);
		}
		return into;
	}

	it("stays under 1.2 KB in total, with nothing shouting", () => {
		const all = [PLAN_DOCUMENT_GUIDE, ...descriptions(PlanSchema)];
		const bytes = all.reduce(
			(total, text) => total + Buffer.byteLength(text, "utf8"),
			0,
		);
		expect(bytes).toBeLessThan(1200);
		// No capitalised words and no `⇒`: both were how version 4 said what the
		// shape would not.
		for (const text of all) {
			expect(text).not.toMatch(/\b[A-Z]{2,}\b/);
			expect(text).not.toContain("⇒");
		}
	});

	it("travels whole in the system prompt that asks for the document", () => {
		// The guide is one paragraph and the schema is the contract; the prompt
		// carries both, so what a model is told and what is enforced are one
		// thing.
		const prompt = renderDocumentSystemPrompt({}, "A description, agreed.");
		expect(prompt).toContain(PLAN_DOCUMENT_GUIDE);
		expect(prompt).toContain(JSON.stringify(PlanSchema, null, 2));
		// The description prompt asks for prose, so it carries neither.
		expect(DESCRIPTION_SYSTEM_PROMPT).not.toContain(PLAN_DOCUMENT_GUIDE);
	});
});

// ── Callable without a tool ──────────────────────────────────────────────────

describe("the document, read without a tool", () => {
	const authored = {
		slug: "arc",
		title: "Arc",
		deliverables: [
			{
				id: "api",
				title: "The API",
				tasks: [{ id: "build", title: "Build it", body: "  " }],
				reviews: [{ lens: "contracts", model: "" }],
			},
		],
	};

	it("says nothing about a document the schema accepts", () => {
		expect(authoredPlanProblems(authored)).toEqual([]);
	});

	it("names what it rejects, all of it, and never throws", () => {
		expect(authoredPlanProblems({ slug: "arc" }).length).toBeGreaterThan(0);
		expect(authoredPlanProblems(null).length).toBeGreaterThan(0);
		expect(authoredPlanProblems("not a plan").length).toBeGreaterThan(0);
	});

	it("cleans and builds the stored document as plain functions", () => {
		const plan = planFrom(withoutEmptyOptionals(authored), {
			cwd: "/repo",
			policy: { effort: "deep" },
		});
		// The empty optionals are gone, the default repository is filled in, and
		// the dials are the caller's — none of which needed a tool.
		expect(JSON.stringify(plan)).not.toContain('""');
		expect(plan.repos).toEqual([{ key: "main", path: "/repo" }]);
		expect(plan.policy).toEqual({ effort: "deep" });
		expect(plan.deliverables[0]?.reviews).toEqual([{ lens: "contracts" }]);
	});
});

describe("what the schema will not let an author say", () => {
	it("offers workflow review intent, never a persona or agent kind", () => {
		const schema = JSON.stringify(PlanSchema);
		expect(schema).toContain('"reviews"');
		expect(schema).toContain("lens");
		expect(schema).toContain("model");
		// Routable review intent: a tier and a family request, neither of which
		// pins the plan to a host that happens to have one exact model.
		expect(schema).toContain("tier");
		expect(schema).toContain("heavy");
		expect(schema).toContain("diverse");
		expect(schema).not.toContain("persona");
		expect(schema).not.toContain('"agent"');
		expect(schema).not.toContain('"worker"');
	});

	it("has no field for anything a run decides, or any dial the seat owns", () => {
		// No status, no branch, no worktree, no PR. The plan is what was agreed;
		// what happened is a separate record, and an author that could write a
		// status could write a lie. No `policy` and no `stages` either: those are
		// the seat's, settled before the document exists.
		const names = [...propertyNames(PlanSchema)];
		for (const runtime of [
			"status",
			"branch",
			"worktree",
			"handoff",
			"pr",
			"policy",
			"stages",
		])
			expect(names).not.toContain(runtime);
	});
});
