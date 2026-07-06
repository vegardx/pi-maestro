import { describe, expect, it } from "vitest";
import {
	blockedReason,
	canTransition,
	defaultBranchForGroup,
	findAgent,
	findGroup,
	findTask,
	immediateAgents,
	isGroupReady,
	isLeafGroup,
	type Plan,
	pickBaseBranch,
	readyGroups,
	shippableGroups,
	slugify,
	topologicalSort,
	unblockedAgents,
	validatePlanShape,
	type WorkGroup,
} from "../packages/modes/src/schema.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGroup(overrides: Partial<WorkGroup> = {}): WorkGroup {
	return {
		type: "group",
		id: overrides.id ?? "test-group",
		title: overrides.title ?? "Test Group",
		body: overrides.body ?? "Test body",
		status: overrides.status ?? "planned",
		dependsOn: overrides.dependsOn,
		stacked: overrides.stacked,
		worker: overrides.worker ?? { mode: "full" },
		agents: overrides.agents ?? [],
		tasks: overrides.tasks ?? [
			{
				type: "work-item",
				id: "t1",
				title: "Task 1",
				body: "",
				done: false,
				createdAt: "2026-01-01",
				updatedAt: "2026-01-01",
			},
		],
		branch: overrides.branch,
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
	};
}

function makePlan(groups: WorkGroup[]): Plan {
	return {
		slug: "test-plan",
		title: "Test Plan",
		repoPath: "/tmp/repo",
		groups,
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
	};
}

// ─── State machine ───────────────────────────────────────────────────────────

describe("GroupStatus transitions", () => {
	it("allows planned → active", () => {
		expect(canTransition("planned", "active")).toBe(true);
	});

	it("allows planned → abandoned", () => {
		expect(canTransition("planned", "abandoned")).toBe(true);
	});

	it("allows active → complete", () => {
		expect(canTransition("active", "complete")).toBe(true);
	});

	it("allows complete → shipped", () => {
		expect(canTransition("complete", "shipped")).toBe(true);
	});

	it("allows complete → superseded", () => {
		expect(canTransition("complete", "superseded")).toBe(true);
	});

	it("does not allow planned → shipped", () => {
		expect(canTransition("planned", "shipped")).toBe(false);
	});

	it("does not allow shipped → anything", () => {
		expect(canTransition("shipped", "planned")).toBe(false);
		expect(canTransition("shipped", "active")).toBe(false);
		expect(canTransition("shipped", "abandoned")).toBe(false);
	});

	it("does not allow superseded → anything", () => {
		expect(canTransition("superseded", "planned")).toBe(false);
		expect(canTransition("superseded", "active")).toBe(false);
	});
});

// ─── Group readiness ─────────────────────────────────────────────────────────

