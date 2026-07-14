// Batched deliverable creation: `deliverable(add, items:[…])` creates many
// deliverables in ONE tool call, all-or-nothing, with sibling `dependsOn`
// refs resolved to the minted ids (two-pass, order-independent).

import { describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";
import { createDeliverableTool } from "../packages/modes/src/tools.js";

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
	return PlanEngine.create(memStore(), {
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

function run(engine: PlanEngine, params: unknown): Promise<Res> {
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
		const ds = engine.get().deliverables;
		expect(ds.map((d) => d.id)).toEqual(["first", "second", "third-thing"]);
		expect(ds.map((d) => d.title)).toEqual(["First", "Second", "Third Thing"]);
	});

	it("defaults workerMode to full when omitted", async () => {
		const engine = makeEngine();
		await run(engine, { action: "add", items: [{ id: "a", title: "A" }] });
		expect(engine.get().deliverables[0].worker.mode).toBe("full");
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
		const ui = engine.get().deliverables.find((d) => d.id === "ui");
		expect(ui?.dependsOn).toEqual(["api"]);
	});

	it("resolves a sibling ref even when the id got a dedup suffix", async () => {
		const engine = makeEngine();
		engine.addDeliverable({
			id: "shared",
			title: "Pre-existing",
			workerMode: "full",
		});
		// Item A reuses the handle "shared" → minted "shared-2"; B depends on it.
		await run(engine, {
			action: "add",
			items: [
				{ id: "shared", title: "New Shared" },
				{ id: "consumer", title: "Consumer", dependsOn: ["shared"] },
			],
		});
		const minted = engine
			.get()
			.deliverables.find((d) => d.title === "New Shared");
		expect(minted?.id).toBe("shared-2"); // deduped
		const consumer = engine.get().deliverables.find((d) => d.id === "consumer");
		expect(consumer?.dependsOn).toEqual(["shared-2"]); // resolved to the sibling
	});

	it("passes through a ref to a pre-existing (non-batch) deliverable", async () => {
		const engine = makeEngine();
		engine.addDeliverable({ id: "base", title: "Base", workerMode: "full" });
		await run(engine, {
			action: "add",
			items: [{ id: "next", title: "Next", dependsOn: ["base"] }],
		});
		const next = engine.get().deliverables.find((d) => d.id === "next");
		expect(next?.dependsOn).toEqual(["base"]); // untouched pass-through
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
		const b = engine.get().deliverables.find((d) => d.id === "b");
		expect(b?.dependsOn).toEqual(["a"]);
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
		expect(engine.get().deliverables).toHaveLength(0); // nothing applied
	});

	it("single-item add still works (no items array)", async () => {
		const engine = makeEngine();
		const res = await run(engine, {
			action: "add",
			title: "Solo",
			workerMode: "full",
		});
		expect(res.details?.error).toBeUndefined();
		expect(engine.get().deliverables.map((d) => d.title)).toEqual(["Solo"]);
	});
});
