// Batched task creation: `task(add, items:[…])` creates many work items in
// ONE tool call, all-or-nothing — instead of one add per task.

import { describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";
import { createTaskTool } from "../packages/modes/src/tools.js";

function memStore(): PlanStore {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save: (p: Plan) => {
			saved = p;
		},
		load: () => saved,
		exists: () => saved !== null,
		remove: () => {
			saved = null;
		},
		list: () => [],
	};
}

function makeEngine(): PlanEngine {
	const engine = PlanEngine.create(memStore(), {
		slug: "batch-test",
		title: "Batch Test",
		repoPath: "/tmp/repo",
	});
	engine.addDeliverable({
		id: "d1",
		title: "D1",
		body: "",
		workerMode: "full",
	});
	return engine;
}

type Res = {
	details?: {
		error?: string;
		workItems?: Array<{ id: string; title: string }>;
	};
};

function run(engine: PlanEngine, params: unknown): Promise<Res> {
	const tool = createTaskTool({ engine: () => engine });
	return tool.execute(
		"t",
		params as never,
		undefined as never,
		undefined as never,
		{} as never,
	) as Promise<Res>;
}

describe("task batch add", () => {
	it("creates every item in one call, in order, with minted ids", async () => {
		const engine = makeEngine();
		const res = await run(engine, {
			action: "add",
			deliverableId: "d1",
			items: [
				{ title: "First", body: "do a" },
				{ title: "Second", body: "do b" },
				{ title: "Third" },
			],
		});
		expect(res.details?.error).toBeUndefined();
		expect(res.details?.workItems).toHaveLength(3);
		const tasks = engine.get().deliverables[0].tasks;
		expect(tasks.map((t) => t.title)).toEqual(["First", "Second", "Third"]);
		expect(tasks[0].body).toBe("do a");
		expect(new Set(tasks.map((t) => t.id)).size).toBe(3); // ids are unique
	});

	it("rejects the whole batch when any item lacks a title (all-or-nothing)", async () => {
		const engine = makeEngine();
		const res = await run(engine, {
			action: "add",
			deliverableId: "d1",
			items: [{ title: "Good" }, { title: "  " }],
		});
		expect(res.details?.error).toContain("title");
		expect(engine.get().deliverables[0].tasks).toHaveLength(0); // nothing applied
	});

	it("single-item add still works (no items array)", async () => {
		const engine = makeEngine();
		const res = await run(engine, {
			action: "add",
			deliverableId: "d1",
			title: "Solo",
			body: "just one",
		});
		expect(res.details?.error).toBeUndefined();
		expect(engine.get().deliverables[0].tasks.map((t) => t.title)).toEqual([
			"Solo",
		]);
	});
});
