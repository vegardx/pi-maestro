import { describe, expect, it } from "vitest";
import {
	blockedReason,
	canTransition,
	type Deliverable,
	defaultBranchForDeliverable,
	findAgent,
	findDeliverable,
	findTask,
	immediateAgents,
	isDeliverableReady,
	isLeafDeliverable,
	type Plan,
	pickBaseBranch,
	readyDeliverables,
	shippableDeliverables,
	slugify,
	topologicalSort,
	unblockedAgents,
	validatePlanShape,
} from "../packages/modes/src/schema.js";

it("validates parallel stage membership, references, cycles, and contracts", () => {
	const valid = makePlan([makeDeliverable()]);
	valid.workflow = {
		assignments: [assignment("review-a"), assignment("review-b")],
		stages: [
			{
				id: "implement",
				after: [],
				assignmentIds: [],
				inputRevision: "sha256:base",
				inputContracts: ["implementation"],
				barrier: "all",
			},
			{
				id: "review",
				after: ["implement"],
				assignmentIds: ["review-a", "review-b"],
				inputRevision: "sha256:implementation",
				inputContracts: ["implementation"],
				barrier: "all",
			},
		],
	};
	const validProblems = validatePlanShape(valid);
	expect(validProblems).toEqual([
		"workflow stage `implement` has no assignments",
	]);

	valid.workflow.stages[0].assignmentIds = ["review-a"];
	valid.workflow.stages[1].assignmentIds = ["review-b"];
	expect(validatePlanShape(valid)).toEqual([]);

	valid.workflow.stages[1].assignmentIds = ["review-a", "ghost"];
	valid.workflow.stages[1].after = ["review"];
	valid.workflow.stages[1].inputContracts = ["missing-contract"];
	const problems = validatePlanShape(valid).join("\n");
	expect(problems).toContain("appears in stages");
	expect(problems).toContain("unknown assignment `ghost`");
	expect(problems).toContain("dependency cycle");
	expect(problems).toContain("does not provide contract `implementation`");
});

it("validates reviewer identity and cross-model policy", () => {
	const duplicate = makeDeliverable({
		subAgents: [
			{ name: "sec", persona: "security-audit" },
			{ name: "sec", persona: "documentation" },
		],
	});
	expect(validatePlanShape(makePlan([duplicate])).join("\n")).toContain(
		"duplicate reviewer name",
	);

	const threeModels = makeDeliverable({
		subAgents: ["a", "b", "c"].map((model) => ({
			name: `sec-${model}`,
			persona: "security-audit",
			model: `provider/${model}`,
			modelJustification: "independent audit",
		})),
	});
	expect(validatePlanShape(makePlan([threeModels])).join("\n")).toContain(
		"more than two distinct models",
	);

	const missingWhy = makeDeliverable({
		subAgents: [
			{ name: "sec-a", persona: "security-audit", model: "provider/a" },
			{ name: "sec-b", persona: "security-audit", model: "provider/b" },
		],
	});
	expect(validatePlanShape(makePlan([missingWhy])).join("\n")).toContain(
		"requires modelJustification",
	);
});

function assignment(
	id: string,
	overrides: Partial<
		import("@vegardx/pi-contracts").ResolvedAgentAssignment
	> = {},
): import("@vegardx/pi-contracts").ResolvedAgentAssignment {
	const resolvedAt = "2026-01-01T00:00:00.000Z";
	return {
		agentId: id,
		kind: "correctness-review",
		presetId: "main",
		modelSetId: "reviews",
		optionId: "deep",
		modelId: "provider/model",
		effort: "high",
		runtime: {
			mode: "read-only",
			transport: "headless",
			tools: {},
			session: "ephemeral",
			isolation: "strong",
		},
		focus: `Focus ${id}`,
		rationale: `Rationale ${id}`,
		inputContracts: ["implementation"],
		outputContracts: ["structured-review"],
		provenance: {
			source: "explicit",
			presetId: "main",
			modelSetId: "reviews",
			optionId: "deep",
			resolvedAt,
		},
		resolvedAt,
		source: "explicit",
		...overrides,
	};
}

