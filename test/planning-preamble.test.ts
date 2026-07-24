import { describe, expect, it } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import type { PlanV2 } from "../packages/modes/src/plan/schema.js";
import type { PlanStoreV2 } from "../packages/modes/src/plan/storage.js";
import {
	buildExecutionPreamble,
	buildFormingPreamble,
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
	it("is conversation-only — converge, no author section, no structure tools", () => {
		const preamble = buildPlanModePreamble(undefined);
		expect(preamble).toContain("PLAN MODE");
		expect(preamble).toContain("## Converge");
		// Authoring moved to the forming turn — plan conversation must not
		// instruct or expose it.
		expect(preamble).not.toContain("## Author");
		expect(preamble).not.toContain("You MUST use");
		expect(preamble).toContain("Converge; don't structure");
		expect(preamble).toContain("## Crossing into execution");
		expect(preamble).toContain("Shift+Tab");
	});

	it("shows update message for an existing plan", () => {
		const engine = PlanEngineV2.create(memStore(), {
			slug: "my-plan",
			title: "My Plan",
			repoPath: "/tmp",
		});
		const preamble = buildPlanModePreamble(engine);
		expect(preamble).toContain("PLAN MODE updating plan `my-plan`");
	});

	it("guides the research loop with no phase lock or readiness gate", () => {
		const preamble = buildPlanModePreamble(undefined);
		expect(preamble).toContain("`research`");
		expect(preamble).toContain("codebase");
		expect(preamble).toContain("web");
		expect(preamble).not.toContain("readiness");
		expect(preamble).not.toContain("are locked");
	});

	it("teaches the ask ladder and decision-block format", () => {
		const preamble = buildPlanModePreamble(undefined);
		expect(preamble).toContain("blocking: true");
		expect(preamble).toContain("whyBlocking");
		expect(preamble).toContain("◆ Where I need your direction");
		expect(preamble).toContain("don't ask");
	});

	it("includes the convergence criteria", () => {
		const preamble = buildPlanModePreamble(undefined);
		expect(preamble).toContain("file paths");
		expect(preamble).toContain("signatures");
	});
});

describe("buildFormingPreamble", () => {
	it("self-assess gate: ask + stop on open questions, else author", () => {
		const preamble = buildFormingPreamble(undefined);
		expect(preamble).toContain("FORMING THE PLAN");
		expect(preamble).toContain("## First: self-assess");
		expect(preamble).toContain("`ask`");
		expect(preamble).toContain("re-gesture");
	});

	it("guides authoring with the structure tools, tasks required", () => {
		const preamble = buildFormingPreamble(undefined);
		expect(preamble).toContain("## Author");
		expect(preamble).toContain("`deliverable`");
		expect(preamble).toContain("`task`");
		expect(preamble).toContain("You MUST use");
		expect(preamble).toContain("enter execution");
	});

	it("guides child-node review coverage and inheritance", () => {
		const preamble = buildFormingPreamble(undefined);
		expect(preamble).toContain("CHILD NODES");
		expect(preamble).toContain('`after: ["parent"]`');
		expect(preamble).toContain("resolve by inheritance");
		expect(preamble).toContain("Never author models or efforts");
	});

	it("names the plan slug for an existing plan", () => {
		const engine = PlanEngineV2.create(memStore(), {
			slug: "my-plan",
			title: "My Plan",
			repoPath: "/tmp",
		});
		expect(buildFormingPreamble(engine)).toContain("plan `my-plan`");
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
