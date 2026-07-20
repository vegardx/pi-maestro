// Batched deliverable creation: `deliverable(add, items:[…])` creates many
// root nodes in ONE tool call, all-or-nothing, with sibling `dependsOn`
// refs resolved to the minted ids (two-pass, order-independent).

import { describe, expect, it } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import type { PlanV2 } from "../packages/modes/src/plan/schema.js";
import type { PlanStoreV2 } from "../packages/modes/src/plan/storage.js";
import { createDeliverableTool } from "../packages/modes/src/tools.js";

function memStore(): PlanStoreV2 {
	let saved: PlanV2 | null = null;
	return {
		root: "/tmp/plans",
		save: (p: PlanV2) => {
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

function makeEngine(): PlanEngineV2 {
	return PlanEngineV2.create(memStore(), {
		slug: "batch-test",
		title: "Batch Test",
		repoPath: "/tmp/repo",
	});
}

type Res = {
	details?: {
		error?: string;
		deliverables?: Array<{ id: string; title: string }>;
	};
};

function run(engine: PlanEngineV2, params: unknown): Promise<Res> {
	const tool = createDeliverableTool({ engine: () => engine });
	return tool.execute(
		"t",
		params as never,
		undefined as never,
		undefined as never,
		{} as never,
	) as Promise<Res>;
}

describe("deliverable batch add", () => {
	it("creates every item in one call, in order, with minted ids", async () => {
		const engine = makeEngine();
		const res = await run(engine, {
			action: "add",
			items: [
				{ id: "first", title: "First" },
				{ id: "second", title: "Second", body: "ships x" },
				{ title: "Third Thing" },
			],
		});
		expect(res.details?.error).toBeUndefined();
		expect(res.details?.deliverables).toHaveLength(3);
		const nodes = engine.get().nodes;
		expect(nodes.map((n) => n.id)).toEqual(["first", "second", "third-thing"]);
		expect(nodes.map((n) => n.title)).toEqual([
			"First",
			"Second",
			"Third Thing",
		]);
	});

	it("defaults to a branch-owning worker node", async () => {
		const engine = makeEngine();
		await run(engine, { action: "add", items: [{ id: "a", title: "A" }] });
		const node = engine.get().nodes[0];
		expect(node.agent).toBe("worker");
		expect(node.branch).toBe("feat/a");
	});

	it("resolves a sibling dependsOn ref to the minted id", async () => {
		const engine = makeEngine();
		await run(engine, {
			action: "add",
			items: [
				{ id: "api", title: "API" },
				{ id: "ui", title: "UI", dependsOn: ["api"] },
			],
		});
		const ui = engine.get().nodes.find((n) => n.id === "ui");
		expect(ui?.after).toEqual(["api"]);
	});

	it("resolves a sibling ref even when the preferred id was taken", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			id: "shared",
			agent: "worker",
			persona: "coder",
			title: "Pre-existing",
		});
		// Item A reuses the handle "shared" → the engine mints from the title
		// instead ("new-shared"); B's ref must resolve to that minted id.
		await run(engine, {
			action: "add",
			items: [
				{ id: "shared", title: "New Shared" },
				{ id: "consumer", title: "Consumer", dependsOn: ["shared"] },
			],
		});
		const minted = engine.get().nodes.find((n) => n.title === "New Shared");
		expect(minted?.id).toBe("new-shared"); // deduped via the title
		const consumer = engine.get().nodes.find((n) => n.id === "consumer");
		expect(consumer?.after).toEqual(["new-shared"]); // resolved to the sibling
	});

	it("passes through a ref to a pre-existing (non-batch) node", async () => {
		const engine = makeEngine();
		engine.addNode(null, {
			id: "base",
			agent: "worker",
			persona: "coder",
			title: "Base",
		});
		await run(engine, {
			action: "add",
			items: [{ id: "next", title: "Next", dependsOn: ["base"] }],
		});
		const next = engine.get().nodes.find((n) => n.id === "next");
		expect(next?.after).toEqual(["base"]); // untouched pass-through
	});

	it("resolves a dependsOn ref to a later sibling (order-independent)", async () => {
		const engine = makeEngine();
		// B is listed BEFORE the A it depends on — two-pass must still resolve it.
		await run(engine, {
			action: "add",
			items: [
				{ id: "b", title: "B", dependsOn: ["a"] },
				{ id: "a", title: "A" },
			],
		});
		const b = engine.get().nodes.find((n) => n.id === "b");
		expect(b?.after).toEqual(["a"]);
	});

	it("rejects the whole batch when any item lacks a title (all-or-nothing)", async () => {
		const engine = makeEngine();
		const res = await run(engine, {
			action: "add",
			items: [
				{ id: "ok", title: "Good" },
				{ id: "bad", title: "  " },
			],
		});
		expect(res.details?.error).toContain("title");
		expect(engine.get().nodes).toHaveLength(0); // nothing applied
	});

	it("single-item add still works (no items array)", async () => {
		const engine = makeEngine();
		const res = await run(engine, {
			action: "add",
			title: "Solo",
		});
		expect(res.details?.error).toBeUndefined();
		expect(engine.get().nodes.map((n) => n.title)).toEqual(["Solo"]);
	});
});
