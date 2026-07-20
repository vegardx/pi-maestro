// The v2 plan module (cutover PR-3): traversal, the one sibling-group
// scheduler, ship ordering, base derivation, authoring-time validation, and
// the fingerprint's exclusion discipline. Successor to schema.test.ts.

import { PLAN_SCHEMA_VERSION_V2 } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import {
	canTransition,
	deriveBase,
	effectiveMaxChildren,
	findNodeV2,
	gatingNodeTasks,
	isBranchOwner,
	nodeBlockedReason,
	nodeReady,
	type PlanNode,
	type PlanV2,
	parentOfNode,
	planFingerprintV2,
	readyChildren,
	shippableNodes,
	slugify,
	treeDepth,
	validatePlanShapeV2,
	walkNodes,
} from "../packages/modes/src/plan/schema.js";

const T = "2026-07-20T17:00:00Z";

function node(partial: Partial<PlanNode> & { id: string }): PlanNode {
	return {
		type: "node",
		agent: "worker",
		persona: "coder",
		tasks: [],
		authoredBy: "plan",
		status: "planned",
		createdAt: T,
		updatedAt: T,
		...partial,
	};
}

function plan(nodes: PlanNode[], partial: Partial<PlanV2> = {}): PlanV2 {
	return {
		schemaVersion: PLAN_SCHEMA_VERSION_V2,
		slug: "p",
		title: "P",
		repoPath: "/repo",
		nodes,
		createdAt: T,
		updatedAt: T,
		...partial,
	};
}

/** The design doc's worked example: build-auth with candidates + reviews. */
function authPlan(): PlanV2 {
	return plan([
		node({ id: "prep-repos", persona: "generalist" }),
		node({
			id: "build-auth",
			branch: "feat/auth",
			after: ["prep-repos"],
			envelope: { maxChildren: 6 },
			tasks: [
				{
					id: "t1",
					title: "implement rotation",
					body: "",
					done: false,
					createdAt: T,
					updatedAt: T,
				},
			],
			children: [
				node({ id: "candidate-a", authoredBy: "build-auth" }),
				node({
					id: "review-security",
					agent: "reviewer",
					persona: "reviewer",
					after: ["parent"],
					children: [
						node({
							id: "sub-review",
							agent: "reviewer",
							persona: "reviewer",
							authoredBy: "review-security",
						}),
					],
				}),
			],
		}),
		node({
			id: "docs-pass",
			branch: "feat/auth-docs",
			after: ["build-auth"],
		}),
	]);
}

describe("traversal", () => {
	it("walks depth-first with seat-relative depth and full paths", () => {
		const visits = [...walkNodes(authPlan())].map((v) => ({
			id: v.node.id,
			depth: v.depth,
			parent: v.parent?.id ?? null,
		}));
		expect(visits).toEqual([
			{ id: "prep-repos", depth: 1, parent: null },
			{ id: "build-auth", depth: 1, parent: null },
			{ id: "candidate-a", depth: 2, parent: "build-auth" },
			{ id: "review-security", depth: 2, parent: "build-auth" },
			{ id: "sub-review", depth: 3, parent: "review-security" },
			{ id: "docs-pass", depth: 1, parent: null },
		]);
		expect(treeDepth(authPlan())).toBe(3);
		expect(findNodeV2(authPlan(), "sub-review")?.agent).toBe("reviewer");
		expect(parentOfNode(authPlan(), "candidate-a")?.id).toBe("build-auth");
	});
});

