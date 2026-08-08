import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	WorkflowShipper,
	type WorkflowShippingInput,
	type WorkflowShippingOps,
	workflowPullRequestBody,
} from "../../../packages/maestro/src/workflow/workflow-shipping.js";

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0)
		rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "maestro-workflow-ship-"));
	roots.push(root);
	const state = join(root, "private");
	const descendants = join(root, "run");
	mkdirSync(state);
	mkdirSync(descendants);
	const api = join(descendants, "api");
	const web = join(descendants, "web");
	mkdirSync(api);
	mkdirSync(web);
	return { root, state, descendants, api, web };
}

function input(api: string, web: string): WorkflowShippingInput {
	return {
		runId: "run-1",
		repositories: [
			{
				key: "api",
				worktree: api,
				expectedBranch: "maestro/run-1/api",
				expectedFinalHead: "a".repeat(40),
				baseBranch: "main",
				pullRequest: {
					title: "Add the API",
					intent: "Expose the new operation.",
					rationale: "Clients need one stable entry point.",
					changes: ["Add the endpoint", "Document its contract"],
				},
			},
			{
				key: "web",
				worktree: web,
				expectedBranch: "maestro/run-1/web",
				expectedFinalHead: "b".repeat(40),
				baseBranch: "trunk",
				pullRequest: {
					title: "Use the API",
					intent: "Connect the interface to the new operation.",
					rationale: "This replaces the temporary local behavior.",
					changes: ["Call the API from the interface"],
				},
			},
		],
	};
}

function operations(source: WorkflowShippingInput) {
	const calls: string[] = [];
	const repositories = new Map(
		source.repositories.map((repository) => [
			realpathSync(repository.worktree),
			repository,
		]),
	);
	const ops: WorkflowShippingOps = {
		inspect: (worktree) => {
			const repository = repositories.get(worktree)!;
			calls.push(`inspect:${repository.key}`);
			return {
				branch: repository.expectedBranch,
				head: repository.expectedFinalHead,
				clean: true,
			};
		},
		pushNonForce: async (worktree, branch) => {
			calls.push(`push:${repositories.get(worktree)!.key}:${branch}`);
			return { ok: true };
		},
		findOpenPullRequest: async (worktree) => {
			calls.push(`find:${repositories.get(worktree)!.key}`);
			return null;
		},
		createPullRequest: async (worktree, request) => {
			const key = repositories.get(worktree)!.key;
			calls.push(`create:${key}:${request.base}:${request.title}`);
			return { number: key === "api" ? 41 : 42 };
		},
		updatePullRequest: async (worktree, number) => {
			calls.push(`update:${repositories.get(worktree)!.key}:${number}`);
		},
	};
	return { calls, ops };
}

