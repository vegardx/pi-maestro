// The canned end-to-end scenario, as data both drivers consume. It mirrors the
// manual dogfood plan (`dogfood-prompt.md`): a "sandbox-features" plan whose
// deliverables exercise the load-bearing paths — parallel work, a review agent,
// a dependency, and stacked PRs.
//
// The scripted driver plays `steps` in order; the LLM-driver is handed the same
// `planPrompt` and `expected` outcomes and decides its own prompts. Both assert
// against `expected`.

export interface ExpectedDeliverable {
	/** A distinctive substring of the deliverable's title, for matching state. */
	readonly titleMatch: string;
	/** Files the shipped diff must contain (repo-relative). */
	readonly files: string[];
}

export interface Scenario {
	readonly name: string;
	/** The prompt that creates the plan (fed after entering plan mode). */
	readonly planPrompt: string;
	/** Ordered driver prompts for the scripted runner. */
	readonly steps: ScenarioStep[];
	/** Outcomes the assertions verify once the run settles. */
	readonly expected: ExpectedDeliverable[];
}

export interface ScenarioStep {
	/** Human label for logs. */
	readonly label: string;
	/** The prompt/command text to send. */
	readonly prompt: string;
	/** How to deliver it if the agent is mid-stream (default: plain prompt). */
	readonly behavior?: "steer" | "followUp";
}

/**
 * A deliberately small plan: two tiny parallel modules, a review agent on one,
 * and a dependent module that stacks on both. Small enough to run cheaply,
 * broad enough to exercise the gate + stacked-PR + forward-summary machinery.
 */
export const SANDBOX_FEATURES: Scenario = {
	name: "sandbox-features",
	planPrompt: [
		'Create a plan called "sandbox-features" for this repo.',
		"",
		"Deliverables:",
		"",
		"1. [parallel] `Add statistics module` — Create `src/stats.ts` exporting",
		"   `mean(numbers: number[]): number` (throw on empty) and",
		"   `median(numbers: number[]): number`. Add `tests/stats.test.ts`.",
		"",
		"2. [parallel] `Add validation utilities` — Create `src/validate.ts`",
		"   exporting `isPositive(n: number): boolean` and",
		"   `assertInRange(n: number, min: number, max: number): void` (throws",
		"   RangeError). Add `tests/validate.test.ts`. Add a `security-audit`",
		"   review agent focused on NaN/Infinity edge cases.",
		"",
		"3. [depends on #1 and #2] `Add advanced math` — Create `src/advanced.ts`",
		"   exporting `standardDeviation(numbers: number[]): number` (uses mean)",
		"   and `clampToRange(value, min, max)` (uses assertInRange). Add",
		"   `tests/advanced.test.ts`. This stacks on #1 and #2.",
	].join("\n"),
	steps: [
		{ label: "enter plan mode", prompt: "/plan" },
		{ label: "describe the plan", prompt: "__PLAN_PROMPT__" },
		{ label: "enter execution", prompt: "/start" },
	],
	expected: [
		{
			titleMatch: "statistics",
			files: ["src/stats.ts", "tests/stats.test.ts"],
		},
		{
			titleMatch: "validation",
			files: ["src/validate.ts", "tests/validate.test.ts"],
		},
		{
			titleMatch: "advanced",
			files: ["src/advanced.ts", "tests/advanced.test.ts"],
		},
	],
};

/** Resolve `__PLAN_PROMPT__` placeholders against the scenario's planPrompt. */
export function resolveSteps(scenario: Scenario): ScenarioStep[] {
	return scenario.steps.map((s) =>
		s.prompt === "__PLAN_PROMPT__" ? { ...s, prompt: scenario.planPrompt } : s,
	);
}
