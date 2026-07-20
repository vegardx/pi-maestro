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

/**
 * Seed the ensemble acceptance plan (task #27): parent `build-metrics` on
 * feat/build-metrics with two BRANCHLESS worker children — the executor
 * provisions those as candidates on cand/build-metrics/<id> from the
 * parent's branch point, and candidates never ship (shippableNodes skips
 * cand/ branches). The parent integrates and ships the one PR.
 */
export function seedEnsemblePlan(piHome: string, repoDir: string): string {
	const store = createPlanStoreV2(seededPlansRoot(piHome));
	const engine = PlanEngineV2.create(store, {
		slug: "ensemble-metrics",
		title: "Ensemble metrics module",
		repoPath: repoDir,
	});

	engine.addNode(null, {
		id: "build-metrics",
		agent: "worker",
		persona: "coder",
		title: "Build the metrics module from two candidates",
		body:
			"Two candidate agents are implementing `src/metrics.ts` RIGHT NOW on " +
			"the branches `cand/build-metrics/cand-a` and " +
			"`cand/build-metrics/cand-b` (they share your repo's object store — " +
			"`git log cand/build-metrics/cand-a` works from your worktree). " +
			"Each ends with a commit whose subject starts with `DONE:`. " +
			"FIRST: wait for BOTH candidates — poll " +
			"`git log --oneline cand/build-metrics/cand-a cand/build-metrics/cand-b` " +
			"every ~30 seconds (sleep between polls) until both branches show a " +
			"DONE: commit. While waiting you may sketch `tests/metrics.test.ts` " +
			"expectations, nothing else. THEN: review both diffs " +
			"(`git diff main...cand/build-metrics/cand-a` etc.), pick the " +
			"stronger implementation, integrate it into YOUR branch " +
			"(cherry-pick or copy + reconcile — your call), keep " +
			"`tests/metrics.test.ts` meaningful, and make `npm test` pass. " +
			"Do NOT push or open PRs for the candidate branches — their diffs " +
			"are inputs; your branch is the only deliverable.",
		branch: "feat/build-metrics",
	});
	engine.addTask("build-metrics", {
		title:
			"Wait for both candidates, review both diffs, integrate the stronger",
		body: "Poll the two cand/ branches for DONE: commits before integrating.",
	});
	engine.addTask("build-metrics", {
		title: "tests/metrics.test.ts passes via npm test",
	});

	const candidate = (id: string, approach: string) => {
		engine.addNode("build-metrics", {
			id,
			agent: "worker",
			persona: "coder",
			title: `Candidate ${id}: metrics module (${approach})`,
			body:
				"You are ONE OF TWO candidate implementations — your committed " +
				"diff is the deliverable; a parent agent integrates the stronger " +
				"one. Implement `src/metrics.ts` exporting " +
				"`mean(numbers: number[]): number` (throw on empty), " +
				"`max(numbers: number[]): number` (throw on empty), and " +
				"`range(numbers: number[]): number` (max minus min). " +
				`Approach for YOUR candidate: ${approach}. ` +
				"Add `tests/metrics.test.ts` and make `npm test` pass locally. " +
				"Commit everything. Your FINAL commit subject must start with " +
				"`DONE:`. Never push and never open a PR.",
		});
		engine.addTask(id, {
			title: "Implement src/metrics.ts (mean, max, range) and tests",
		});
		engine.addTask(id, {
			title: "Final commit with subject starting DONE:",
		});
	};
	candidate(
		"cand-a",
		"single-pass iteration — compute mean, max, and min in one loop, no sorting, no intermediate arrays",
	);
	candidate(
		"cand-b",
		"simple and direct — reduce/Math.max/Math.min over the array, favor readability over cleverness",
	);

	return "ensemble-metrics";
}