describe("the sibling-group scheduler", () => {
	it("readiness: sibling deps by status, 'parent' by the parent's gating tasks", () => {
		const p = authPlan();
		const roots = p.nodes;
		// prep-repos has no deps → ready; build-auth waits on it.
		expect(readyChildren(roots).map((n) => n.id)).toEqual(["prep-repos"]);
		expect(nodeBlockedReason(roots, roots[1])).toContain("waiting on");
		roots[0].status = "complete";
		expect(nodeReady(roots, roots[1])).toBe(true);

		// Inside build-auth: candidate-a immediate; review waits on "parent".
		const children = roots[1].children ?? [];
		expect(
			readyChildren(children, { parentGatingDone: false }).map((n) => n.id),
		).toEqual(["candidate-a"]);
		expect(nodeBlockedReason(children, children[1], {})).toContain(
			"parent's own tasks",
		);
		expect(
			readyChildren(children, { parentGatingDone: true }).map((n) => n.id),
		).toEqual(["candidate-a", "review-security"]);
	});

	it("terminal non-productive deps satisfy — a chain never wedges", () => {
		const roots = authPlan().nodes;
		roots[0].status = "abandoned";
		expect(nodeReady(roots, roots[1])).toBe(true);
	});
});

describe("shipping", () => {
	it("ships branch owners in chain order, at any depth", () => {
		const p = authPlan();
		p.nodes[0].status = "complete"; // prep-repos: complete but NOT terminal
		p.nodes[1].status = "complete"; // build-auth complete
		p.nodes[2].status = "complete"; // docs-pass complete
		// build-auth waits: prep-repos is complete (not terminal) — v1 rule.
		expect(shippableNodes(p).map((n) => n.id)).toEqual([]);
		p.nodes[0].status = "shipped";
		expect(shippableNodes(p).map((n) => n.id)).toEqual(["build-auth"]);
		p.nodes[1].status = "shipped";
		expect(shippableNodes(p).map((n) => n.id)).toEqual(["docs-pass"]);
		// Non-branch nodes never ship, whatever their status.
		expect(isBranchOwner(p.nodes[1].children?.[0] ?? ({} as PlanNode))).toBe(
			false,
		);
	});
});

describe("base derivation (v1 pickBaseBranch over siblings)", () => {
	it("stacks on the first productive same-repo dep, honors overrides", () => {
		const siblings = [
			node({ id: "a", branch: "feat/a", status: "shipped" }),
			node({ id: "b", branch: "feat/b", status: "active" }),
			node({ id: "c", branch: "feat/c", status: "shipped", repo: "other" }),
		];
		// b is active (not stackable), c is cross-repo → falls through to a? No:
		// after order decides — first productive match wins.
		expect(
			deriveBase(node({ id: "x", after: ["b", "c", "a"] }), siblings, "main"),
		).toBe("feat/a");
		// Explicit opt-out (v1 stacked:false).
		expect(
			deriveBase(
				node({ id: "x", after: ["a"], base: "default-branch" }),
				siblings,
				"main",
			),
		).toBe("main");
		// Explicit base branch wins outright.
		expect(
			deriveBase(node({ id: "x", base: "release/1.0" }), siblings, "main"),
		).toBe("release/1.0");
		// No deps → default branch.
		expect(deriveBase(node({ id: "x" }), siblings, "main")).toBe("main");
	});
});

