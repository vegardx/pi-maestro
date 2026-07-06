import { describe, expect, it } from "vitest";
import { buildPlanModePreamble, buildExecutionPreamble } from "../packages/modes/src/planning-preamble.js";
import { PlanEngine } from "../packages/modes/src/engine.js";
import type { PlanStore } from "../packages/modes/src/storage.js";
import type { Plan } from "../packages/modes/src/schema.js";

function memStore(): PlanStore {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save(plan: Plan) { saved = plan; },
		load(_slug: string): Plan | null { return saved; },
		exists(_slug: string): boolean { return saved !== null; },
		remove(_slug: string) { saved = null; },
		list() { return []; },
	};
}

describe("buildPlanModePreamble", () => {
	it("shows new plan message when no engine", () => {
		const preamble = buildPlanModePreamble(undefined);
		expect(preamble).toContain("PLAN MODE");
		expect(preamble).toContain("work groups");
	});

	it("shows update message for existing plan", () => {
		const engine = PlanEngine.create(memStore(), {
			slug: "my-plan",
			title: "My Plan",
			repoPath: "/tmp",
		});
		const preamble = buildPlanModePreamble(engine);
		expect(preamble).toContain("PLAN MODE updating plan `my-plan`");
	});

	it("includes delegate guidance", () => {
		const preamble = buildPlanModePreamble(undefined);
		expect(preamble).toContain("explorer");
		expect(preamble).toContain("researcher");
		expect(preamble).toContain("advisor");
	});

	it("includes convergence criteria", () => {
		const preamble = buildPlanModePreamble(undefined);
		expect(preamble).toContain("file paths");
		expect(preamble).toContain("signatures");
	});

	it("mentions group/task/agent tools", () => {
		const preamble = buildPlanModePreamble(undefined);
		expect(preamble).toContain("group(add");
		expect(preamble).toContain("task(add");
		expect(preamble).toContain("agent(add");
	});
});

describe("buildExecutionPreamble", () => {
	it("shows group status overview", () => {
		const engine = PlanEngine.create(memStore(), {
			slug: "exec-plan",
			title: "Exec",
			repoPath: "/tmp",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "t1" });
		engine.setGroupStatus("auth", "active");

		const preamble = buildExecutionPreamble(engine);
		expect(preamble).toContain("EXECUTION MODE");
		expect(preamble).toContain("group:auth");
		expect(preamble).toContain("active");
	});

	it("shows all status categories", () => {
		const engine = PlanEngine.create(memStore(), {
			slug: "multi",
			title: "Multi",
			repoPath: "/tmp",
		});
		engine.addGroup({ title: "A", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("a", { title: "t1" });
		engine.addGroup({ title: "B", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("b", { title: "t2" });
		engine.setGroupStatus("a", "active");

		const preamble = buildExecutionPreamble(engine);
		expect(preamble).toContain("group:a — active");
		expect(preamble).toContain("group:b — planned");
	});
});
