// /verify's deep check: mechanical evidence (commits, diffs, PR diffs) is
// gathered per started deliverable, a read-only subagent judges the work
// task by task, and its VERDICT line folds back into a rendered report.

import { describe, expect, it } from "vitest";
import {
	buildVerifyPrompt,
	gatherEvidence,
	renderVerification,
	runVerification,
	verifyTargets,
} from "../packages/modes/src/exec/verify.js";
import type {
	Deliverable,
	Plan,
	WorkItem,
} from "../packages/modes/src/schema.js";

function makeTask(overrides: Partial<WorkItem>): WorkItem {
	return {
		type: "work-item",
		id: "t",
		title: "T",
		body: "",
		done: false,
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
		...overrides,
	};
}

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

/** A git fake keyed on the subcommand. */
function gitFake(responses: {
	branchExists?: boolean;
	ahead?: string;
	stat?: string;
	diff?: string;
}) {
	return (_cwd: string, args: string[]) => {
		if (args[0] === "rev-parse")
			return { ok: responses.branchExists ?? true, stdout: "" };
		if (args[0] === "rev-list")
			return { ok: true, stdout: responses.ahead ?? "3" };
		if (args.includes("--stat"))
			return { ok: true, stdout: responses.stat ?? " 1 file changed" };
		if (args[0] === "diff")
			return { ok: true, stdout: responses.diff ?? "+real change" };
		return { ok: false, stdout: "" };
	};
}

const baseDeps = {
	pathExists: () => true,
	defaultBranchFor: () => "main",
	spawn: () => ({
		id: "run-1",
		result: async () => ({
			status: "succeeded" as const,
			summary: "All tasks check out.\nVERDICT: pass",
		}),
	}),
};

describe("verifyTargets", () => {
	it("selects started deliverables; planned/abandoned are skipped", () => {
		const plan = makePlan([
			makeDeliverable({ id: "a", status: "planned" }),
			makeDeliverable({ id: "b", status: "active" }),
			makeDeliverable({ id: "c", status: "shipped" }),
		]);
		expect(verifyTargets(plan).map((g) => g.id)).toEqual(["b", "c"]);
		expect(verifyTargets(plan, "c").map((g) => g.id)).toEqual(["c"]);
		expect(verifyTargets(plan, "a")).toEqual([]);
		expect(verifyTargets(plan, "nope")).toEqual([]);
	});
});

describe("gatherEvidence", () => {
	it("complete with zero commits ahead of base is a problem", () => {
		const g = makeDeliverable({
			id: "auth",
			status: "complete",
			branch: "feat/auth",
		});
		const evidence = gatherEvidence(makePlan([g]), g, {
			...baseDeps,
			runGit: gitFake({ ahead: "0", diff: "" }),
		});
		expect(evidence.problems.join(";")).toContain("zero commits ahead");
		expect(evidence.problems.join(";")).toContain("empty diff");
	});

	it("shipped prefers the PR diff and flags an empty one", () => {
		const g = makeDeliverable({
			id: "auth",
			status: "shipped",
			branch: "feat/auth",
			prNumber: 12,
		});
		const evidence = gatherEvidence(makePlan([g]), g, {
			...baseDeps,
			runGit: gitFake({}),
			prDiff: () => "",
		});
		expect(evidence.facts.join(";")).toContain("diff source: PR #12");
		expect(evidence.problems.join(";")).toContain("empty diff");
	});

	it("missing branch on a complete deliverable means the work does not exist", () => {
		const g = makeDeliverable({
			id: "auth",
			status: "complete",
			branch: "feat/auth",
		});
		const evidence = gatherEvidence(makePlan([g]), g, {
			...baseDeps,
			runGit: gitFake({ branchExists: false }),
		});
		expect(evidence.problems.join(";")).toContain(
			"the claimed work does not exist",
		);
		expect(evidence.diff).toBeUndefined();
	});

	it("scratch deliverables inspect the workspace directory, no git", () => {
		const g = makeDeliverable({
			id: "bootstrap",
			status: "shipped",
			workspace: "scratch",
			worktreePath: "/plan/workspaces/bootstrap",
		});
		const evidence = gatherEvidence(makePlan([g]), g, {
			...baseDeps,
			runGit: () => {
				throw new Error("git must not be called for scratch");
			},
		});
		expect(evidence.cwd).toBe("/plan/workspaces/bootstrap");
		expect(evidence.problems).toEqual([]);
	});

	it("stacked deliverables diff against the parent branch, not main", () => {
		const parent = makeDeliverable({
			id: "base",
			status: "complete",
			branch: "feat/base",
		});
		const child = makeDeliverable({
			id: "child",
			status: "complete",
			branch: "feat/child",
			dependsOn: ["base"],
		});
		const seen: string[][] = [];
		gatherEvidence(makePlan([parent, child]), child, {
			...baseDeps,
			runGit: (_cwd, args) => {
				seen.push(args);
				return gitFake({})(_cwd, args);
			},
		});
		expect(
			seen.some((a) => a.join(" ").includes("feat/base..feat/child")),
		).toBe(true);
	});
});