function makeDeliverable(overrides: Partial<Deliverable> = {}): Deliverable {
	return {
		type: "deliverable",
		id: overrides.id ?? "test-deliverable",
		title: overrides.title ?? "Test Deliverable",
		body: overrides.body ?? "Test body",
		status: overrides.status ?? "planned",
		dependsOn: overrides.dependsOn,
		stacked: overrides.stacked,
		workspace: overrides.workspace,
		repo: overrides.repo,
		worker: overrides.worker ?? { mode: "full" },
		agents: overrides.agents ?? [],
		subAgents: overrides.subAgents,
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

function makePlan(deliverables: Deliverable[]): Plan {
	return {
		schemaVersion: 5,
		slug: "test-plan",
		title: "Test Plan",
		repoPath: "/tmp/repo",
		deliverables,
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
	};
}

// ─── State machine ───────────────────────────────────────────────────────────

describe("DeliverableStatus transitions", () => {
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

	it("allows recoverable delivery failure and retry", () => {
		expect(canTransition("active", "failed")).toBe(true);
		expect(canTransition("failed", "planned")).toBe(true);
		expect(canTransition("failed", "active")).toBe(true);
	});

	it("does not allow planned → shipped", () => {
		expect(canTransition("planned", "shipped")).toBe(false);
	});

	it("shipped can only reopen to planned (verify remediation)", () => {
		expect(canTransition("shipped", "planned")).toBe(true);
		expect(canTransition("shipped", "active")).toBe(false);
		expect(canTransition("shipped", "abandoned")).toBe(false);
	});

	it("does not allow superseded → anything", () => {
		expect(canTransition("superseded", "planned")).toBe(false);
		expect(canTransition("superseded", "active")).toBe(false);
	});
});

// ─── Deliverable readiness ─────────────────────────────────────────────────────────

describe("isDeliverableReady", () => {
	it("root deliverable (no deps) is always ready", () => {
		const g = makeDeliverable({ dependsOn: [] });
		const plan = makePlan([g]);
		expect(isDeliverableReady(plan, g)).toBe(true);
	});

	it("deliverable with unmet dep is not ready", () => {
		const a = makeDeliverable({ id: "a", status: "planned" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isDeliverableReady(plan, b)).toBe(false);
	});

	it("deliverable with active dep is not ready — the dep's branch tip is still empty", () => {
		const a = makeDeliverable({ id: "a", status: "active" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isDeliverableReady(plan, b)).toBe(false);
	});

	it("deliverable with complete dep is ready", () => {
		const a = makeDeliverable({ id: "a", status: "complete" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isDeliverableReady(plan, b)).toBe(true);
	});

	it("deliverable with shipped dep is ready", () => {
		const a = makeDeliverable({ id: "a", status: "shipped" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isDeliverableReady(plan, b)).toBe(true);
	});

	it("deliverable with abandoned dep is ready — a dead parent must not wedge the chain", () => {
		const a = makeDeliverable({ id: "a", status: "abandoned" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isDeliverableReady(plan, b)).toBe(true);
	});

	it("deliverable with superseded dep is ready", () => {
		const a = makeDeliverable({ id: "a", status: "superseded" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isDeliverableReady(plan, b)).toBe(true);
	});

	it("already-active deliverable is not ready", () => {
		const g = makeDeliverable({ status: "active", dependsOn: [] });
		const plan = makePlan([g]);
		expect(isDeliverableReady(plan, g)).toBe(false);
	});

	it("multiple deps — all must be satisfied", () => {
		const a = makeDeliverable({ id: "a", status: "complete" });
		const b = makeDeliverable({ id: "b", status: "active" });
		const c = makeDeliverable({ id: "c", dependsOn: ["a", "b"] });
		const plan = makePlan([a, b, c]);
		expect(isDeliverableReady(plan, c)).toBe(false);
	});
});

describe("readyDeliverables", () => {
	it("returns deliverables whose deps are met", () => {
		const a = makeDeliverable({ id: "a", status: "complete", dependsOn: [] });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const c = makeDeliverable({ id: "c", dependsOn: [] });
		const d = makeDeliverable({ id: "d", dependsOn: ["c"] });
		const plan = makePlan([a, b, c, d]);
		const ready = readyDeliverables(plan);
		// b's dep is complete; c has no deps; d waits on planned c.
		expect(ready.map((g) => g.id)).toEqual(["b", "c"]);
	});
});

// ─── Leaf / shippable ────────────────────────────────────────────────────────

describe("isLeafDeliverable", () => {
	it("true when nothing depends on it", () => {
		const g = makeDeliverable({ id: "a" });
		const plan = makePlan([g]);
		expect(isLeafDeliverable(plan, g)).toBe(true);
	});

	it("false when another deliverable depends on it", () => {
		const a = makeDeliverable({ id: "a" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(isLeafDeliverable(plan, a)).toBe(false);
	});
});

describe("shippableDeliverables", () => {
	it("ships the chain in order: the parent ships first", () => {
		const a = makeDeliverable({ id: "a", status: "complete" });
		const b = makeDeliverable({
			id: "b",
			status: "complete",
			dependsOn: ["a"],
		});
		const plan = makePlan([a, b]);
		// a's branch must reach the remote before b's PR can target it.
		expect(shippableDeliverables(plan).map((g) => g.id)).toEqual(["a"]);
	});

	it("dependent becomes shippable once its dep has shipped", () => {
		const a = makeDeliverable({ id: "a", status: "shipped" });
		const b = makeDeliverable({
			id: "b",
			status: "complete",
			dependsOn: ["a"],
		});
		const plan = makePlan([a, b]);
		expect(shippableDeliverables(plan).map((g) => g.id)).toEqual(["b"]);
	});

	it("terminally non-productive deps do not block shipping", () => {
		const a = makeDeliverable({ id: "a", status: "abandoned" });
		const b = makeDeliverable({ id: "b", status: "superseded" });
		const c = makeDeliverable({
			id: "c",
			status: "complete",
			dependsOn: ["a", "b"],
		});
		const plan = makePlan([a, b, c]);
		expect(shippableDeliverables(plan).map((g) => g.id)).toEqual(["c"]);
	});

	it("a complete deliverable with a complete-but-unshipped dep is not shippable", () => {
		const a = makeDeliverable({ id: "a", status: "complete" });
		const b = makeDeliverable({ id: "b", status: "shipped" });
		const c = makeDeliverable({
			id: "c",
			status: "complete",
			dependsOn: ["a", "b"],
		});
		const plan = makePlan([a, b, c]);
		// c waits on a; a itself (no deps) is the one to ship.
		expect(shippableDeliverables(plan).map((g) => g.id)).toEqual(["a"]);
	});

	it("does not return non-complete deliverables", () => {
		const a = makeDeliverable({ id: "a", status: "active" });
		const plan = makePlan([a]);
		expect(shippableDeliverables(plan)).toEqual([]);
	});
});

// ─── Agent graph ─────────────────────────────────────────────────────────────

describe("topologicalSort", () => {
	it("worker only (no agents)", () => {
		const g = makeDeliverable({ agents: [] });
		expect(topologicalSort(g)).toEqual(["worker"]);
	});

	it("linear chain: worker → review → fix", () => {
		const g = makeDeliverable({
			agents: [
				{
					name: "review",
					mode: "read-only",
					effort: "high",
					focus: "security",
					after: ["worker"],
				},
				{
					name: "fix",
					mode: "full",
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
		const g = makeDeliverable({
			agents: [
				{
					name: "security",
					mode: "read-only",
					effort: "high",
					focus: "sec",
					after: ["worker"],
				},
				{
					name: "perf",
					mode: "read-only",
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
		const g = makeDeliverable({
			worker: { mode: "full", after: ["fix"] },
			agents: [
				{
					name: "fix",
					mode: "full",
					effort: "low",
					focus: "fix",
					after: ["worker"],
				},
			],
		});
		expect(() => topologicalSort(g)).toThrow(/cycle/);
	});

	it("pre-worker agents: worker.after = ['lint']", () => {
		const g = makeDeliverable({
			worker: { mode: "full", after: ["lint"] },
			agents: [
				{
					name: "lint",
					mode: "read-only",
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
		const g = makeDeliverable({ agents: [] });
		expect(immediateAgents(g)).toEqual(["worker"]);
	});

	it("worker and parallel agents with empty after", () => {
		const g = makeDeliverable({
			agents: [
				{
					name: "lint",
					mode: "read-only",
					effort: "low",
					focus: "lint",
					after: [],
				},
			],
		});
		expect(immediateAgents(g)).toEqual(["worker", "lint"]);
	});

	it("worker delayed by after", () => {
		const g = makeDeliverable({
			worker: { mode: "full", after: ["lint"] },
			agents: [
				{
					name: "lint",
					mode: "read-only",
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
		const g = makeDeliverable({
			agents: [
				{
					name: "review",
					mode: "read-only",
					effort: "high",
					focus: "sec",
					after: ["worker"],
				},
				{
					name: "fix",
					mode: "full",
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
		const g = makeDeliverable({
			worker: { mode: "full", after: ["lint"] },
			agents: [
				{
					name: "lint",
					mode: "read-only",
					effort: "low",
					focus: "lint",
					after: [],
				},
			],
		});
		expect(unblockedAgents(g, new Set(["lint"]))).toEqual(["worker"]);
	});

	it("does not unblock already-completed agents", () => {
		const g = makeDeliverable({
			agents: [
				{
					name: "review",
					mode: "read-only",
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
		const g = makeDeliverable();
		const plan = makePlan([g]);
		expect(validatePlanShape(plan)).toEqual([]);
	});

	it("detects unknown dependsOn reference", () => {
		const g = makeDeliverable({ dependsOn: ["nonexistent"] });
		const plan = makePlan([g]);
		const problems = validatePlanShape(plan);
		expect(problems).toContain(
			"deliverable `test-deliverable` depends on unknown deliverable `nonexistent`",
		);
	});

	it("detects full-mode worker with no tasks when active", () => {
		const g = makeDeliverable({ tasks: [], status: "active" });
		const plan = makePlan([g]);
		const problems = validatePlanShape(plan);
		expect(problems).toContain(
			"deliverable `test-deliverable` has a full-mode worker but no gating tasks",
		);
	});

	it("allows read-only worker with no tasks", () => {
		const g = makeDeliverable({ worker: { mode: "read-only" }, tasks: [] });
		const plan = makePlan([g]);
		expect(validatePlanShape(plan)).toEqual([]);
	});

	it("scratch deliverables cannot target a repo or set stacked", () => {
		const g = makeDeliverable({
			workspace: "scratch",
			repo: "service",
			stacked: false,
			dependsOn: [],
		});
		const plan = makePlan([g]);
		const problems = validatePlanShape(plan);
		expect(
			problems.some((p) => p.includes("scratch — it cannot target a repo")),
		).toBe(true);
		expect(problems.some((p) => p.includes("stacked is meaningless"))).toBe(
			true,
		);
	});

	it("detects an unknown repo key", () => {
		const g = makeDeliverable({ repo: "ghost" });
		const plan = makePlan([g]);
		expect(validatePlanShape(plan)).toContain(
			"deliverable `test-deliverable` targets unknown repo `ghost`",
		);
	});

	it("createdBy must reference an existing deliverable", () => {
		const g = makeDeliverable();
		const plan = {
			...makePlan([g]),
			repos: [{ key: "svc", path: "/tmp/svc", createdBy: "ghost" }],
		};
		expect(validatePlanShape(plan)).toContain(
			"repo `svc` createdBy references unknown deliverable `ghost`",
		);
	});

	it("a deliverable targeting a late-bound repo must depend on its creator", () => {
		const creator = makeDeliverable({ id: "bootstrap", workspace: "scratch" });
		const user = makeDeliverable({ id: "impl", repo: "svc" }); // no dependsOn
		const plan = {
			...makePlan([creator, user]),
			repos: [{ key: "svc", path: "/tmp/svc", createdBy: "bootstrap" }],
		};
		const problems = validatePlanShape(plan);
		expect(
			problems.some(
				(p) =>
					p.includes("`impl` targets repo `svc` created by `bootstrap`") &&
					p.includes("does not depend on it"),
			),
		).toBe(true);
	});

	it("accepts a late-bound repo chain when the dependency is transitive", () => {
		const creator = makeDeliverable({ id: "bootstrap", workspace: "scratch" });
		const mid = makeDeliverable({
			id: "mid",
			repo: "svc",
			dependsOn: ["bootstrap"],
		});
		const leaf = makeDeliverable({
			id: "leaf",
			repo: "svc",
			dependsOn: ["mid"],
		});
		const plan = {
			...makePlan([creator, mid, leaf]),
			repos: [{ key: "svc", path: "/tmp/svc", createdBy: "bootstrap" }],
		};
		expect(validatePlanShape(plan)).toEqual([]);
	});

	it("a deliverable cannot target the repo it is supposed to create", () => {
		const g = makeDeliverable({ id: "bootstrap", repo: "svc" });
		const plan = {
			...makePlan([g]),
			repos: [{ key: "svc", path: "/tmp/svc", createdBy: "bootstrap" }],
		};
		const problems = validatePlanShape(plan);
		expect(
			problems.some((p) =>
				p.includes("targets repo `svc` it is supposed to create"),
			),
		).toBe(true);
	});

	it("detects reserved agent name 'worker'", () => {
		const g = makeDeliverable({
			agents: [
				{
					name: "worker",
					mode: "read-only",
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
		const g = makeDeliverable({
			agents: [
				{
					name: "review",
					mode: "read-only",
					effort: "low",
					focus: "x",
					after: [],
				},
				{
					name: "review",
					mode: "read-only",
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
		const g = makeDeliverable({
			agents: [
				{
					name: "review",
					mode: "read-only",
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
		const g = makeDeliverable({
			agents: [
				{
					name: "a",
					mode: "read-only",
					effort: "low",
					focus: "x",
					after: ["b"],
				},
				{
					name: "b",
					mode: "read-only",
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

	it("detects cross-deliverable dependency cycle", () => {
		const a = makeDeliverable({ id: "a", dependsOn: ["b"] });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		const problems = validatePlanShape(plan);
		expect(problems.some((p) => p.includes("cycle"))).toBe(true);
	});

	it("warns on stacked=false without dependsOn", () => {
		const g = makeDeliverable({ stacked: false, dependsOn: [] });
		const plan = makePlan([g]);
		const problems = validatePlanShape(plan);
		expect(
			problems.some((p) => p.includes("meaningless without dependsOn")),
		).toBe(true);
	});

	it("detects worker.after referencing unknown agent", () => {
		const g = makeDeliverable({
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
	it("root deliverable bases off default branch", () => {
		const g = makeDeliverable({ dependsOn: [] });
		const plan = makePlan([g]);
		expect(pickBaseBranch(plan, g, "main")).toBe("main");
	});

	it("stacked deliverable bases off a complete parent's branch", () => {
		const a = makeDeliverable({
			id: "a",
			branch: "feat/a",
			status: "complete",
		});
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("feat/a");
	});

	it("stacked deliverable bases off a shipped parent's branch", () => {
		const a = makeDeliverable({ id: "a", branch: "feat/a", status: "shipped" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("feat/a");
	});

	it("stacked=false bases off default branch", () => {
		const a = makeDeliverable({
			id: "a",
			branch: "feat/a",
			status: "complete",
		});
		const b = makeDeliverable({ id: "b", dependsOn: ["a"], stacked: false });
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("main");
	});

	it("falls back to default when parent has no branch yet", () => {
		const a = makeDeliverable({ id: "a", status: "complete" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("main");
	});

	it("skips an abandoned parent — its branch holds no shippable work", () => {
		const a = makeDeliverable({
			id: "a",
			branch: "feat/a",
			status: "abandoned",
		});
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("main");
	});

	it("skips a superseded parent", () => {
		const a = makeDeliverable({
			id: "a",
			branch: "feat/a",
			status: "superseded",
		});
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("main");
	});

	it("falls through a non-productive first dep to the next productive one", () => {
		const a = makeDeliverable({
			id: "a",
			branch: "feat/a",
			status: "abandoned",
		});
		const b = makeDeliverable({
			id: "b",
			branch: "feat/b",
			status: "complete",
		});
		const c = makeDeliverable({ id: "c", dependsOn: ["a", "b"] });
		const plan = makePlan([a, b, c]);
		expect(pickBaseBranch(plan, c, "main")).toBe("feat/b");
	});

	it("does not stack on a parent that has not completed", () => {
		const a = makeDeliverable({ id: "a", branch: "feat/a", status: "active" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("main");
	});

	it("cross-repo dependsOn is ordering-only — never stacks", () => {
		const a = makeDeliverable({
			id: "a",
			branch: "feat/a",
			status: "complete",
			repo: "service",
		});
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] }); // default repo
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("main");
	});

	it("stacks within an explicit shared repo key", () => {
		const a = makeDeliverable({
			id: "a",
			branch: "feat/a",
			status: "complete",
			repo: "service",
		});
		const b = makeDeliverable({ id: "b", dependsOn: ["a"], repo: "service" });
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("feat/a");
	});

	it("never stacks on a scratch parent, even with a stale branch field", () => {
		const a = makeDeliverable({
			id: "a",
			branch: "feat/a", // defensive: scratch deliverables shouldn't have one
			status: "shipped",
			workspace: "scratch",
		});
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(pickBaseBranch(plan, b, "main")).toBe("main");
	});
});

describe("defaultBranchForDeliverable", () => {
	it("generates feat/<id> branch name", () => {
		expect(defaultBranchForDeliverable({ id: "implement-auth" })).toBe(
			"feat/implement-auth",
		);
	});
});

// ─── Traversal ───────────────────────────────────────────────────────────────

describe("findDeliverable / findTask / findAgent", () => {
	it("findDeliverable returns deliverable by id", () => {
		const g = makeDeliverable({ id: "my-deliverable" });
		const plan = makePlan([g]);
		expect(findDeliverable(plan, "my-deliverable")).toBe(g);
		expect(findDeliverable(plan, "nope")).toBeNull();
	});

	it("findTask returns task by id", () => {
		const g = makeDeliverable();
		expect(findTask(g, "t1")?.title).toBe("Task 1");
		expect(findTask(g, "nope")).toBeNull();
	});

	it("findAgent returns agent by name", () => {
		const g = makeDeliverable({
			agents: [
				{
					name: "sec",
					mode: "read-only",
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
	it("null for ready deliverable", () => {
		const g = makeDeliverable({ dependsOn: [] });
		const plan = makePlan([g]);
		expect(blockedReason(plan, g)).toBeNull();
	});

	it("reports waiting on planned dep", () => {
		const a = makeDeliverable({ id: "a", status: "planned" });
		const b = makeDeliverable({ id: "b", dependsOn: ["a"] });
		const plan = makePlan([a, b]);
		expect(blockedReason(plan, b)).toContain("waiting on `a`");
	});

	it("reports unknown dep", () => {
		const g = makeDeliverable({ dependsOn: ["ghost"] });
		const plan = makePlan([g]);
		expect(blockedReason(plan, g)).toContain("unknown dependency");
	});

	it("reports status for non-planned deliverable", () => {
		const g = makeDeliverable({ status: "active" });
		const plan = makePlan([g]);
		expect(blockedReason(plan, g)).toContain("is active, not planned");
	});
});
