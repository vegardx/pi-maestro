import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@vegardx/pi-git";
import type { PrMetadata } from "@vegardx/pi-github";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupWorktrees,
	defaultShipGit,
	deliverableRepoKey,
	type PrClient,
	prNumberFromUrl,
	reconcileShippedDeliverables,
	repoFor,
	type ShipGit,
	shipBaseBranch,
	shipDeliverable,
} from "../packages/modes/src/exec/shipper.js";
import type { Deliverable, Plan } from "../packages/modes/src/schema.js";

// ─── Builders ────────────────────────────────────────────────────────────────

const NOW = "2026-01-01T00:00:00.000Z";

function makeDeliverable(
	overrides: Partial<Deliverable> & { id: string; repo?: string },
): Deliverable {
	return {
		type: "deliverable",
		title: `Deliverable ${overrides.id}`,
		body: `Ships ${overrides.id}.`,
		status: "complete",
		worker: { mode: "full" },
		agents: [],
		tasks: [
			{
				type: "work-item",
				id: `${overrides.id}-t1`,
				title: `Task for ${overrides.id}`,
				body: "",
				done: true,
				createdAt: NOW,
				updatedAt: NOW,
			},
		],
		branch: `feat/${overrides.id}`,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function makePlan(
	deliverables: Deliverable[],
	overrides: Partial<Plan> = {},
): Plan {
	return {
		slug: "test-plan",
		title: "Test Plan",
		repoPath: "/repos/app",
		deliverables,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function makePr(overrides: Partial<PrMetadata> = {}): PrMetadata {
	return {
		number: 1,
		title: "",
		body: "",
		state: "OPEN",
		url: `https://github.com/o/r/pull/${overrides.number ?? 1}`,
		baseRefName: "main",
		headRefName: "feat/x",
		mergeable: "MERGEABLE",
		isCrossRepository: false,
		maintainerCanModify: true,
		headRepositoryNameWithOwner: "o/r",
		headRepositoryOwnerLogin: "o",
		...overrides,
	};
}

// ─── Recording fakes ─────────────────────────────────────────────────────────

interface PrCalls {
	found: { cwd: string; branch: string }[];
	viewed: { cwd: string; number: number }[];
	created: { cwd: string; title: string; body: string; base?: string }[];
	edited: {
		cwd: string;
		number: number;
		title?: string;
		body?: string;
		base?: string;
	}[];
}

function recordingPrClient(
	opts: {
		/** branch → open PR returned by findOpenPr. */
		open?: Record<string, PrMetadata>;
		/** number → PR returned by viewPr. */
		byNumber?: Record<number, PrMetadata>;
	} = {},
): { client: PrClient; calls: PrCalls } {
	const calls: PrCalls = { found: [], viewed: [], created: [], edited: [] };
	let next = 100;
	const client: PrClient = {
		findOpenPr: async (cwd, branch) => {
			calls.found.push({ cwd, branch });
			return { pr: opts.open?.[branch] ?? null };
		},
		viewPr: async (cwd, number) => {
			calls.viewed.push({ cwd, number });
			const pr = opts.byNumber?.[number] ?? null;
			return pr ? { pr } : { pr: null, error: `no PR #${number}` };
		},
		createPr: async (cwd, args) => {
			calls.created.push({ cwd, ...args });
			return { url: `https://github.com/o/r/pull/${next++}` };
		},
		editPr: async (cwd, number, args) => {
			calls.edited.push({ cwd, number, ...args });
			return { ok: true };
		},
	};
	return { client, calls };
}

function fakeGit(overrides: Partial<ShipGit> = {}): {
	git: ShipGit;
	pushes: { cwd: string; branch: string }[];
	removals: { repoPath: string; targetPath: string }[];
} {
	const pushes: { cwd: string; branch: string }[] = [];
	const removals: { repoPath: string; targetPath: string }[] = [];
	const git: ShipGit = {
		workingTreeClean: () => true,
		detectDefaultBranch: () => "main",
		pushBranch: async (cwd, branch) => {
			pushes.push({ cwd, branch });
			return { ok: true, stdout: "", stderr: "", exitCode: 0 };
		},
		removeWorktree: (repoPath, targetPath) => {
			removals.push({ repoPath, targetPath });
			return { ok: true };
		},
		...overrides,
	};
	return { git, pushes, removals };
}

// ─── Real git fixture ────────────────────────────────────────────────────────

let dir: string;
let origin: string;
let repo: string;

function git(args: string[], cwd = repo): string {
	const r = runCommand("git", args, { cwd });
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

function initRemoteAndClone(): void {
	dir = mkdtempSync(join(tmpdir(), "maestro-shipper-"));
	origin = join(dir, "origin.git");
	mkdirSync(origin);
	git(["init", "--bare", "-b", "main"], origin);
	repo = join(dir, "repo");
	mkdirSync(repo);
	git(["init", "-b", "main"], repo);
	git(["config", "user.name", "Test"]);
	git(["config", "user.email", "test@example.com"]);
	git(["remote", "add", "origin", `file://${origin}`]);
	writeFileSync(join(repo, "README.md"), "# repo\n");
	git(["add", "README.md"]);
	git(["commit", "-m", "chore: init"]);
	git(["push", "-u", "origin", "main"]);
}

function remoteHasBranch(branch: string): boolean {
	return git(["ls-remote", "origin", `refs/heads/${branch}`]).trim().length > 0;
}

// ─── shipDeliverable against a real remote ─────────────────────────────────────────

describe("shipDeliverable (real push)", () => {
	beforeEach(initRemoteAndClone);
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("pushes the branch and creates a PR on the detected default branch", async () => {
		git(["checkout", "-b", "feat/g1"]);
		writeFileSync(join(repo, "g1.txt"), "work\n");
		git(["add", "g1.txt"]);
		git(["commit", "-m", "feat: g1"]);

		const deliverable = makeDeliverable({
			id: "g1",
			summary: "Did the g1 work.",
		});
		const plan = makePlan([deliverable], { repoPath: repo });
		const { client, calls } = recordingPrClient();

		const result = await shipDeliverable({
			plan,
			deliverable,
			worktreePath: repo,
			prClient: client,
		});

		expect(result).toMatchObject({
			ok: true,
			prNumber: 100,
			base: "main",
			created: true,
		});
		if (result.ok) expect(result.prUrl).toContain("/pull/100");
		expect(remoteHasBranch("feat/g1")).toBe(true);
		expect(calls.created).toHaveLength(1);
		expect(calls.created[0]).toMatchObject({
			cwd: repo,
			title: "Deliverable g1",
			base: "main",
		});
		expect(calls.created[0].body).toContain("Ships g1.");
		expect(calls.created[0].body).toContain("- [x] Task for g1");
		expect(calls.created[0].body).toContain("Did the g1 work.");
	});

	it("blocks non-conventional commits in a semantic-release repo — no push", async () => {
		// Regression: a worker pushed "Add RadicalAI production and SIT provider
		// configs" to a semantic-release repo; the release ran green and
		// published nothing. The audit must stop the branch BEFORE push, while
		// it is still rewritable, and explain the release impact.
		writeFileSync(join(repo, ".releaserc"), "{}");
		git(["add", ".releaserc"]);
		git(["commit", "-m", "chore: add releaserc"]);
		git(["push", "origin", "main"]);
		git(["checkout", "-b", "feat/g1"]);
		writeFileSync(join(repo, "provider.ts"), "export const x = 1;\n");
		git(["add", "provider.ts"]);
		git(["commit", "-m", "Add RadicalAI production and SIT provider configs"]);

		const deliverable = makeDeliverable({ id: "g1" });
		const plan = makePlan([deliverable], { repoPath: repo });
		const { client, calls } = recordingPrClient();

		const result = await shipDeliverable({
			plan,
			deliverable,
			worktreePath: repo,
			prClient: client,
		});

		expect(result).toMatchObject({ ok: false, code: "commit-policy" });
		if (!result.ok) {
			expect(result.message).toContain("release nothing");
			expect(result.message).toContain(
				"Add RadicalAI production and SIT provider configs",
			);
			expect(result.retryable).toBe(true);
		}
		expect(remoteHasBranch("feat/g1")).toBe(false); // never left the machine
		expect(calls.created).toHaveLength(0);
	});

	it("blocks a runtime change with no release-triggering commit", async () => {
		writeFileSync(join(repo, ".releaserc"), "{}");
		git(["add", ".releaserc"]);
		git(["commit", "-m", "chore: add releaserc"]);
		git(["push", "origin", "main"]);
		git(["checkout", "-b", "feat/g1"]);
		writeFileSync(join(repo, "provider.ts"), "export const x = 1;\n");
		git(["add", "provider.ts"]);
		git(["commit", "-m", "chore(radicalai): add provider configs"]);

		const deliverable = makeDeliverable({ id: "g1" });
		const plan = makePlan([deliverable], { repoPath: repo });
		const { client } = recordingPrClient();

		const result = await shipDeliverable({
			plan,
			deliverable,
			worktreePath: repo,
			prClient: client,
		});
		expect(result).toMatchObject({ ok: false, code: "commit-policy" });
		if (!result.ok) expect(result.message).toContain("publish nothing");
	});

	it("ships conventional feat commits in a semantic-release repo", async () => {
		writeFileSync(join(repo, ".releaserc"), "{}");
		git(["add", ".releaserc"]);
		git(["commit", "-m", "chore: add releaserc"]);
		git(["push", "origin", "main"]);
		git(["checkout", "-b", "feat/g1"]);
		writeFileSync(join(repo, "provider.ts"), "export const x = 1;\n");
		git(["add", "provider.ts"]);
		git([
			"commit",
			"-m",
			"feat(radicalai): support production and SIT providers",
		]);

		const deliverable = makeDeliverable({ id: "g1" });
		const plan = makePlan([deliverable], { repoPath: repo });
		const { client } = recordingPrClient();

		const result = await shipDeliverable({
			plan,
			deliverable,
			worktreePath: repo,
			prClient: client,
		});
		expect(result).toMatchObject({ ok: true, created: true });
		expect(remoteHasBranch("feat/g1")).toBe(true);
	});

	it("refuses to ship a dirty worktree — no push, no PR", async () => {
		git(["checkout", "-b", "feat/g2"]);
		writeFileSync(join(repo, "uncommitted.txt"), "wip\n");

		const deliverable = makeDeliverable({ id: "g2" });
		const plan = makePlan([deliverable], { repoPath: repo });
		const { client, calls } = recordingPrClient();

		const result = await shipDeliverable({
			plan,
			deliverable,
			worktreePath: repo,
			prClient: client,
		});

		expect(result).toMatchObject({
			ok: false,
			code: "dirty-worktree",
			retryable: true,
		});
		expect(remoteHasBranch("feat/g2")).toBe(false);
		expect(calls.found).toHaveLength(0);
		expect(calls.created).toHaveLength(0);
	});

	it("updates an existing open PR instead of creating a new one", async () => {
		git(["checkout", "-b", "feat/g3"]);
		writeFileSync(join(repo, "g3.txt"), "work\n");
		git(["add", "g3.txt"]);
		git(["commit", "-m", "feat: g3"]);

		const deliverable = makeDeliverable({ id: "g3" });
		const plan = makePlan([deliverable], { repoPath: repo });
		const { client, calls } = recordingPrClient({
			open: {
				"feat/g3": makePr({ number: 7, baseRefName: "main" }),
			},
		});

		const result = await shipDeliverable({
			plan,
			deliverable,
			worktreePath: repo,
			prClient: client,
		});

		expect(result).toMatchObject({
			ok: true,
			prNumber: 7,
			base: "main",
			created: false,
		});
		expect(calls.created).toHaveLength(0);
		expect(calls.edited).toHaveLength(1);
		expect(calls.edited[0].number).toBe(7);
		expect(calls.edited[0].body).toContain("- [x] Task for g3");
	});

	it("returns a retryable push-failed error when the remote is unreachable", async () => {
		git(["checkout", "-b", "feat/g4"]);
		writeFileSync(join(repo, "g4.txt"), "work\n");
		git(["add", "g4.txt"]);
		git(["commit", "-m", "feat: g4"]);
		git(["remote", "set-url", "origin", join(dir, "nowhere.git")]);

		const deliverable = makeDeliverable({ id: "g4" });
		const plan = makePlan([deliverable], { repoPath: repo });
		const { client, calls } = recordingPrClient();

		const result = await shipDeliverable({
			plan,
			deliverable,
			worktreePath: repo,
			prClient: client,
		});

		expect(result).toMatchObject({
			ok: false,
			code: "push-failed",
			retryable: true,
		});
		expect(calls.created).toHaveLength(0);
	});
});

// ─── Stacked bases + multi-repo ──────────────────────────────────────────────

describe("stacked bases", () => {
	it("ships an A←B←C chain with each PR based on its predecessor", async () => {
		const a = makeDeliverable({ id: "a", status: "shipped" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"], status: "shipped" });
		const c = makeDeliverable({ id: "c", dependsOn: ["b"] });
		const plan = makePlan([a, b, c]);
		const { client, calls } = recordingPrClient();
		const { git, pushes } = fakeGit();

		for (const deliverable of [a, b, c]) {
			const result = await shipDeliverable({
				plan,
				deliverable,
				worktreePath: `/wt/${deliverable.id}`,
				prClient: client,
				git,
			});
			expect(result.ok).toBe(true);
		}

		expect(pushes.map((p) => p.branch)).toEqual(["feat/a", "feat/b", "feat/c"]);
		expect(calls.created.map((c) => c.base)).toEqual([
			"main",
			"feat/a",
			"feat/b",
		]);
	});

	it("bases an unstacked dependent on the default branch", () => {
		const a = makeDeliverable({ id: "a" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"], stacked: false });
		const plan = makePlan([a, b]);
		expect(shipBaseBranch(plan, b, "main")).toBe("main");
	});

	it("treats cross-repo dependsOn as ordering-only", async () => {
		const lib = makeDeliverable({ id: "lib-x", repo: "lib" });
		const app = makeDeliverable({ id: "app-y", dependsOn: ["lib-x"] });
		const plan = makePlan([lib, app], {
			repoPath: "/repos/app",
			repos: [{ key: "lib", path: "/repos/lib", defaultBranch: "trunk" }],
		});
		const { client, calls } = recordingPrClient();
		const { git } = fakeGit({
			detectDefaultBranch: (cwd) => (cwd === "/repos/lib" ? "trunk" : "main"),
		});

		const shippedLib = await shipDeliverable({
			plan,
			deliverable: lib,
			worktreePath: "/wt/lib-x",
			prClient: client,
			git,
		});
		const shippedApp = await shipDeliverable({
			plan,
			deliverable: app,
			worktreePath: "/wt/app-y",
			prClient: client,
			git,
		});

		expect(shippedLib).toMatchObject({ ok: true, base: "trunk" });
		// app-y depends on lib-x, but in another repo: base is app's own default.
		expect(shippedApp).toMatchObject({ ok: true, base: "main" });
		expect(calls.created.map((c) => c.base)).toEqual(["trunk", "main"]);
	});

	it("errors when the default branch cannot be detected", async () => {
		const deliverable = makeDeliverable({ id: "g" });
		const plan = makePlan([deliverable]);
		const { client } = recordingPrClient();
		const { git } = fakeGit({ detectDefaultBranch: () => null });

		const result = await shipDeliverable({
			plan,
			deliverable,
			worktreePath: "/wt/g",
			prClient: client,
			git,
		});
		expect(result).toMatchObject({ ok: false, code: "no-default-branch" });
	});
});

describe("repo resolution", () => {
	it("resolves the plan default repo and registry entries", () => {
		const app = makeDeliverable({ id: "a" });
		const lib = makeDeliverable({ id: "b", repo: "lib" });
		const plan = makePlan([app, lib], {
			repos: [{ key: "lib", path: "/repos/lib" }],
		});
		expect(deliverableRepoKey(app)).toBe("default");
		expect(repoFor(plan, app)).toMatchObject({ path: "/repos/app" });
		expect(repoFor(plan, lib)).toMatchObject({
			key: "lib",
			path: "/repos/lib",
		});
	});

	it("parses PR numbers from gh URLs", () => {
		expect(prNumberFromUrl("https://github.com/o/r/pull/42")).toBe(42);
		expect(prNumberFromUrl("https://github.com/o/r")).toBeNull();
	});
});

// ─── Retarget / reconcile ────────────────────────────────────────────────────

describe("reconcileShippedDeliverables", () => {
	function stackedPlan(): { a: Deliverable; b: Deliverable; plan: Plan } {
		const a = makeDeliverable({ id: "a", status: "shipped", prNumber: 1 });
		const b = makeDeliverable({
			id: "b",
			status: "shipped",
			prNumber: 2,
			dependsOn: ["a"],
		});
		return { a, b, plan: makePlan([a, b]) };
	}

	it("retargets a PR to the default branch once its base PR merges", async () => {
		const { plan } = stackedPlan();
		const { client, calls } = recordingPrClient({
			byNumber: {
				1: makePr({ number: 1, state: "MERGED", headRefName: "feat/a" }),
				2: makePr({ number: 2, state: "OPEN", baseRefName: "feat/a" }),
			},
		});
		const { git } = fakeGit();

		const report = await reconcileShippedDeliverables({
			plan,
			prClient: client,
			git,
		});

		expect(report.retargeted).toEqual([
			{ deliverableId: "b", prNumber: 2, from: "feat/a", to: "main" },
		]);
		expect(report.needsRebase).toEqual([]);
		expect(report.errors).toEqual([]);
		expect(calls.edited).toEqual([
			{ cwd: "/repos/app", number: 2, base: "main" },
		]);
	});

	it("leaves the PR alone while its base PR is still open", async () => {
		const { plan } = stackedPlan();
		const { client, calls } = recordingPrClient({
			byNumber: {
				1: makePr({ number: 1, state: "OPEN", headRefName: "feat/a" }),
				2: makePr({ number: 2, state: "OPEN", baseRefName: "feat/a" }),
			},
		});

		const report = await reconcileShippedDeliverables({
			plan,
			prClient: client,
			git: fakeGit().git,
		});
		expect(report.retargeted).toEqual([]);
		expect(calls.edited).toEqual([]);
	});

	it("ignores PRs already based on the default branch", async () => {
		const { plan } = stackedPlan();
		const { client, calls } = recordingPrClient({
			byNumber: {
				1: makePr({ number: 1, state: "MERGED" }),
				2: makePr({ number: 2, state: "OPEN", baseRefName: "main" }),
			},
		});

		const report = await reconcileShippedDeliverables({
			plan,
			prClient: client,
			git: fakeGit().git,
		});
		expect(report.retargeted).toEqual([]);
		expect(calls.edited).toEqual([]);
	});

	it("flags a conflicting retargeted PR as needs-rebase, never resolving it", async () => {
		const { plan } = stackedPlan();
		const { client, calls } = recordingPrClient({
			byNumber: {
				1: makePr({ number: 1, state: "MERGED" }),
				2: makePr({
					number: 2,
					state: "OPEN",
					baseRefName: "feat/a",
					mergeable: "CONFLICTING",
				}),
			},
		});

		const report = await reconcileShippedDeliverables({
			plan,
			prClient: client,
			git: fakeGit().git,
		});
		expect(report.retargeted).toHaveLength(1);
		expect(report.needsRebase).toEqual([
			{
				deliverableId: "b",
				prNumber: 2,
				base: "main",
				message: expect.stringContaining("rebase required"),
			},
		]);
		// Exactly one edit — the retarget. No rebase or force-push attempts.
		expect(calls.edited).toHaveLength(1);
	});

	it("skips deliverables that are not shipped or have no PR", async () => {
		const a = makeDeliverable({ id: "a", status: "complete", prNumber: 1 });
		const b = makeDeliverable({ id: "b", status: "shipped" });
		const plan = makePlan([a, b]);
		const { client, calls } = recordingPrClient();

		const report = await reconcileShippedDeliverables({
			plan,
			prClient: client,
			git: fakeGit().git,
		});
		expect(report).toEqual({ retargeted: [], needsRebase: [], errors: [] });
		expect(calls.viewed).toEqual([]);
	});
});

// ─── DAG-driven worktree cleanup ─────────────────────────────────────────────

describe("cleanupWorktrees", () => {
	it("retains a shipped deliverable's worktree while a dependent is unshipped", () => {
		const a = makeDeliverable({
			id: "a",
			status: "shipped",
			worktreePath: "/wt/a",
		});
		const b = makeDeliverable({
			id: "b",
			status: "active",
			dependsOn: ["a"],
			worktreePath: "/wt/b",
		});
		const plan = makePlan([a, b]);
		const { git, removals } = fakeGit();

		const report = cleanupWorktrees({ plan, git });

		expect(report.removed).toEqual([]);
		expect(report.retained).toEqual([
			{
				deliverableId: "a",
				path: "/wt/a",
				reason: expect.stringContaining("`b` is active"),
			},
		]);
		// b is active — not a candidate at all, so no removal was attempted.
		expect(removals).toEqual([]);
	});

	it("removes worktrees once the DAG has no unshipped dependents", () => {
		const a = makeDeliverable({
			id: "a",
			status: "shipped",
			worktreePath: "/wt/a",
		});
		const b = makeDeliverable({
			id: "b",
			status: "shipped",
			dependsOn: ["a"],
			worktreePath: "/wt/b",
		});
		const c = makeDeliverable({
			id: "c",
			status: "abandoned",
			dependsOn: ["b"],
			worktreePath: "/wt/c",
		});
		const plan = makePlan([a, b, c]);
		const { git, removals } = fakeGit();

		const report = cleanupWorktrees({ plan, git });

		expect(report.removed.map((r) => r.deliverableId)).toEqual(["a", "b", "c"]);
		expect(report.retained).toEqual([]);
		expect(removals.map((r) => r.targetPath)).toEqual([
			"/wt/a",
			"/wt/b",
			"/wt/c",
		]);
	});

	it("retains a worktree the removal refuses (dirty) with the reason", () => {
		const a = makeDeliverable({
			id: "a",
			status: "shipped",
			worktreePath: "/wt/a",
		});
		const plan = makePlan([a]);
		const { git } = fakeGit({
			removeWorktree: () => ({
				ok: false,
				error: "worktree /wt/a has uncommitted changes",
				reason: "dirty",
			}),
		});

		const report = cleanupWorktrees({ plan, git });
		expect(report.removed).toEqual([]);
		expect(report.retained).toEqual([
			{
				deliverableId: "a",
				path: "/wt/a",
				reason: "worktree /wt/a has uncommitted changes",
			},
		]);
	});

	it("removes a real worktree from disk", () => {
		initRemoteAndClone();
		try {
			const wt = join(dir, "wt-g1");
			git(["worktree", "add", "-b", "feat/g1", wt, "main"]);
			expect(existsSync(wt)).toBe(true);

			const deliverable = makeDeliverable({
				id: "g1",
				status: "shipped",
				worktreePath: wt,
			});
			const plan = makePlan([deliverable], { repoPath: repo });

			const report = cleanupWorktrees({ plan, git: defaultShipGit });
			expect(report.removed).toEqual([{ deliverableId: "g1", path: wt }]);
			expect(existsSync(wt)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