describe("authoring-time validation", () => {
	it("accepts the worked example", () => {
		expect(validatePlanShapeV2(authPlan())).toEqual([]);
	});

	it("rejects duplicate ids, unknown agents, missing personas", () => {
		const errors = validatePlanShapeV2(
			plan([
				node({ id: "dup" }),
				node({ id: "dup", agent: "caller" as never, persona: "" }),
			]),
		);
		expect(errors.join(" ")).toContain("duplicate node id");
		expect(errors.join(" ")).toContain("callers are not spawnable");
		expect(errors.join(" ")).toContain("persona is required");
	});

	it("enforces maxDepth seat-relatively and the envelope cap", () => {
		const deep = plan(
			[
				node({
					id: "l1",
					children: [
						node({
							id: "l2",
							children: [node({ id: "l3", children: [node({ id: "l4" })] })],
						}),
					],
				}),
			],
			{ maxDepth: 3 },
		);
		expect(validatePlanShapeV2(deep).join(" ")).toContain(
			"depth 4 exceeds maxDepth 3",
		);

		const over = plan(
			[node({ id: "p", children: [node({ id: "c1" }), node({ id: "c2" })] })],
			{ defaultEnvelope: { maxChildren: 1 } },
		);
		expect(validatePlanShapeV2(over).join(" ")).toContain(
			"exceed the envelope cap 1",
		);
		expect(effectiveMaxChildren(over, over.nodes[0])).toBe(1);
	});

	it("scopes after to siblings, forbids parent-token at roots, finds cycles", () => {
		const errors = validatePlanShapeV2(
			plan([
				node({ id: "a", after: ["parent"] }),
				node({ id: "b", after: ["nested-child"] }),
				node({ id: "c", after: ["d"] }),
				node({ id: "d", after: ["c"] }),
				node({ id: "nested", children: [node({ id: "nested-child" })] }),
			]),
		);
		expect(errors.join(" ")).toContain('after "parent" is invalid on a root');
		expect(errors.join(" ")).toContain("does not name a sibling");
		expect(errors.join(" ")).toContain("dependency cycle");
	});

	it("enforces branch uniqueness and base-on-owners-only", () => {
		const errors = validatePlanShapeV2(
			plan([
				node({ id: "a", branch: "feat/x" }),
				node({ id: "b", branch: "feat/x" }),
				node({ id: "c", base: "release/1.0" }),
			]),
		);
		expect(errors.join(" ")).toContain("already owned by");
		expect(errors.join(" ")).toContain("only meaningful on branch-owning");
	});

	it("checks persona registration when a registry is provided", () => {
		const errors = validatePlanShapeV2(authPlan(), {
			personaRegistered: (agent, persona) =>
				!(agent === "worker" && persona === "generalist"),
		});
		expect(errors.join(" ")).toContain(
			"generalist is not registered for agent type worker",
		);
	});
});

describe("tasks and fingerprint", () => {
	it("gating tasks include the lifecycle pair, not followups", () => {
		const n = node({
			id: "n",
			tasks: [
				{
					id: "t",
					title: "t",
					body: "",
					done: false,
					createdAt: T,
					updatedAt: T,
				},
				{
					id: "f",
					title: "f",
					body: "",
					done: false,
					kind: "followup",
					createdAt: T,
					updatedAt: T,
				},
				{
					id: "post",
					title: "p",
					body: "",
					done: false,
					kind: "postflight",
					createdAt: T,
					updatedAt: T,
				},
			],
		});
		expect(gatingNodeTasks(n).map((t) => t.id)).toEqual(["t", "post"]);
	});

	it("blocked reasons name unknown deps and non-planned statuses", () => {
		// Ported from schema.test.ts (v1 blockedReason): the two branches the
		// scheduler tests above don't reach.
		const ghost = node({ id: "x", after: ["ghost"] });
		expect(nodeBlockedReason([ghost], ghost)).toContain("unknown dependency");
		const active = node({ id: "y", status: "active" });
		expect(nodeBlockedReason([active], active)).toContain(
			"is active, not planned",
		);
	});

	it("fingerprint ignores session/process churn, sees semantic edits", () => {
		const a = authPlan();
		const b = authPlan();
		expect(planFingerprintV2(a)).toBe(planFingerprintV2(b));
		// Session bookkeeping churns on every spawn — excluded.
		const c = authPlan();
		const buildAuth = findNodeV2(c, "build-auth");
		if (buildAuth) {
			buildAuth.sessionPath = "/tmp/s.jsonl";
			buildAuth.sessionGeneration = 3;
			buildAuth.updatedAt = "2027-01-01T00:00:00Z";
		}
		expect(planFingerprintV2(c)).toBe(planFingerprintV2(a));
		// A semantic change (task text) drifts it.
		const d = authPlan();
		const target = findNodeV2(d, "build-auth");
		if (target) target.tasks[0].title = "implement rotation DIFFERENTLY";
		expect(planFingerprintV2(d)).not.toBe(planFingerprintV2(a));
	});
});

// ─── v1 survivors (schema.test.ts pins, moved here at the flip) ──────────────

describe("status transitions (canTransition)", () => {
	it("allows the forward lifecycle", () => {
		expect(canTransition("planned", "active")).toBe(true);
		expect(canTransition("planned", "abandoned")).toBe(true);
		expect(canTransition("active", "complete")).toBe(true);
		expect(canTransition("complete", "shipped")).toBe(true);
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
