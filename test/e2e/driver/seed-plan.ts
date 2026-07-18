// Deterministic plan seeding: write a valid, ready-to-execute plan.json into
// the isolated pi home so a drive can skip plan *authoring* entirely and go
// straight at what the e2e actually tests — execution, routing, review, ship,
// recover. Plan authoring is the most model-sensitive step (a weak local model
// hallucinates authoring; see docs/modes-architecture.md backlog #7/#8), so the
// execution-focused drive must not depend on it.
//
// Built with the real PlanEngine + createPlanStore, so the seeded plan is
// schema-correct by construction (every mutation runs validatePlanShape) and
// stays correct as the schema evolves. The SUT opens it with
// `/plan sandbox-features` (openPlan reopens an existing slug from the store);
// lifecycle tasks (preflight/postflight) are injected by the engine at
// activation, so the seed does not pre-author them.

import { join } from "node:path";
import { PlanEngine } from "../../../packages/modes/src/engine.js";
import { createPlanStore } from "../../../packages/modes/src/storage.js";
import { SANDBOX_FEATURES } from "./scenario.js";

/** The plans root inside an isolated pi home (mirrors plansRoot(agentDir)). */
export function seededPlansRoot(piHome: string): string {
	return join(piHome, ".pi", "agent", "maestro", "plans");
}

/**
 * Seed the canned `sandbox-features` plan (same shape the scenario's
 * planPrompt describes) into the isolated home. Returns the slug.
 */
export function seedScenarioPlan(piHome: string, repoDir: string): string {
	const store = createPlanStore(seededPlansRoot(piHome));
	const engine = PlanEngine.create(store, {
		slug: SANDBOX_FEATURES.name,
		title: "Sandbox features",
		repoPath: repoDir,
	});

	engine.addDeliverable({
		id: "add-statistics-module",
		title: "Add statistics module",
		body:
			"Create `src/stats.ts` exporting `mean(numbers: number[]): number` " +
			"(throw on empty input) and `median(numbers: number[]): number`. " +
			"Add `tests/stats.test.ts` covering both (empty-input throw included). " +
			"Run `npm test` to verify.",
		workerMode: "full",
	});
	engine.addWorkItem("add-statistics-module", {
		title: "Implement src/stats.ts (mean, median)",
		body: "mean throws on empty input; median handles even/odd lengths.",
	});
	engine.addWorkItem("add-statistics-module", {
		title: "Add tests/stats.test.ts and make npm test pass",
	});

	engine.addDeliverable({
		id: "add-validation-utilities",
		title: "Add validation utilities",
		body:
			"Create `src/validate.ts` exporting `isPositive(n: number): boolean` " +
			"and `assertInRange(n: number, min: number, max: number): void` " +
			"(throws RangeError when out of range). Add `tests/validate.test.ts`. " +
			"Run `npm test` to verify.",
		workerMode: "full",
	});
	engine.addWorkItem("add-validation-utilities", {
		title: "Implement src/validate.ts (isPositive, assertInRange)",
		body: "assertInRange throws RangeError; mind NaN/Infinity edge cases.",
	});
	engine.addWorkItem("add-validation-utilities", {
		title: "Add tests/validate.test.ts and make npm test pass",
	});
	engine.addAgent("add-validation-utilities", {
		name: "security-audit",
		mode: "read-only",
		focus:
			"Audit the validation utilities for NaN/Infinity edge cases: " +
			"isPositive(NaN), assertInRange with NaN/±Infinity bounds or values. " +
			"Report concrete failing inputs.",
		after: ["worker"],
	});

	engine.addDeliverable({
		id: "add-advanced-math",
		title: "Add advanced math",
		body:
			"Create `src/advanced.ts` exporting " +
			"`standardDeviation(numbers: number[]): number` (uses `mean` from " +
			"`./stats.js`) and `clampToRange(value, min, max)` (uses " +
			"`assertInRange` from `./validate.js`). Add `tests/advanced.test.ts`. " +
			"Stacks on the statistics and validation deliverables.",
		dependsOn: ["add-statistics-module", "add-validation-utilities"],
		stacked: true,
		workerMode: "full",
	});
	engine.addWorkItem("add-advanced-math", {
		title: "Implement src/advanced.ts (standardDeviation, clampToRange)",
		body: "Reuse mean() and assertInRange() from the upstream deliverables.",
	});
	engine.addWorkItem("add-advanced-math", {
		title: "Add tests/advanced.test.ts and make npm test pass",
	});

	return SANDBOX_FEATURES.name;
}
