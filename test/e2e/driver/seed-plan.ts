// Deterministic plan seeding: write a valid, ready-to-execute plan.json into
// the isolated pi home so a drive can skip plan *authoring* entirely and go
// straight at what the e2e actually tests — execution, routing, review, ship,
// recover. Plan authoring is the most model-sensitive step (a weak local model
// hallucinates authoring; see docs/modes-architecture.md backlog #7/#8), so the
// execution-focused drive must not depend on it.
//
// Built with the real PlanEngineV2 + createPlanStoreV2, so the seeded plan is
// schema-correct by construction (every mutation runs validatePlanShapeV2) and
// stays correct as the schema evolves. The SUT opens it with
// `/plan sandbox-features` (openPlan reopens an existing slug from the store).

import { join } from "node:path";
import { PlanEngineV2 } from "../../../packages/modes/src/plan/engine.js";
import { PARENT_AFTER_TOKEN } from "../../../packages/modes/src/plan/schema.js";
import { createPlanStoreV2 } from "../../../packages/modes/src/plan/storage.js";
import { SANDBOX_FEATURES } from "./scenario.js";

/** The plans root inside an isolated pi home (mirrors plansRoot(agentDir)). */
export function seededPlansRoot(piHome: string): string {
	return join(piHome, ".pi", "agent", "maestro", "plans");
}

/**
 * Seed the canned `sandbox-features` plan (same shape the scenario's
 * planPrompt describes) into the isolated home. Returns the slug.
 *
 * v2 shape: three worker root nodes owning `feat/<id>` branches; the
 * security audit is a reviewer CHILD of the validation node gated on the
 * parent's own tasks (v1's `after: ["worker"]`); advanced-math stacks via
 * sibling `after` deps (deriveBase picks the first dep's branch).
 */
export function seedScenarioPlan(piHome: string, repoDir: string): string {
	const store = createPlanStoreV2(seededPlansRoot(piHome));
	const engine = PlanEngineV2.create(store, {
		slug: SANDBOX_FEATURES.name,
		title: "Sandbox features",
		repoPath: repoDir,
	});

	engine.addNode(null, {
		id: "add-statistics-module",
		agent: "worker",
		persona: "coder",
		title: "Add statistics module",
		body:
			"Create `src/stats.ts` exporting `mean(numbers: number[]): number` " +
			"(throw on empty input) and `median(numbers: number[]): number`. " +
			"Add `tests/stats.test.ts` covering both (empty-input throw included). " +
			"Run `npm test` to verify.",
		branch: "feat/add-statistics-module",
	});
	engine.addTask("add-statistics-module", {
		title: "Implement src/stats.ts (mean, median)",
		body: "mean throws on empty input; median handles even/odd lengths.",
	});
	engine.addTask("add-statistics-module", {
		title: "Add tests/stats.test.ts and make npm test pass",
	});

	engine.addNode(null, {
		id: "add-validation-utilities",
		agent: "worker",
		persona: "coder",
		title: "Add validation utilities",
		body:
			"Create `src/validate.ts` exporting `isPositive(n: number): boolean` " +
			"and `assertInRange(n: number, min: number, max: number): void` " +
			"(throws RangeError when out of range). Add `tests/validate.test.ts`. " +
			"Run `npm test` to verify.",
		branch: "feat/add-validation-utilities",
	});
	engine.addTask("add-validation-utilities", {
		title: "Implement src/validate.ts (isPositive, assertInRange)",
		body: "assertInRange throws RangeError; mind NaN/Infinity edge cases.",
	});
	engine.addTask("add-validation-utilities", {
		title: "Add tests/validate.test.ts and make npm test pass",
	});
	engine.addNode("add-validation-utilities", {
		id: "security-audit",
		agent: "reviewer",
		persona: "reviewer",
		title: "Security audit: validation utilities",
		body:
			"Audit the validation utilities for NaN/Infinity edge cases: " +
			"isPositive(NaN), assertInRange with NaN/±Infinity bounds or values. " +
			"Report concrete failing inputs.",
		after: [PARENT_AFTER_TOKEN],
	});

	engine.addNode(null, {
		id: "add-advanced-math",
		agent: "worker",
		persona: "coder",
		title: "Add advanced math",
		body:
			"Create `src/advanced.ts` exporting " +
			"`standardDeviation(numbers: number[]): number` (uses `mean` from " +
			"`./stats.js`) and `clampToRange(value, min, max)` (uses " +
			"`assertInRange` from `./validate.js`). Add `tests/advanced.test.ts`. " +
			"Stacks on the statistics and validation deliverables.",
		branch: "feat/add-advanced-math",
		after: ["add-statistics-module", "add-validation-utilities"],
	});
	engine.addTask("add-advanced-math", {
		title: "Implement src/advanced.ts (standardDeviation, clampToRange)",
		body: "Reuse mean() and assertInRange() from the upstream deliverables.",
	});
	engine.addTask("add-advanced-math", {
		title: "Add tests/advanced.test.ts and make npm test pass",
	});

	return SANDBOX_FEATURES.name;
}
