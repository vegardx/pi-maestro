import { describe, expect, it } from "vitest";
import type { Plan } from "../packages/maestro/src/plan.js";
import { compilePlanWorkflow } from "../packages/maestro/src/workflow/plan-compiler.js";

const plan: Plan = {
	slug: "ship-api",
	title: "Ship API",
	repos: [{ key: "api", path: "/repos/api" }],
	deliverables: [
		{
			id: "api",
			title: "Implement API",
			body: "Preserve the public contract.",
			repo: "api",
			after: [],
			reads: [],
			tasks: [
				{ id: "implement", title: "Implement endpoint" },
				{
					id: "correctness",
					title: "Review correctness",
					by: {
						lens: "correctness",
						model: "anthropic/claude-sonnet",
						skill: "correctness-review",
					},
				},
			],
		},
	],
};

const options = {
	model: "openai/gpt-5",
	launchCwd: "/repos",
	repositories: [{ key: "api", path: "/repos/api", branch: "feat/api" }],
} as const;

describe("thin workflow plan compiler", () => {
	it("compiles implementation, review, and fix into one workflow", () => {
		const compiled = compilePlanWorkflow(plan, options);
		const stages = compiled.workflow.artifactGraph.stages;
		expect(stages.map(({ id }) => id)).toEqual([
			"api--implement",
			"api--review--correctness",
			"api--fix",
		]);
		expect(stages[0]).toMatchObject({
			model: "openai/gpt-5",
			readOnly: false,
		});
		expect(stages[0]?.prompt).toContain("Commit your implementation");
		expect(stages[1]).toMatchObject({
			after: "api--implement",
			model: "anthropic/claude-sonnet",
			readOnly: true,
		});
		expect(stages[1]?.prompt).toContain("correctness-review");
		expect(stages[1]?.prompt).toContain("suggested change");
		expect(stages[1]?.tools).not.toContain("bash");
		expect(stages[2]).toMatchObject({
			type: "reduce",
			from: ["api--review--correctness"],
			readOnly: false,
		});
		expect(stages[2]?.prompt).toContain("new conventional follow-up commit");
	});

	it("finishes all repository implementations before review and runs one fixer", () => {
		const second = {
			...plan.deliverables[0]!,
			id: "docs",
			title: "Update docs",
			after: ["api"],
			tasks: [
				{ id: "implement-docs", title: "Update docs" },
				{
					id: "review-docs",
					title: "Review docs",
					by: {
						lens: "correctness",
						model: "anthropic/claude-sonnet",
					},
				},
			],
		};
		const compiled = compilePlanWorkflow(
			{ ...plan, deliverables: [plan.deliverables[0]!, second] },
			options,
		);
		const stages = compiled.workflow.artifactGraph.stages;
		expect(
			stages.find(({ id }) => id === "api--review--correctness")?.after,
		).toBe("docs--implement");
		expect(
			stages.find(({ id }) => id === "docs--review--review-docs")?.after,
		).toBe("docs--implement");
		expect(stages.filter(({ id }) => id.endsWith("--fix"))).toHaveLength(1);
		expect(stages.find(({ id }) => id === "api--fix")?.from).toEqual([
			"api--review--correctness",
			"docs--review--review-docs",
		]);
	});

	it("keeps publication at the interactive seat", () => {
		const compiled = compilePlanWorkflow(plan, options);
		expect(compiled.approvalText).toContain(
			"only the interactive seat publishes branches and pull requests",
		);
		expect(compiled.workflow.artifactGraph.stages[0]?.prompt).toContain(
			"Do not amend existing commits, push, or create a pull request.",
		);
	});

	it("requires the checked-out branch in repository metadata", () => {
		expect(() =>
			compilePlanWorkflow(plan, {
				...options,
				repositories: [{ key: "api", path: "/repos/api", branch: "" }],
			}),
		).toThrow(/branch metadata/);
	});
});