describe("workflow seat shipping", () => {
	it("publishes every exact repository branch and creates one PR per repo", async () => {
		const paths = fixture();
		const request = input(paths.api, paths.web);
		const fake = operations(request);
		const result = await new WorkflowShipper({
			maestroStateRoot: paths.state,
			descendantWritableRoots: [paths.descendants],
			depth: () => 0,
			ops: fake.ops,
		}).ship(request);

		expect(
			result.repositories.map(({ pullRequestNumber }) => pullRequestNumber),
		).toEqual([41, 42]);
		expect(fake.calls).toEqual([
			"inspect:api",
			"push:api:maestro/run-1/api",
			"find:api",
			"create:api:main:Add the API",
			"inspect:web",
			"push:web:maestro/run-1/web",
			"find:web",
			"create:web:trunk:Use the API",
		]);
	});

	it("updates an existing PR with the current human-facing copy", async () => {
		const paths = fixture();
		const request = {
			...input(paths.api, paths.web),
			repositories: input(paths.api, paths.web).repositories.slice(0, 1),
		};
		const fake = operations(request);
		fake.ops.findOpenPullRequest = async () => ({ number: 17 });
		await new WorkflowShipper({
			maestroStateRoot: paths.state,
			descendantWritableRoots: [paths.descendants],
			depth: () => 0,
			ops: fake.ops,
		}).ship(request);
		expect(fake.calls).toContain("update:api:17");
		expect(fake.calls.some((call) => call.startsWith("create:"))).toBe(false);
	});

	it("resumes after a durable per-repository result without republishing it", async () => {
		const paths = fixture();
		const request = input(paths.api, paths.web);
		const fake = operations(request);
		let interrupted = false;
		const first = new WorkflowShipper({
			maestroStateRoot: paths.state,
			descendantWritableRoots: [paths.descendants],
			depth: () => 0,
			ops: fake.ops,
			onRepositoryPublished: () => {
				if (!interrupted) {
					interrupted = true;
					throw new Error("seat stopped");
				}
			},
		});
		await expect(first.ship(request)).rejects.toThrow("seat stopped");
		const beforeResume = [...fake.calls];

		const result = await new WorkflowShipper({
			maestroStateRoot: paths.state,
			descendantWritableRoots: [paths.descendants],
			depth: () => 0,
			ops: fake.ops,
		}).ship(request);

		expect(result.repositories).toHaveLength(2);
		expect(fake.calls.slice(beforeResume.length)).toEqual([
			"inspect:api",
			"inspect:web",
			"push:web:maestro/run-1/web",
			"find:web",
			"create:web:trunk:Use the API",
		]);
	});

	it("refuses a dirty, wrong-branch, or moved HEAD before any push", async () => {
		for (const actual of [
			{ branch: "other", head: "a".repeat(40), clean: true },
			{ branch: "maestro/run-1/api", head: "c".repeat(40), clean: true },
			{ branch: "maestro/run-1/api", head: "a".repeat(40), clean: false },
		]) {
			const paths = fixture();
			const request = {
				...input(paths.api, paths.web),
				repositories: input(paths.api, paths.web).repositories.slice(0, 1),
			};
			const fake = operations(request);
			fake.ops.inspect = () => actual;
			await expect(
				new WorkflowShipper({
					maestroStateRoot: paths.state,
					descendantWritableRoots: [paths.descendants],
					depth: () => 0,
					ops: fake.ops,
				}).ship(request),
			).rejects.toThrow(/expected branch|expected final HEAD|must be clean/);
			expect(fake.calls.some((call) => call.startsWith("push:"))).toBe(false);
		}
	});

	it("binds resume to the exact approved input", async () => {
		const paths = fixture();
		const request = {
			...input(paths.api, paths.web),
			repositories: input(paths.api, paths.web).repositories.slice(0, 1),
		};
		const fake = operations(request);
		const shipper = new WorkflowShipper({
			maestroStateRoot: paths.state,
			descendantWritableRoots: [paths.descendants],
			depth: () => 0,
			ops: fake.ops,
		});
		await shipper.ship(request);
		await expect(
			shipper.ship({
				...request,
				repositories: request.repositories.map((repository) => ({
					...repository,
					pullRequest: { ...repository.pullRequest, title: "Different" },
				})),
			}),
		).rejects.toThrow(/different input/);
	});

	it("serializes concurrent seats before either can create a duplicate PR", async () => {
		const paths = fixture();
		const request = input(paths.api, paths.web);
		const fake = operations(request);
		let releaseFirst!: () => void;
		let announceFirst!: () => void;
		const firstEntered = new Promise<void>((resolve) => {
			announceFirst = resolve;
		});
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const originalCreate = fake.ops.createPullRequest;
		let held = false;
		fake.ops.createPullRequest = async (worktree, copy) => {
			if (!held) {
				held = true;
				announceFirst();
				await firstReleased;
			}
			return originalCreate(worktree, copy);
		};
		const makeShipper = () =>
			new WorkflowShipper({
				maestroStateRoot: paths.state,
				descendantWritableRoots: [paths.descendants],
				depth: () => 0,
				ops: fake.ops,
			});
		const first = makeShipper().ship(request);
		await firstEntered;
		await expect(makeShipper().ship(request)).rejects.toThrow(/in progress/);
		releaseFirst();
		await expect(first).resolves.toMatchObject({ runId: "run-1" });
		expect(
			fake.calls.filter((call) => call.startsWith("create:")),
		).toHaveLength(2);
	});

	it("cannot be constructed by a descendant or with a descendant-writable journal", () => {
		const paths = fixture();
		expect(
			() =>
				new WorkflowShipper({
					maestroStateRoot: paths.state,
					descendantWritableRoots: [paths.descendants],
					depth: () => 1,
				}),
		).toThrow(/depth 0/);
		expect(
			() =>
				new WorkflowShipper({
					maestroStateRoot: paths.descendants,
					descendantWritableRoots: [paths.descendants],
					depth: () => 0,
				}),
		).toThrow(/disjoint/);
	});
});

describe("workflow pull request copy", () => {
	it("contains only intent, rationale, and changes sections", () => {
		const body = workflowPullRequestBody({
			title: "Human title",
			intent: "Make the behavior predictable.",
			rationale: "The public contract should be stable.",
			changes: ["Validate the input", "Document the contract"],
		});
		expect(body).toBe(
			"## Intent\n\nMake the behavior predictable.\n\n## Rationale\n\nThe public contract should be stable.\n\n## Changes\n- Validate the input\n- Document the contract",
		);
		expect(body).not.toMatch(/reviewer|model|finding|provenance/i);
	});
});
