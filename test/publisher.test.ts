import { describe, expect, it, vi } from "vitest";
import type { Plan } from "../packages/maestro/src/plan.js";
import {
	type PublisherOperations,
	publishPlan,
} from "../packages/maestro/src/publisher.js";

const plan: Plan = {
	slug: "ship-api",
	title: "Ship API",
	repos: [{ key: "api", path: "/repos/api" }],
	deliverables: [
		{
			id: "api",
			title: "Implement API",
			body: "Preserve compatibility.",
			repo: "api",
			after: [],
			reads: [],
			tasks: [{ id: "implement", title: "Implement endpoint" }],
		},
	],
};

function operations(): PublisherOperations {
	return {
		currentBranch: () => "feat/api",
		detectDefaultBranch: () => "main",
		workingTreeClean: () => true,
		headSha: () => "b".repeat(40),
		revParse: () => "a".repeat(40),
		isAncestor: () => true,
		pushBranch: vi.fn(async () => ({
			ok: true,
			stdout: "",
			stderr: "",
			exitCode: 0,
		})) as never,
		findOpenPr: vi.fn(async () => ({ pr: null })),
		createPr: vi.fn(async () => ({ url: "https://example.test/pr/1" })),
		editPr: vi.fn(async () => ({ ok: true })),
	};
}

describe("plan publisher", () => {
	it("pushes committed feature branches and creates plan-derived PRs", async () => {
		const ops = operations();
		await expect(
			publishPlan({
				plan,
				repositories: [{ key: "api", path: "/repos/api" }],
				operations: ops,
			}),
		).resolves.toEqual([
			{ key: "api", branch: "feat/api", url: "https://example.test/pr/1" },
		]);
		expect(ops.pushBranch).toHaveBeenCalledWith("/repos/api", "feat/api");
		expect(ops.createPr).toHaveBeenCalledWith(
			"/repos/api",
			expect.objectContaining({
				title: "Ship API",
				base: "main",
				body: expect.stringContaining("Implement endpoint"),
			}),
		);
	});

	it("refuses default branches and dirty worktrees before push", async () => {
		const onDefault = operations();
		onDefault.currentBranch = () => "main";
		await expect(
			publishPlan({
				plan,
				repositories: [{ key: "api", path: "/repos/api" }],
				operations: onDefault,
			}),
		).rejects.toThrow(/default branch/);

		const dirty = operations();
		dirty.workingTreeClean = () => false;
		await expect(
			publishPlan({
				plan,
				repositories: [{ key: "api", path: "/repos/api" }],
				operations: dirty,
			}),
		).rejects.toThrow(/not clean/);
	});
});
