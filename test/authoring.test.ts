// Authoring: one tool, the whole plan, every error at once.
//
// The shape being tested is the absence of an incremental API. There is no
// add-a-deliverable and no move-a-task, so there are no rules about what may be
// edited once something has started, no ordering between calls, and no
// half-written state that is valid only because the next call has not arrived.
// A plan is either storable or it comes back with everything wrong with it.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanTool } from "../packages/maestro/src/authoring.js";
import type { ModeName } from "../packages/maestro/src/mode.js";
import { createPlanStore } from "../packages/maestro/src/store.js";

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

function authoring(cwd: string = repo(), mode?: ModeName) {
	const root = temp("authoring");
	const store = createPlanStore(root);
	const tool = createPlanTool({
		store,
		cwd: () => cwd,
		...(mode ? { mode: () => mode } : {}),
	});
	const write = (plan: unknown) =>
		(
			tool.execute as unknown as (
				id: string,
				p: unknown,
			) => Promise<{
				content: { text: string }[];
				details: {
					stored: boolean;
					errors: readonly string[];
					warnings: readonly string[];
				};
			}>
		)("call-1", plan);
	return { store, tool, write, cwd };
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
	it("stores it, and says what the graph turned out to be", async () => {
		const a = authoring();
		const result = await a.write({
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
						{
							id: "review",
							title: "Review it",
							by: {
								lens: "correctness",
								skill: "correctness-review",
								model: "anthropic/fable-5",
							},
						},
					],
				},
			],
		});

		expect(result.details.stored).toBe(true);
		expect(a.store.loadPlan("arc")?.deliverables).toHaveLength(2);

		// Read back as the graph, because an author who cannot see the edges they
		// just wrote will write the same wrong one twice.
		const text = result.content[0].text;
		expect(text).toContain("- api: 1 task");
		expect(text).toContain(
			"- ui: 2 tasks, 1 delegated review intent(s) after api",
		);
		// The trailer is the offer, not a status line: both ways to start a run,
		// and who approves it — which is never this tool and never the model.
		expect(text).toContain("Run it: `/plan run arc [cheap|standard|deep]`");
		expect(text).toContain(
			'workflow_run { ref: "plan-to-ship", input: { plan, planDigest, effort } }',
		);
		expect(text).toContain("approve-plan");
		expect(text).not.toContain("Workflow execution is unavailable");
	});

	it("offers the way out of plan mode, which otherwise has none", async () => {
		// Plan mode is a tool posture with no exit path, so a stored plan is the
		// nearest thing it has to a completion point. Both ways on are named:
		// hand the plan to a run, or leave the posture and edit by hand.
		const inPlanMode = await authoring(repo(), "plan").write(minimal);
		const text = inPlanMode.content[0].text;
		expect(text).toContain("`/mode auto`");
		expect(text).toContain("Run it: `/plan run arc");
		// A run is not the model's to start from here at all: the seat refuses
		// both tools, and the trailer names the two ways one does start.
		expect(text).toContain("`workflow_run` and `workflow_propose` are");
		expect(text).toContain("refused here");
		expect(text).toContain("`/workflow run`");
		expect(text).toContain("blind reviewer");

		// Not said in a posture that can already write: it would be noise.
		const inAuto = await authoring(repo(), "auto").write(minimal);
		expect(inAuto.content[0].text).not.toContain("/mode auto");
		expect(inAuto.content[0].text).toContain("Run it: `/plan run arc");
	});

	it("defaults the repo to where the maestro is sitting", async () => {
		const a = authoring();
		await a.write(minimal);
		expect(a.store.loadPlan("arc")?.repos).toEqual([
			{ key: "main", path: a.cwd },
		]);
	});

	it("stores a plan whose repository is dirty, and says so", async () => {
		// Non-fatal on purpose: authoring a plan while the tree has edits in it
		// is the normal case. The author is told because every worktree the run
		// creates branches from HEAD, so those edits are not in the run.
		const a = authoring();
		writeFileSync(join(a.cwd, "scratch.txt"), "in progress\n", "utf8");
		const result = await a.write(minimal);
		expect(result.details.stored).toBe(true);
		expect(result.details.warnings).toContainEqual(
			expect.stringContaining("uncommitted changes"),
		);
		expect(result.content[0].text).toContain("uncommitted changes");
	});

	it("refuses a repository path that is not a working-tree root", async () => {
		const a = authoring();
		const result = await a.write({
			...minimal,
			repos: [{ key: "main", path: temp("not-a-repo") }],
		});
		expect(result.details.stored).toBe(false);
		expect(result.content[0].text).toContain(
			"is not an existing Git working-tree root",
		);
	});

	it("takes the same slug again as a rewrite, needing no merge", async () => {
		// Extending a plan is sending it again with more in it. There is no
		// merge, so there is nothing to get wrong about merging.
		const a = authoring();
		await a.write(minimal);
		await a.write({
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
	it("reports every error in one pass, and stores nothing", async () => {
		// One error per round trip through five round trips is an author that
		// starts guessing.
		const a = authoring();
		const result = await a.write({
			slug: "arc",
			title: "Arc",
			deliverables: [
				{ id: "Bad Id", title: "One", tasks: [] },
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

		expect(result.details.stored).toBe(false);
		const text = result.content[0].text;
		expect(text).toContain("cannot be a workflow id");
		expect(text).toContain("no tasks");
		expect(text).toContain("no such deliverable");
		expect(text).toContain("without waiting for it");
		expect(text).toContain("Send the whole plan again");
		expect(a.store.loadPlan("arc")).toBeNull();
	});

	it("counts them in words a reader can act on", async () => {
		const a = authoring();
		const one = await a.write({
			...minimal,
			deliverables: [{ id: "api", title: "The API", tasks: [] }],
		});
		expect(one.content[0].text).toContain("One thing is wrong");
	});

	it("leaves an already-stored plan untouched when a rewrite is rejected", async () => {
		// The store refuses invalid writes, so a bad rewrite cannot damage what
		// is already there — but it is worth pinning, because "I broke the plan
		// while trying to extend it" is unrecoverable in a way an error is not.
		const a = authoring();
		await a.write(minimal);
		await a.write({
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

describe("what the schema will not let an author say", () => {
	it("offers workflow review intent, never a persona or agent kind", () => {
		const schema = JSON.stringify(authoring().tool.parameters);
		expect(schema).toContain('"by"');
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

	it("has no field for anything a run decides", () => {
		// No status, no branch, no worktree, no PR. The plan is what was agreed;
		// what happened is a separate record, and an author that could write a
		// status could write a lie.
		//
		// Asserted over the schema's PROPERTY NAMES rather than its bytes, because
		// `policy.publish.mode` names a branch and a pull request as things to ASK
		// for — a decision the plan makes, not a record of what a run did.
		const names = [...propertyNames(authoring().tool.parameters)];
		for (const runtime of ["status", "branch", "worktree", "handoff", "pr"])
			expect(names).not.toContain(runtime);
	});
});
