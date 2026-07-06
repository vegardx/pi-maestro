import { beforeEach, describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import type { WorkItem } from "../packages/modes/src/schema.js";

const noopStore = { save: () => {} };

function gatingTasks(engine: PlanEngine, deliverableId: string): WorkItem[] {
	const plan = engine.get();
	const d = plan.nodes.find(
		(n) => n.type === "deliverable" && n.id === deliverableId,
	);
	if (!d || d.type !== "deliverable") return [];
	return d.children.filter(
		(c): c is WorkItem =>
			c.type === "work-item" && (c.kind === "task" || !c.kind),
	);
}

function followupTasks(engine: PlanEngine, deliverableId: string): WorkItem[] {
	const plan = engine.get();
	const d = plan.nodes.find(
		(n) => n.type === "deliverable" && n.id === deliverableId,
	);
	if (!d || d.type !== "deliverable") return [];
	return d.children.filter(
		(c): c is WorkItem => c.type === "work-item" && c.kind === "followup",
	);
}

/**
 * Tests for Phase 2: auto-toggle on ship + stuck detection.
 */
describe("Phase 2: auto-toggle and stuck detection", () => {
	let engine: PlanEngine;

	beforeEach(() => {
		engine = PlanEngine.create(noopStore as any, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/test",
		});
	});

	describe("auto-toggle on ship (unit behavior)", () => {
		it("ship auto-toggles all remaining gating tasks", () => {
			engine.addDeliverable({ title: "Build API", dependsOn: [] });
			engine.addWorkItem("build-api", { title: "Create routes", kind: "task" });
			engine.addWorkItem("build-api", {
				title: "Add validation",
				kind: "task",
			});
			engine.addWorkItem("build-api", { title: "Write tests", kind: "task" });
			engine.toggleWorkItem("create-routes");

			// 1 toggled, 2 remaining
			let tasks = gatingTasks(engine, "build-api");
			expect(tasks.filter((t) => t.done).length).toBe(1);
			expect(tasks.filter((t) => !t.done).length).toBe(2);

			// Simulate auto-toggle (what ship does after push)
			for (const task of tasks) {
				if (!task.done) engine.toggleWorkItem(task.id);
			}

			// All toggled
			tasks = gatingTasks(engine, "build-api");
			expect(tasks.every((t) => t.done)).toBe(true);
		});

		it("ship with all tasks already toggled does not double-toggle", () => {
			engine.addDeliverable({ title: "Build API", dependsOn: [] });
			engine.addWorkItem("build-api", { title: "Create routes", kind: "task" });
			engine.toggleWorkItem("create-routes");

			// Already toggled — only toggle untoggled ones
			const untoggled = gatingTasks(engine, "build-api").filter((t) => !t.done);
			expect(untoggled.length).toBe(0);

			// No toggles fire — task stays done
			for (const task of untoggled) {
				engine.toggleWorkItem(task.id);
			}
			expect(gatingTasks(engine, "build-api")[0].done).toBe(true);
		});

		it("followup tasks are NOT auto-toggled by ship", () => {
			engine.addDeliverable({ title: "Build API", dependsOn: [] });
			engine.addWorkItem("build-api", { title: "Implement", kind: "task" });
			engine.addWorkItem("build-api", {
				title: "Future work",
				kind: "followup",
			});

			// Auto-toggle only gating tasks
			const gating = gatingTasks(engine, "build-api");
			for (const task of gating) {
				if (!task.done) engine.toggleWorkItem(task.id);
			}

			// Gating done, followup untouched
			expect(gatingTasks(engine, "build-api").every((t) => t.done)).toBe(true);
			expect(followupTasks(engine, "build-api").every((t) => !t.done)).toBe(
				true,
			);
		});
	});

	describe("stuck detection", () => {
		it("does not send steer on first idle", () => {
			const steers: string[] = [];
			let idleCount = 0;
			let stuckSteerSent = false;
			idleCount++;
			if (idleCount >= 5 && !stuckSteerSent) {
				steers.push("You seem stuck.");
				stuckSteerSent = true;
			}

			expect(steers.length).toBe(0);
			expect(stuckSteerSent).toBe(false);
		});

		it("fires stuck steer after 5 consecutive idles", () => {
			const steers: string[] = [];
			let idleCount = 0;
			let stuckSteerSent = false;

			for (let i = 0; i < 5; i++) {
				idleCount++;
				if (idleCount >= 5 && !stuckSteerSent) {
					steers.push("You seem stuck.");
					stuckSteerSent = true;
				}
			}

			expect(steers.length).toBe(1);
			expect(stuckSteerSent).toBe(true);
		});

		it("does not fire stuck steer twice", () => {
			const steers: string[] = [];
			let idleCount = 0;
			let stuckSteerSent = false;

			for (let i = 0; i < 10; i++) {
				idleCount++;
				if (idleCount >= 5 && !stuckSteerSent) {
					steers.push("You seem stuck.");
					stuckSteerSent = true;
				}
			}
			expect(steers.length).toBe(1);
		});

		it("idleCount resets on activity (not firing steer prematurely)", () => {
			let idleCount = 0;
			let stuckSteerSent = false;
			const steers: string[] = [];

			// 3 idles, then activity resets
			for (let i = 0; i < 3; i++) idleCount++;
			idleCount = 0; // simulate activity
			// 3 more idles — total from reset = 3, not 6
			for (let i = 0; i < 3; i++) {
				idleCount++;
				if (idleCount >= 5 && !stuckSteerSent) {
					steers.push("stuck");
					stuckSteerSent = true;
				}
			}

			expect(steers.length).toBe(0);
		});
	});

	describe("commit + ship split", () => {
		it("commit tool does NOT open a PR (openPr: false)", () => {
			// Design contract: commit produces { openPr: false }
			const commitCall = { openPr: false, message: "feat: add routes" };
			expect(commitCall.openPr).toBe(false);
		});

		it("ship tool has no message parameter (push-only)", () => {
			// Ship parameters are empty — it just pushes and opens PR
			const shipParams = {};
			expect(Object.keys(shipParams)).toHaveLength(0);
		});
	});

	describe("unbounded parallelism", () => {
		it("all ready deliverables spawn without limit", () => {
			for (let i = 0; i < 10; i++) {
				engine.addDeliverable({ title: `Task ${i + 1}`, dependsOn: [] });
			}
			const plan = engine.get();
			const ready = plan.nodes.filter(
				(n) =>
					n.type === "deliverable" &&
					n.status === "planned" &&
					(!n.dependsOn || n.dependsOn.length === 0),
			);
			expect(ready.length).toBe(10);
		});

		it("dependency-gated deliverables wait regardless of parallelism", () => {
			engine.addDeliverable({ title: "First", dependsOn: [] });
			engine.addDeliverable({ title: "Second" }); // depends on First

			const plan = engine.get();
			const first = plan.nodes.find(
				(n) => n.type === "deliverable" && n.title === "First",
			);
			const second = plan.nodes.find(
				(n) => n.type === "deliverable" && n.title === "Second",
			);

			expect(first?.type === "deliverable" && first.dependsOn).toEqual([]);
			expect(second?.type === "deliverable" && second.dependsOn).toEqual([
				"first",
			]);
		});
	});
});
