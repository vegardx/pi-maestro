// Authoring: one tool, the whole plan, every error at once.
//
// The shape being tested is the absence of an incremental API. There is no
// add-a-deliverable and no move-a-task, so there are no rules about what may be
// edited once something has started, no ordering between calls, and no
// half-written state that is valid only because the next call has not arrived.
// A plan is either storable or it comes back with everything wrong with it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanTool } from "../packages/maestro/src/authoring.js";
import { createPlanStore } from "../packages/maestro/src/store.js";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function authoring() {
	const root = mkdtempSync(join(tmpdir(), "maestro-authoring-"));
	dirs.push(root);
	const store = createPlanStore(root);
	const stored: string[] = [];
	const tool = createPlanTool({
		store,
		cwd: () => "/repo",
		onStored: (plan) => stored.push(plan.slug),
	});
	const write = (plan: unknown) =>
		(
			tool.execute as unknown as (
				id: string,
				p: unknown,
			) => Promise<{
				content: { text: string }[];
				details: { stored: boolean; errors: readonly string[] };
			}>
		)("call-1", plan);
	return { store, tool, write, stored };
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
					reads: ["api"],
					tasks: [
						{ id: "build", title: "Build it" },
						{
							id: "review",
							title: "Review it",
							by: { agent: "reviewer", persona: "code-review" },
						},
					],
				},
			],
		});

		expect(result.details.stored).toBe(true);
		expect(a.store.loadPlan("arc")?.deliverables).toHaveLength(2);
		expect(a.stored).toEqual(["arc"]);

		// Read back as the graph, because an author who cannot see the edges they
		// just wrote will write the same wrong one twice.
		const text = result.content[0].text;
		expect(text).toContain("- api: 1 task");
		expect(text).toContain("- ui: 2 tasks, 1 delegated after api reads api");
		expect(text).toContain("/run arc");
	});

	it("defaults the repo to where the maestro is sitting", async () => {
		const a = authoring();
		await a.write(minimal);
		expect(a.store.loadPlan("arc")?.repos).toEqual([
			{ key: "main", path: "/repo" },
		]);
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
		expect(text).toContain("cannot be an id");
		expect(text).toContain("no tasks");
		expect(text).toContain("no such deliverable");
		expect(text).toContain("without waiting for it");
		expect(text).toContain("Send the whole plan again");
		expect(a.store.loadPlan("arc")).toBeNull();
		expect(a.stored).toEqual([]);
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

describe("what the schema will not let an author say", () => {
	it("offers only the read-only kinds to delegate to", () => {
		// A writer is authored as a deliverable, never spawned from a task. The
		// schema says so before validation has to.
		const schema = JSON.stringify(authoring().tool.parameters);
		expect(schema).toContain("explorer");
		expect(schema).toContain("reviewer");
		expect(schema).toContain("advisor");
		expect(schema).not.toContain('"worker"');
	});

	it("has no field for anything a run decides", () => {
		// No status, no branch, no worktree, no PR. The plan is what was agreed;
		// what happened is a separate record, and an author that could write a
		// status could write a lie.
		const schema = JSON.stringify(authoring().tool.parameters);
		for (const runtime of ["status", "branch", "worktree", "handoff", "pr"])
			expect(schema).not.toContain(`"${runtime}"`);
	});
});
