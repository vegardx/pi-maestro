// The deliverable-handoff protocol (docs/modes-architecture.md § Deliverable
// handoff): activation injects the lifecycle pair (preflight only with deps,
// postflight always), both gate completion, the postflight toggle records the
// downstream handoff, the lifecycle kinds are reserved from authoring, and
// dependents' seed summaries prefer the handoff over the combined summary.

import { describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import type { Plan } from "../packages/modes/src/schema.js";
import {
	gatingTasks,
	POSTFLIGHT_TASK_ID,
	PREFLIGHT_TASK_ID,
	postflightTask,
} from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

function memStore(): PlanStore {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save(plan: Plan) {
			saved = plan;
		},
		load: () => saved,
		exists: () => saved !== null,
		remove() {
			saved = null;
		},
		list: () => [],
	};
}

function makeEngine(): PlanEngine {
	const engine = PlanEngine.create(memStore(), {
		slug: "handoff",
		title: "Handoff Plan",
		repoPath: "/tmp/repo",
	});
	engine.addDeliverable({
		id: "base",
		title: "Base library",
		workerMode: "full",
	});
	engine.addDeliverable({
		id: "consumer",
		title: "Consumer feature",
		dependsOn: ["base"],
		workerMode: "full",
	});
	engine.addWorkItem("base", { title: "build it", kind: "task" });
	engine.addWorkItem("consumer", { title: "use it", kind: "task" });
	return engine;
}

describe("lifecycle task injection", () => {
	it("activation injects postflight always, preflight only with dependencies", () => {
		const engine = makeEngine();
		engine.setDeliverableStatus("base", "active");

		const base = engine.get().deliverables.find((g) => g.id === "base");
		expect(base?.tasks.map((t) => t.kind)).toEqual(["task", "postflight"]);
		expect(postflightTask(base ?? { tasks: [] })?.id).toBe(POSTFLIGHT_TASK_ID);

		// The dependent gets both: preflight first, postflight last.
		engine.setDeliverableStatus("consumer", "active");
		const consumer = engine.get().deliverables.find((g) => g.id === "consumer");
		expect(consumer?.tasks.map((t) => t.kind)).toEqual([
			"preflight",
			"task",
			"postflight",
		]);
		expect(consumer?.tasks[0]?.id).toBe(PREFLIGHT_TASK_ID);
	});

	it("is idempotent across re-activation", () => {
		const engine = makeEngine();
		engine.setDeliverableStatus("base", "active");
		// Re-assert active (recovery paths re-set status).
		engine.setDeliverableStatus("base", "active");
		const base = engine.get().deliverables.find((g) => g.id === "base");
		expect(base?.tasks.filter((t) => t.kind === "postflight")).toHaveLength(1);
	});

	it("lifecycle tasks gate completion alongside real tasks", () => {
		const engine = makeEngine();
		engine.setDeliverableStatus("consumer", "active");
		const consumer = engine.get().deliverables.find((g) => g.id === "consumer");
		const gating = gatingTasks(consumer ?? { tasks: [] });
		expect(gating.map((t) => t.kind)).toEqual([
			"preflight",
			"task",
			"postflight",
		]);
	});
});

describe("postflight toggle records the handoff", () => {
	it("stores the summary on the deliverable when toggling done", () => {
		const engine = makeEngine();
		engine.setDeliverableStatus("base", "active");
		engine.toggleWorkItem("base", POSTFLIGHT_TASK_ID, {
			summary: "  Built libbase. API: init()/run(). Gotcha: init is async.  ",
		});
		const base = engine.get().deliverables.find((g) => g.id === "base");
		expect(base?.handoff).toBe(
			"Built libbase. API: init()/run(). Gotcha: init is async.",
		);
	});

	it("ignores a summary on ordinary task toggles", () => {
		const engine = makeEngine();
		engine.setDeliverableStatus("base", "active");
		engine.toggleWorkItem("base", "build-it", { summary: "not a handoff" });
		const base = engine.get().deliverables.find((g) => g.id === "base");
		expect(base?.handoff).toBeUndefined();
	});

	it("toggling postflight without a summary completes but records nothing", () => {
		const engine = makeEngine();
		engine.setDeliverableStatus("base", "active");
		const done = engine.toggleWorkItem("base", POSTFLIGHT_TASK_ID);
		expect(done).toBe(true);
		expect(
			engine.get().deliverables.find((g) => g.id === "base")?.handoff,
		).toBeUndefined();
	});
});