describe("isGroupReady", () => {
	it("root group (no deps) is always ready", () => {
		const g = makeGroup({ dependsOn: [] });
		const plan = makePlan([g]);
		expect(isGroupReady(plan, g)).toBe(true);
	});

	it("group with unmet dep is not ready", () => {
		const a = makeGroup({ id: "a", status: "planned" });
		const b = makeGroup({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isGroupReady(plan, b)).toBe(false);
	});

	it("group with active dep is ready", () => {
		const a = makeGroup({ id: "a", status: "active" });
		const b = makeGroup({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isGroupReady(plan, b)).toBe(true);
	});

	it("group with complete dep is ready", () => {
		const a = makeGroup({ id: "a", status: "complete" });
		const b = makeGroup({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isGroupReady(plan, b)).toBe(true);
	});

	it("group with shipped dep is ready", () => {
		const a = makeGroup({ id: "a", status: "shipped" });
		const b = makeGroup({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isGroupReady(plan, b)).toBe(true);
	});

	it("group with abandoned dep is not ready", () => {
		const a = makeGroup({ id: "a", status: "abandoned" });
		const b = makeGroup({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isGroupReady(plan, b)).toBe(false);
	});

	it("already-active group is not ready", () => {
		const g = makeGroup({ status: "active", dependsOn: [] });
		const plan = makePlan([g]);
		expect(isGroupReady(plan, g)).toBe(false);
	});

	it("multiple deps — all must be satisfied", () => {
		const a = makeGroup({ id: "a", status: "active" });
		const b = makeGroup({ id: "b", status: "planned" });
		const c = makeGroup({ id: "c", dependsOn: ["a", "b"] });
		const plan = makePlan([a, b, c]);
		expect(isGroupReady(plan, c)).toBe(false);
	});
});

describe("readyGroups", () => {
	it("returns groups whose deps are met", () => {
		const a = makeGroup({ id: "a", status: "active", dependsOn: [] });
		const b = makeGroup({ id: "b", dependsOn: ["a"] });
		const c = makeGroup({ id: "c", dependsOn: [] });
		const plan = makePlan([a, b, c]);
		const ready = readyGroups(plan);
		expect(ready.map((g) => g.id)).toEqual(["b", "c"]);
	});
});

// ─── Leaf / shippable ────────────────────────────────────────────────────────

describe("isLeafGroup", () => {
	it("true when nothing depends on it", () => {
		const g = makeGroup({ id: "a" });
		const plan = makePlan([g]);
		expect(isLeafGroup(plan, g)).toBe(true);
	});

	it("false when another group depends on it", () => {
		const a = makeGroup({ id: "a" });
		const b = makeGroup({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isLeafGroup(plan, a)).toBe(false);
	});
});

describe("shippableGroups", () => {
	it("returns complete leaf groups", () => {
		const a = makeGroup({ id: "a", status: "complete" });
		const b = makeGroup({ id: "b", status: "complete", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		// a has a dependent → not shippable. b is a leaf → shippable.
		expect(shippableGroups(plan).map((g) => g.id)).toEqual(["b"]);
	});

	it("does not return non-complete groups", () => {
		const a = makeGroup({ id: "a", status: "active" });
		const plan = makePlan([a]);
		expect(shippableGroups(plan)).toEqual([]);
	});
});

// ─── Agent graph ─────────────────────────────────────────────────────────────

describe("topologicalSort", () => {
	it("worker only (no agents)", () => {
		const g = makeGroup({ agents: [] });
		expect(topologicalSort(g)).toEqual(["worker"]);
	});

	it("linear chain: worker → review → fix", () => {
		const g = makeGroup({
			agents: [
				{
					name: "review",
					mode: "read-only",
					slot: "alternate",
					effort: "high",
					focus: "security",
					after: ["worker"],
				},
				{
					name: "fix",
					mode: "full",
					slot: "default",
					effort: "low",
					focus: "apply fixes",
					after: ["review"],
				},
			],
		});
		const sorted = topologicalSort(g);
		expect(sorted.indexOf("worker")).toBeLessThan(sorted.indexOf("review"));
		expect(sorted.indexOf("review")).toBeLessThan(sorted.indexOf("fix"));
	});

	it("parallel agents (no deps on each other)", () => {
		const g = makeGroup({
			agents: [
				{
					name: "security",
					mode: "read-only",
					slot: "alternate",
					effort: "high",
					focus: "sec",
					after: ["worker"],
				},
				{
					name: "perf",
					mode: "read-only",
					slot: "default",
					effort: "low",
					focus: "perf",
					after: ["worker"],
				},
			],
		});
		const sorted = topologicalSort(g);
		expect(sorted.indexOf("worker")).toBeLessThan(sorted.indexOf("security"));
		expect(sorted.indexOf("worker")).toBeLessThan(sorted.indexOf("perf"));
	});

	it("throws on cycle", () => {
		const g = makeGroup({
			worker: { mode: "full", after: ["fix"] },
			agents: [
				{
					name: "fix",
					mode: "full",
					slot: "default",
					effort: "low",
					focus: "fix",
					after: ["worker"],
				},
			],
		});
		expect(() => topologicalSort(g)).toThrow(/cycle/);
	});

	it("pre-worker agents: worker.after = ['lint']", () => {
		const g = makeGroup({
			worker: { mode: "full", after: ["lint"] },
			agents: [
				{
					name: "lint",
					mode: "read-only",
					slot: "default",
					effort: "low",
					focus: "lint check",
					after: [],
				},
			],
		});
		const sorted = topologicalSort(g);
		expect(sorted.indexOf("lint")).toBeLessThan(sorted.indexOf("worker"));
	});
});

describe("immediateAgents", () => {
	it("worker starts first when no after", () => {
		const g = makeGroup({ agents: [] });
		expect(immediateAgents(g)).toEqual(["worker"]);
	});

	it("worker and parallel agents with empty after", () => {
		const g = makeGroup({
			agents: [
				{
					name: "lint",
					mode: "read-only",
					slot: "default",
					effort: "low",
					focus: "lint",
					after: [],
				},
			],
		});
		expect(immediateAgents(g)).toEqual(["worker", "lint"]);
	});

	it("worker delayed by after", () => {
		const g = makeGroup({
			worker: { mode: "full", after: ["lint"] },
			agents: [
				{
					name: "lint",
					mode: "read-only",
					slot: "default",
					effort: "low",
					focus: "lint",
					after: [],
				},
			],
		});
		expect(immediateAgents(g)).toEqual(["lint"]);
	});
});

describe("unblockedAgents", () => {
	it("unblocks agents when their deps complete", () => {
		const g = makeGroup({
			agents: [
				{
					name: "review",
					mode: "read-only",
					slot: "alternate",
					effort: "high",
					focus: "sec",
					after: ["worker"],
				},
				{
					name: "fix",
					mode: "full",
					slot: "default",
					effort: "low",
					focus: "fix",
					after: ["review"],
				},
			],
		});
		// Worker completes → review unblocked
		expect(unblockedAgents(g, new Set(["worker"]))).toEqual(["review"]);
		// Review completes → fix unblocked
		expect(unblockedAgents(g, new Set(["worker", "review"]))).toEqual(["fix"]);
	});

	it("unblocks worker when pre-agents complete", () => {
		const g = makeGroup({
			worker: { mode: "full", after: ["lint"] },
			agents: [
				{
					name: "lint",
					mode: "read-only",
					slot: "default",
					effort: "low",
					focus: "lint",
					after: [],
				},
			],
		});
		expect(unblockedAgents(g, new Set(["lint"]))).toEqual(["worker"]);
	});

	it("does not unblock already-completed agents", () => {
		const g = makeGroup({
			agents: [
				{
					name: "review",
					mode: "read-only",
					slot: "alternate",
					effort: "high",
					focus: "sec",
					after: ["worker"],
				},
			],
		});
		// Both already complete → nothing new
		expect(unblockedAgents(g, new Set(["worker", "review"]))).toEqual([]);
	});
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe("validatePlanShape", () => {
	it("valid plan returns no problems", () => {
		const g = makeGroup();
		const plan = makePlan([g]);
		expect(validatePlanShape(plan)).toEqual([]);
	});

	it("detects unknown dependsOn reference", () => {
		const g = makeGroup({ dependsOn: ["nonexistent"] });
		const plan = makePlan([g]);
		const problems = validatePlanShape(plan);
		expect(problems).toContain(
			"group `test-group` depends on unknown group `nonexistent`",
		);
	});

	it("detects full-mode worker with no tasks", () => {
		const g = makeGroup({ tasks: [] });
		const plan = makePlan([g]);
		const problems = validatePlanShape(plan);
		expect(problems).toContain(
			"group `test-group` has a full-mode worker but no gating tasks",
		);
	});

	it("allows read-only worker with no tasks", () => {
		const g = makeGroup({ worker: { mode: "read-only" }, tasks: [] });
		const plan = makePlan([g]);
		expect(validatePlanShape(plan)).toEqual([]);
	});

	it("detects reserved agent name 'worker'", () => {
		const g = makeGroup({
			agents: [
				{
					name: "worker",
					mode: "read-only",
					slot: "default",
					effort: "low",
					focus: "x",
					after: [],
				},
			],
		});
		const plan = makePlan([g]);
		const problems = validatePlanShape(plan);
		expect(problems.some((p) => p.includes('"worker" is reserved'))).toBe(true);
	});

	it("detects duplicate agent names", () => {
		const g = makeGroup({
			agents: [
				{
					name: "review",
					mode: "read-only",
					slot: "default",
					effort: "low",
					focus: "x",
					after: [],
				},
				{
					name: "review",
					mode: "read-only",
					slot: "default",
					effort: "low",
					focus: "y",
					after: [],
				},
			],
		});
		const plan = makePlan([g]);
		const problems = validatePlanShape(plan);
		expect(problems.some((p) => p.includes("duplicate agent name"))).toBe(true);
	});

	it("detects unknown agent after reference", () => {
		const g = makeGroup({
			agents: [
				{
					name: "review",
					mode: "read-only",
					slot: "default",
					effort: "low",
					focus: "x",
					after: ["nonexistent"],
				},
			],
		});
		const plan = makePlan([g]);
		const problems = validatePlanShape(plan);
		expect(problems.some((p) => p.includes("after references unknown"))).toBe(
			true,
		);
	});

	it("detects agent graph cycle", () => {
		const g = makeGroup({
			agents: [
				{
					name: "a",
					mode: "read-only",
					slot: "default",
					effort: "low",
					focus: "x",
					after: ["b"],
				},
				{
					name: "b",
					mode: "read-only",
					slot: "default",
					effort: "low",
					focus: "y",
					after: ["a"],
				},
			],
		});
		const plan = makePlan([g]);
		const problems = validatePlanShape(plan);
		expect(problems.some((p) => p.includes("cycle"))).toBe(true);
	});

	it("detects cross-group dependency cycle", () => {
		const a = makeGroup({ id: "a", dependsOn: ["b"] });
		const b = makeGroup({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		const problems = validatePlanShape(plan);
		expect(problems.some((p) => p.includes("cycle"))).toBe(true);
	});

	it("warns on stacked=false without dependsOn", () => {
		const g = makeGroup({ stacked: false, dependsOn: [] });
		const plan = makePlan([g]);
		const problems = validatePlanShape(plan);
		expect(
			problems.some((p) => p.includes("meaningless without dependsOn")),
		).toBe(true);
	});

	it("detects worker.after referencing unknown agent", () => {
		const g = makeGroup({
			worker: { mode: "full", after: ["ghost"] },
		});
		const plan = makePlan([g]);
		const problems = validatePlanShape(plan);
		expect(
			problems.some((p) => p.includes("worker after references unknown")),
		).toBe(true);
	});
});

// ─── Branch logic ────────────────────────────────────────────────────────────

describe("pickBaseBranch", () => {
	it("root group bases off default branch", () => {
		const g = makeGroup({ dependsOn: [] });
		const plan = makePlan([g]);
		expect(pickBaseBranch(plan, g, "main")).toBe("main");
	});

	it("stacked group bases off parent branch", () => {
		const a = makeGroup({ id: "a", branch: "feat/a" });
		const b = makeGroup({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("feat/a");
	});

	it("stacked=false bases off default branch", () => {
		const a = makeGroup({ id: "a", branch: "feat/a" });
		const b = makeGroup({ id: "b", dependsOn: ["a"], stacked: false });
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("main");
	});

	it("falls back to default when parent has no branch yet", () => {
		const a = makeGroup({ id: "a" });
		const b = makeGroup({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("main");
	});
});

describe("defaultBranchForGroup", () => {
	it("generates feat/<id> branch name", () => {
		expect(defaultBranchForGroup({ id: "implement-auth" })).toBe(
			"feat/implement-auth",
		);
	});
});

// ─── Traversal ───────────────────────────────────────────────────────────────

describe("findGroup / findTask / findAgent", () => {
	it("findGroup returns group by id", () => {
		const g = makeGroup({ id: "my-group" });
		const plan = makePlan([g]);
		expect(findGroup(plan, "my-group")).toBe(g);
		expect(findGroup(plan, "nope")).toBeNull();
	});

	it("findTask returns task by id", () => {
		const g = makeGroup();
		expect(findTask(g, "t1")?.title).toBe("Task 1");
		expect(findTask(g, "nope")).toBeNull();
	});

	it("findAgent returns agent by name", () => {
		const g = makeGroup({
			agents: [
				{
					name: "sec",
					mode: "read-only",
					slot: "alternate",
					effort: "high",
					focus: "security",
					after: [],
				},
			],
		});
		expect(findAgent(g, "sec")?.focus).toBe("security");
		expect(findAgent(g, "nope")).toBeNull();
	});
});

// ─── Slugify ─────────────────────────────────────────────────────────────────

describe("slugify", () => {
	it("lowercases and replaces spaces", () => {
		expect(slugify("Implement JWT Auth")).toBe("implement-jwt-auth");
	});

	it("strips special chars", () => {
		expect(slugify("feat: add /login endpoint!")).toBe(
			"feat-add-login-endpoint",
		);
	});

	it("truncates at 60 chars", () => {
		const long = "a".repeat(100);
		expect(slugify(long).length).toBeLessThanOrEqual(60);
	});

	it("trims leading/trailing dashes", () => {
		expect(slugify("--hello--")).toBe("hello");
	});
});

// ─── Blocked reason ──────────────────────────────────────────────────────────

describe("blockedReason", () => {
	it("null for ready group", () => {
		const g = makeGroup({ dependsOn: [] });
		const plan = makePlan([g]);
		expect(blockedReason(plan, g)).toBeNull();
	});

	it("reports waiting on planned dep", () => {
		const a = makeGroup({ id: "a", status: "planned" });
		const b = makeGroup({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(blockedReason(plan, b)).toContain("waiting on `a`");
	});

	it("reports unknown dep", () => {
		const g = makeGroup({ dependsOn: ["ghost"] });
		const plan = makePlan([g]);
		expect(blockedReason(plan, g)).toContain("unknown dependency");
	});

	it("reports status for non-planned group", () => {
		const g = makeGroup({ status: "active" });
		const plan = makePlan([g]);
		expect(blockedReason(plan, g)).toContain("is active, not planned");
	});
});
