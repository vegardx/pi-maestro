import { describe, expect, it } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import type { PlanV2 } from "../packages/modes/src/plan/schema.js";
import type { PlanStoreV2 } from "../packages/modes/src/plan/storage.js";
import {
	buildExecutionPreamble,
	buildPlanModePreamble,
} from "../packages/modes/src/planning-preamble.js";

function memStore(): PlanStoreV2 {
	let saved: PlanV2 | null = null;
	return {
		root: "/tmp/plans",
		save(plan: PlanV2) {
			saved = plan;
		},
		load(_slug: string): PlanV2 | null {
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
		const engine = PlanEngineV2.create(memStore(), {
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
		expect(preamble).toContain("`readiness`");
		// Structure tools are locked — no structuring workflow yet.
		expect(preamble).toContain("are locked");
		expect(preamble).not.toContain("You MUST use the `node` and `task` tools");
	});

	it("teaches the ask ladder and decision-block format in both phases", () => {
		const engine = PlanEngineV2.create(memStore(), {
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
		const engine = PlanEngineV2.create(memStore(), {
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

	it("structuring mentions node/task tools and the understanding", () => {
		const engine = PlanEngineV2.create(memStore(), {
			slug: "structured",
			title: "Structured",
			repoPath: "/tmp",
		});
		engine.setPhase("structuring", "We will build a clamp helper.");
		const preamble = buildPlanModePreamble(engine);
		expect(preamble).toContain("STRUCTURING");
		expect(preamble).toContain("`deliverable`");
		expect(preamble).toContain("`task`");
		expect(preamble).toContain("We will build a clamp helper.");
	});

	it("guides child-node review coverage and inheritance", () => {
		const engine = PlanEngineV2.create(memStore(), {
			slug: "workflow",
			title: "Workflow",
			repoPath: "/tmp",
		});
		engine.setPhase("structuring");
		const preamble = buildPlanModePreamble(engine);
		expect(preamble).toContain("CHILD NODES");
		expect(preamble).toContain('`after: ["parent"]`');
		expect(preamble).toContain("resolve by inheritance");
		expect(preamble).toContain("Never author models or efforts");
	});

	it("plans with nodes but no phase field hydrate as structuring", () => {
		const engine = PlanEngineV2.create(memStore(), {
			slug: "legacy",
			title: "Legacy",
			repoPath: "/tmp",
		});
		engine.addNode(null, { agent: "worker", persona: "coder", title: "Auth" });
		engine.addTask("auth", { title: "t1" });
		const preamble = buildPlanModePreamble(engine);
		expect(preamble).toContain("STRUCTURING");
	});
});

describe("buildExecutionPreamble", () => {
	it("shows node status overview", () => {
		const engine = PlanEngineV2.create(memStore(), {
			slug: "exec-plan",
			title: "Exec",
			repoPath: "/tmp",
		});
		engine.addNode(null, { agent: "worker", persona: "coder", title: "Auth" });
		engine.addTask("auth", { title: "t1" });
		engine.setNodeStatus("auth", "active");

		const preamble = buildExecutionPreamble(engine);
		expect(preamble).toContain("EXECUTION MODE");
		expect(preamble).toContain("node:auth");
		expect(preamble).toContain("active");
	});

	it("shows all status categories", () => {
		const engine = PlanEngineV2.create(memStore(), {
			slug: "multi",
			title: "Multi",
			repoPath: "/tmp",
		});
		engine.addNode(null, { agent: "worker", persona: "coder", title: "A" });
		engine.addTask("a", { title: "t1" });
		engine.addNode(null, { agent: "worker", persona: "coder", title: "B" });
		engine.addTask("b", { title: "t2" });
		engine.setNodeStatus("a", "active");

		const preamble = buildExecutionPreamble(engine);
		expect(preamble).toContain("node:a — active");
		expect(preamble).toContain("node:b — planned");
	});
});
