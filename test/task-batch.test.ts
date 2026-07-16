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

// The `task` tool schema is shared with workers, which run engine-less and
// forward mutations over the RPC bridge. Batch add must work there too.
describe("task batch add (agent/RPC path)", () => {
	type MutateCall = { title?: string; body?: string; kind?: string };

	function runAgent(
		bridge: { planMutate: (a: string, g: string, p: MutateCall) => unknown },
		params: unknown,
	): Promise<Res> {
		const tool = createTaskTool({
			engine: () => undefined,
			agentBridge: () => bridge as never,
			agentDeliverableId: () => "d1",
		});
		return tool.execute(
			"t",
			params as never,
			undefined as never,
			undefined as never,
			{} as never,
		) as Promise<Res>;
	}

	it("forwards each item over the bridge, in order", async () => {
		const calls: MutateCall[] = [];
		let n = 0;
		const bridge = {
			planMutate: async (_a: string, _g: string, p: MutateCall) => {
				calls.push(p);
				return { success: true, taskId: `t${++n}` };
			},
		};
		const res = await runAgent(bridge, {
			action: "add",
			items: [{ title: "First" }, { title: "Second", body: "b" }],
		});
		expect(res.details?.error).toBeUndefined();
		expect(calls.map((c) => c.title)).toEqual(["First", "Second"]);
	});

	it("rejects a titleless batch before any RPC (all-or-nothing)", async () => {
		let called = false;
		const bridge = {
			planMutate: async () => {
				called = true;
				return { success: true, taskId: "t1" };
			},
		};
		const res = await runAgent(bridge, {
			action: "add",
			items: [{ title: "Good" }, { title: " " }],
		});
		expect(res.details?.error).toContain("title");
		expect(called).toBe(false); // nothing forwarded
	});
});

// Models fill optional params with "" or a slug guessed from the deliverable
// title; the authenticated identity must win or every mutation is rejected
// with "agent may only mutate its own deliverable" and the worker wedges.
describe("task deliverableId routing (agent/RPC path)", () => {
	function toggleWith(
		deliverableId: string | undefined,
	): Promise<{ res: Res; gIds: string[] }> {
		const gIds: string[] = [];
		const bridge = {
			planMutate: async (_a: string, g: string) => {
				gIds.push(g);
				return { success: true, taskId: "t1" };
			},
		};
		const tool = createTaskTool({
			engine: () => undefined,
			agentBridge: () => bridge as never,
			agentDeliverableId: () => "d1",
		});
		return (
			tool.execute(
				"t",
				{ action: "toggle", taskId: "t1", deliverableId } as never,
				undefined as never,
				undefined as never,
				{} as never,
			) as Promise<Res>
		).then((res) => ({ res, gIds }));
	}

	it("routes an empty-string deliverableId to the agent's own deliverable", async () => {
		const { res, gIds } = await toggleWith("");
		expect(res.details?.error).toBeUndefined();
		expect(gIds).toEqual(["d1"]);
	});

	it("routes a guessed wrong slug to the agent's own deliverable", async () => {
		const { res, gIds } = await toggleWith("guessed-title-slug");
		expect(res.details?.error).toBeUndefined();
		expect(gIds).toEqual(["d1"]);
	});

	it("routes an omitted deliverableId to the agent's own deliverable", async () => {
		const { res, gIds } = await toggleWith(undefined);
		expect(res.details?.error).toBeUndefined();
		expect(gIds).toEqual(["d1"]);
	});
});
