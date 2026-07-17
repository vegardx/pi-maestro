// /recover's reality check: the plan's claimed statuses are verified against
// worktrees, branches, remote branches, and PRs before anything resumes.

import { describe, expect, it } from "vitest";
import { auditPlan, renderAudit } from "../packages/modes/src/exec/recovery.js";
import type { Deliverable, Plan } from "../packages/modes/src/schema.js";

function makeDeliverable(overrides: Partial<Deliverable>): Deliverable {
	return {
		type: "deliverable",
		id: "d",
		title: "D",
		body: "",
		status: "planned",
		worker: { mode: "full" },
		agents: [],
		tasks: [],
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
		...overrides,
	};
}

function makePlan(deliverables: Deliverable[]): Plan {
	return {
		schemaVersion: 5,
		slug: "p",
		title: "P",
		repoPath: "/repo",
		deliverables,
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
	};
}

const allGood = {
	pathExists: () => true,
	refExists: () => true,
	treeClean: () => true,
	prState: async () => "MERGED",
};

describe("auditPlan", () => {
	it("skips planned/abandoned/superseded — nothing on disk to verify", async () => {
		const plan = makePlan([
			makeDeliverable({ id: "a", status: "planned" }),
			makeDeliverable({ id: "b", status: "abandoned" }),
		]);
		const audit = await auditPlan(plan, allGood);
		expect(audit.entries).toEqual([]);
		expect(renderAudit(audit)).toContain("Nothing to verify");
	});

	it("active: verifies workspace + resumable session file", async () => {
		const plan = makePlan([
			makeDeliverable({
				id: "auth",
				status: "active",
				branch: "feat/auth",
				worktreePath: "/wt/auth",
				sessionPath: "/sessions/auth.jsonl",
			}),
		]);
		const audit = await auditPlan(plan, allGood);
		expect(audit.problems).toBe(0);
		expect(audit.entries[0].notes).toContain("✓ worktree present");
		expect(audit.entries[0].notes).toContain(
			"✓ worker session file — resumable",
		);
	});

	it("complete with a dirty tree or missing branch is a problem", async () => {
		const plan = makePlan([
			makeDeliverable({
				id: "auth",
				status: "complete",
				branch: "feat/auth",
				worktreePath: "/wt/auth",
			}),
		]);
		const audit = await auditPlan(plan, {
			...allGood,
			treeClean: () => false,
			refExists: () => false,
		});
		expect(audit.problems).toBe(1);
		expect(audit.entries[0].problem).toContain("uncommitted changes");
		expect(audit.entries[0].problem).toContain("branch feat/auth not found");
	});

	it("shipped: a CLOSED (unmerged) PR is a problem; MERGED is fine", async () => {
		const plan = makePlan([
			makeDeliverable({
				id: "auth",
				status: "shipped",
				branch: "feat/auth",
				prNumber: 12,
				prUrl: "https://github.com/o/r/pull/12",
			}),
			makeDeliverable({
				id: "api",
				status: "shipped",
				branch: "feat/api",
				prNumber: 13,
				prUrl: "https://github.com/o/r/pull/13",
			}),
		]);
		const audit = await auditPlan(plan, {
			...allGood,
			prState: async (_cwd, n) => (n === 12 ? "CLOSED" : "MERGED"),
		});
		expect(audit.problems).toBe(1);
		expect(audit.entries[0].problem).toContain(
			"PR #12 was CLOSED without merging",
		);
		expect(audit.entries[1].notes).toContain("✓ PR #13 merged");
	});

	it("shipped scratch deliverables have no PR/branch to verify", async () => {
		const plan = makePlan([
			makeDeliverable({
				id: "bootstrap",
				status: "shipped",
				workspace: "scratch",
			}),
		]);
		const audit = await auditPlan(plan, {
			...allGood,
			prState: async () => {
				throw new Error("must not be called");
			},
		});
		expect(audit.problems).toBe(0);
	});

	it("renderAudit summarizes problems for the human", async () => {
		const plan = makePlan([
			makeDeliverable({
				id: "auth",
				status: "shipped",
				branch: "feat/auth",
				prNumber: 12,
				prUrl: "u",
			}),
		]);
		const audit = await auditPlan(plan, {
			...allGood,
			prState: async () => "CLOSED",
		});
		const text = renderAudit(audit);
		expect(text).toContain("1 deliverable(s) disagree with reality");
		expect(text).toContain("✗ auth (shipped)");
	});
});