describe("buildVerifyPrompt", () => {
	it("carries tasks, evidence, the diff, and the verdict protocol", () => {
		const g = makeDeliverable({
			id: "auth",
			title: "Auth",
			status: "complete",
			tasks: [
				makeTask({ id: "t1", title: "add login", done: true }),
				makeTask({ id: "t2", title: "add logout", done: false }),
			],
		});
		const prompt = buildVerifyPrompt(g, {
			facts: ["3 commit(s) ahead of main"],
			problems: [],
			diff: "+login()",
			cwd: "/repo",
		});
		expect(prompt).toContain("- [x] add login");
		expect(prompt).toContain("- [ ] add logout");
		expect(prompt).toContain("3 commit(s) ahead of main");
		expect(prompt).toContain("+login()");
		expect(prompt).toContain("VERDICT: pass");
		expect(prompt).toContain("VERDICT: block");
	});
});

describe("runVerification", () => {
	it("parses pass and block verdicts into entries with findings", async () => {
		const pass = makeDeliverable({
			id: "good",
			status: "shipped",
			branch: "feat/good",
			prNumber: 1,
		});
		const fail = makeDeliverable({
			id: "bad",
			status: "complete",
			branch: "feat/bad",
		});
		const plan = makePlan([pass, fail]);
		const entries = await runVerification(plan, [pass, fail], {
			...baseDeps,
			runGit: gitFake({}),
			prDiff: () => "+shipped change",
			spawn: (prompt) => ({
				id: prompt.includes("good") ? "r1" : "r2",
				result: async () =>
					prompt.includes("(good,")
						? { status: "succeeded" as const, summary: "ok\nVERDICT: pass" }
						: {
								status: "succeeded" as const,
								summary:
									"missing work\nVERDICT: block\n- src/x.ts:1 — logout is a stub",
							},
			}),
		});
		expect(entries.find((e) => e.id === "good")?.verdict).toBe("pass");
		const bad = entries.find((e) => e.id === "bad");
		expect(bad?.verdict).toBe("fail");
		expect(bad?.findings).toEqual(["src/x.ts:1 — logout is a stub"]);
	});

	it("mechanical dead ends (nothing to inspect) fail without spawning", async () => {
		const g = makeDeliverable({ id: "gone", status: "complete" });
		const plan = makePlan([g]);
		const entries = await runVerification(plan, [g], {
			...baseDeps,
			pathExists: () => false,
			spawn: () => {
				throw new Error("must not spawn");
			},
		});
		expect(entries[0].verdict).toBe("fail");
		expect(entries[0].problems.join(";")).toContain("repo path missing");
	});

	it("a verifier with no report is an error entry, not a silent pass", async () => {
		const g = makeDeliverable({
			id: "auth",
			status: "complete",
			branch: "feat/auth",
		});
		const entries = await runVerification(makePlan([g]), [g], {
			...baseDeps,
			runGit: gitFake({}),
			spawn: () => ({
				id: "r1",
				result: async () => ({ status: "failed" as const, error: "boom" }),
			}),
		});
		expect(entries[0].verdict).toBe("error");
		expect(entries[0].error).toBe("boom");
	});

	it("retries once when a verifier succeeds with no final text", async () => {
		const g = makeDeliverable({
			id: "auth",
			status: "complete",
			branch: "feat/auth",
		});
		let spawns = 0;
		const entries = await runVerification(makePlan([g]), [g], {
			...baseDeps,
			runGit: gitFake({}),
			spawn: () => {
				spawns += 1;
				const first = spawns === 1;
				return {
					id: `r${spawns}`,
					result: async () =>
						first
							? { status: "succeeded" as const, summary: "" }
							: { status: "succeeded" as const, summary: "ok\nVERDICT: pass" },
				};
			},
		});
		expect(spawns).toBe(2);
		expect(entries[0].verdict).toBe("pass");
	});

	it("no verdict line renders as inconclusive", async () => {
		const g = makeDeliverable({
			id: "auth",
			status: "complete",
			branch: "feat/auth",
		});
		const entries = await runVerification(makePlan([g]), [g], {
			...baseDeps,
			runGit: gitFake({}),
			spawn: () => ({
				id: "r1",
				result: async () => ({
					status: "succeeded" as const,
					summary: "looked around, unsure",
				}),
			}),
		});
		expect(entries[0].verdict).toBe("inconclusive");
	});
});

describe("renderVerification", () => {
	it("summarizes counts and lists findings + mechanical problems", () => {
		const text = renderVerification([
			{
				id: "good",
				title: "G",
				status: "shipped",
				verdict: "pass",
				findings: [],
				structured: [],
				problems: [],
				facts: [],
			},
			{
				id: "bad",
				title: "B",
				status: "complete",
				verdict: "fail",
				findings: ["src/x.ts:1 — stub"],
				structured: [],
				problems: ["zero commits ahead of main"],
				facts: [],
			},
		]);
		expect(text).toContain("1 pass, 1 fail");
		expect(text).toContain("✓ good (shipped)");
		expect(text).toContain("✗ bad (complete)");
		expect(text).toContain("    - src/x.ts:1 — stub");
		expect(text).toContain("    ⚠ zero commits ahead of main");
	});
});
