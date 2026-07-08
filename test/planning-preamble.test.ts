import { describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	buildExecutionPreamble,
	buildPlanModePreamble,
} from "../packages/modes/src/planning-preamble.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

function memStore(): PlanStore {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save(plan: Plan) {
			saved = plan;
		},
		load(_slug: string): Plan | null {
			return saved;
		},
		exists(_slug: string): boolean {
			return saved !== null;
		},
		remove(_slug: string) {
			saved = null;
		},
		list() {
			return [];
		},
	};
}

describe("buildPlanModePreamble", () => {
	it("starts new plans in the exploring phase", () => {
		const preamble = buildPlanModePreamble(undefined);
		expect(preamble).toContain("PLAN MODE");
		expect(preamble).toContain("EXPLORING");
		expect(preamble).toContain("Do NOT form a plan yet");
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

	it("exploring guides the research loop and the readiness gate", () => {
		const preamble = buildPlanModePreamble(undefined);
		expect(preamble).toContain("`research`");
		expect(preamble).toContain("codebase");
		expect(preamble).toContain("web");
		expect(preamble).toContain("advisor");
		expect(preamble).toContain("`readiness`");
		// Structure tools are locked — no structuring workflow yet.
		expect(preamble).not.toContain("group(action");
	});

	it("teaches the ask ladder and decision-block format in both phases", () => {
		const engine = PlanEngine.create(memStore(), {
			slug: "ladder",
			title: "Ladder",
			repoPath: "/tmp",
		});
		engine.setPhase("structuring");
		for (const preamble of [
			buildPlanModePreamble(undefined),
			buildPlanModePreamble(engine),
		]) {
			expect(preamble).toContain("blocking: true");
			expect(preamble).toContain("whyBlocking");
			expect(preamble).toContain("◆ Where I need your direction");
			expect(preamble).toContain("don't ask");
		}
	});

	it("includes convergence criteria in both phases", () => {
		const engine = PlanEngine.create(memStore(), {
			slug: "conv",
			title: "Conv",
			repoPath: "/tmp",
		});
		engine.setPhase("structuring");
		for (const preamble of [
			buildPlanModePreamble(undefined),
			buildPlanModePreamble(engine),
		]) {
			expect(preamble).toContain("file paths");
			expect(preamble).toContain("signatures");
		}
	});

	it("structuring mentions group/task/agent tools and the understanding", () => {
		const engine = PlanEngine.create(memStore(), {
			slug: "structured",
			title: "Structured",
			repoPath: "/tmp",
		});
		engine.setPhase("structuring", "We will build a clamp helper.");
		const preamble = buildPlanModePreamble(engine);
		expect(preamble).toContain("STRUCTURING");
		expect(preamble).toContain("group(action");
		expect(preamble).toContain("task(action");
		expect(preamble).toContain("agent(action");
		expect(preamble).toContain("We will build a clamp helper.");
		expect(preamble).toContain("research/");
	});

	it("plans with groups but no phase field hydrate as structuring", () => {
		const engine = PlanEngine.create(memStore(), {
			slug: "legacy",
			title: "Legacy",
			repoPath: "/tmp",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "t1" });
		const preamble = buildPlanModePreamble(engine);
		expect(preamble).toContain("STRUCTURING");
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
