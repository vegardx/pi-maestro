import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES, EVENTS, type ModeName } from "@vegardx/pi-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModesAskQueue } from "../packages/modes/src/ask-queue.js";
import {
	buildCompactionMarker,
	createCrashSnapshot,
	decideCompactionOwnership,
} from "../packages/modes/src/compaction.js";
import { PLAN_CONTAINER, PlanEngine } from "../packages/modes/src/engine.js";
import {
	classifyExecutionSteering,
	completeActiveDeliverable,
	completionGateSatisfied,
	FanoutOrchestrator,
	parseShippedPr,
	startSequentialExecution,
	transitionThrough,
} from "../packages/modes/src/execution.js";
import {
	renderPlanMarkdown,
	renderPlanSeed,
} from "../packages/modes/src/markdown.js";
import {
	classifyBash,
	computeActiveTools,
	toolBlockedInPlanMode,
} from "../packages/modes/src/policy.js";
import { createModesRuntime } from "../packages/modes/src/runtime.js";
import {
	blockedReason,
	canTransition,
	chainHead,
	type Deliverable,
	deliverables,
	derivePlanName,
	findNode,
	gatingTasks,
	isDeliverableReady,
	isGrouping,
	type Plan,
	type PlanNode,
	pickBaseBranch,
	planImplementBranch,
	planRepoMismatch,
	readyDeliverables,
	repoFor,
	shipsPR,
	slugify,
	subtreeComplete,
	validatePlanShape,
	type WorkItem,
} from "../packages/modes/src/schema.js";
import {
	hydrateModesState,
	MODES_STATE_ENTRY,
	toPersistedState,
} from "../packages/modes/src/session.js";
import {
	nextShippableDeliverable,
	parkPlan,
	shipDeliverableFromPlan,
	sweepMergedPrs,
	syncPrState,
} from "../packages/modes/src/shipping.js";
import {
	initialModesState,
	nextMode,
	setActivePlan,
	setExecution,
	transitionMode,
} from "../packages/modes/src/state.js";
import {
	createPlanStore,
	type PlanStore,
} from "../packages/modes/src/storage.js";
import {
	createDeliverableTool,
	createPlanTool,
	createTaskTool,
} from "../packages/modes/src/tools.js";
import {
	renderModeFooter,
	renderPlanPanel,
	renderPlanSidebar,
} from "../packages/modes/src/ui.js";
import {
	activateDeliverableBranch,
	activateDeliverableWorktree,
	cleanupInactiveWorktrees,
	deliverableSessionSeed,
	deliverableWorktreePath,
	reconcileWorktrees,
	recordDeliverableSession,
	recordPlanSession,
} from "../packages/modes/src/worktree.js";

let counter = 0;
const now = () => `2026-01-01T00:00:${String(counter++).padStart(2, "0")}.000Z`;

function deliverable(over: Partial<Deliverable> = {}): Deliverable {
	return {
		type: "deliverable",
		id: "d1",
		title: "D1",
		body: "",
		status: "planned",
		children: [],
		createdAt: "t",
		updatedAt: "t",
		...over,
	};
}

function task(id: string, done = false): WorkItem {
	return {
		type: "work-item",
		id,
		title: id,
		body: "",
		done,
		kind: "task",
		createdAt: "t",
		updatedAt: "t",
	};
}

function plan(nodes: PlanNode[]): Plan {
	return {
		slug: "p",
		title: "P",
		repoPath: "/repo",
		nodes,
		createdAt: "t",
		updatedAt: "t",
	};
}

describe("schema selectors", () => {
	it("classifies groupings, PR-shippers, and completion", () => {
		const child = deliverable({ id: "c", children: [task("t1")] });
		const grouping = deliverable({ id: "g", children: [child] });
		expect(isGrouping(grouping)).toBe(true);
		expect(shipsPR(grouping)).toBe(false);
		expect(shipsPR(child)).toBe(true);
		expect(subtreeComplete(grouping)).toBe(false);
		child.status = "shipped";
		expect(subtreeComplete(grouping)).toBe(true);
	});

	it("flattens deliverables in preorder", () => {
		const p = plan([
			deliverable({ id: "a", children: [deliverable({ id: "b" })] }),
			deliverable({ id: "c" }),
		]);
		expect(deliverables(p).map((d) => d.id)).toEqual(["a", "b", "c"]);
	});

	it("slugify produces kebab ids", () => {
		expect(slugify("Add the Thing!")).toBe("add-the-thing");
	});
});

describe("status transitions", () => {
	it("permits the documented flow and rejects shortcuts", () => {
		expect(canTransition("planned", "active")).toBe(true);
		expect(canTransition("active", "in-review")).toBe(true);
		expect(canTransition("planned", "shipped")).toBe(false);
		expect(canTransition("shipped", "active")).toBe(false);
		expect(canTransition("in-review", "needs-attention")).toBe(true);
	});
});

describe("dependency / activation logic", () => {
	it("blocks a successor until its parent is activatable", () => {
		const p = plan([
			deliverable({ id: "a", children: [task("t")] }),
			deliverable({ id: "b", dependsOn: ["a"], children: [task("t2")] }),
		]);
		expect(isDeliverableReady(p, p.nodes[1] as Deliverable)).toBe(false);
		expect(blockedReason(p, p.nodes[1] as Deliverable)).toContain("waiting on");
		(p.nodes[0] as Deliverable).status = "in-review";
		expect(isDeliverableReady(p, p.nodes[1] as Deliverable)).toBe(true);
		expect(readyDeliverables(p).map((d) => d.id)).toContain("b");
	});

	it("stacks the base branch on an in-flight parent", () => {
		const p = plan([
			deliverable({
				id: "a",
				status: "in-review",
				branch: "feat/a",
				children: [task("t")],
			}),
			deliverable({ id: "b", dependsOn: ["a"], children: [task("t2")] }),
		]);
		expect(pickBaseBranch(p, "b", "main")).toBe("feat/a");
		(p.nodes[0] as Deliverable).status = "shipped";
		expect(pickBaseBranch(p, "b", "main")).toBe("main");
	});

	it("does not stack across repos — cross-repo deps are ordering-only", () => {
		const p: Plan = {
			...plan([
				deliverable({
					id: "a",
					status: "in-review",
					branch: "feat/a",
					children: [task("t")],
				}),
				deliverable({
					id: "b",
					dependsOn: ["a"],
					repo: "service",
					children: [task("t2")],
				}),
			]),
			repos: [{ key: "service", path: "/svc" }],
		};
		// b targets a different repo than a, so it bases off its own default.
		expect(pickBaseBranch(p, "b", "dev")).toBe("dev");
	});

	it("chainHead walks to the next unshipped successor", () => {
		const p = plan([
			deliverable({ id: "a", status: "shipped", children: [task("t")] }),
			deliverable({ id: "b", dependsOn: ["a"], children: [task("t2")] }),
		]);
		expect(chainHead(p, { id: "a" })?.id).toBe("b");
	});

	it("planImplementBranch refuses to recreate a missing in-flight branch", () => {
		const p = plan([
			deliverable({ id: "a", status: "active", branch: "feat/a" }),
		]);
		expect(
			planImplementBranch(p, p.nodes[0] as Deliverable, "main", false).kind,
		).toBe("abort");
		expect(
			planImplementBranch(p, p.nodes[0] as Deliverable, "main", true).kind,
		).toBe("resume");
	});

	it("planRepoMismatch passes when toplevels match, flags otherwise", () => {
		expect(planRepoMismatch("/repo", "/repo", "/repo/sub", "/repo/sub")).toBe(
			null,
		);
		expect(planRepoMismatch("/repo", "/other", "/repo", "/other")).toMatch(
			/not the plan's repo/,
		);
		expect(planRepoMismatch("/repo", null, "/repo", "/elsewhere")).toMatch(
			/not inside a git repo/,
		);
		expect(planRepoMismatch(null, "/repo", "/gone", "/repo")).toMatch(
			/not a git repo/,
		);
	});
});

describe("validatePlanShape", () => {
	it("flags gating-task + child-deliverable mixing", () => {
		const p = plan([
			deliverable({ id: "a", children: [task("t"), deliverable({ id: "b" })] }),
		]);
		expect(validatePlanShape(p).join()).toContain("both gating tasks");
	});

	it("rejects dependsOn cycles and unknown targets", () => {
		const cyc = plan([
			deliverable({ id: "a", dependsOn: ["b"] }),
			deliverable({ id: "b", dependsOn: ["a"] }),
		]);
		expect(validatePlanShape(cyc).join()).toContain("cycle");
		const unknown = plan([deliverable({ id: "a", dependsOn: ["ghost"] })]);
		expect(validatePlanShape(unknown).join()).toContain("unknown");
	});

	it("rejects more than one pre/post lifecycle", () => {
		const p = plan([
			deliverable({ id: "a", lifecycle: "pre" }),
			deliverable({ id: "b", lifecycle: "pre" }),
		]);
		expect(validatePlanShape(p).join()).toContain("at most one");
	});
});

describe("PlanStore", () => {
	let store: PlanStore;
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-plans-"));
		store = createPlanStore(root);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("roundtrips and lists plans", () => {
		store.save(plan([deliverable()]));
		expect(store.exists("p")).toBe(true);
		expect(store.load("p")?.nodes).toHaveLength(1);
		expect(store.list().map((s) => s.slug)).toEqual(["p"]);
		store.remove("p");
		expect(store.exists("p")).toBe(false);
	});

	it("rejects an invalid slug and refuses traversal", () => {
		expect(() => store.save({ ...plan([]), slug: "../escape" })).toThrow(
			/invalid plan slug/,
		);
		expect(store.load("../../etc/passwd")).toBeNull();
	});

	it("derivePlanName builds a short slug + title from a seed, falls back", () => {
		expect(
			derivePlanName("Add multi-repo support to the planner", "repo"),
		).toEqual({
			slug: "add-multi-repo-support-to-the-planner",
			title: "Add multi-repo support to the planner",
		});
		// First line only; long sentences don't become the identifier.
		expect(derivePlanName("line one\nline two", "repo").slug).toBe("line-one");
		expect(derivePlanName("", "my-repo")).toEqual({
			slug: "my-repo",
			title: "my-repo",
		});
		expect(derivePlanName("!!! ???", "fallback").slug).toBe("fallback");
	});

	it("keeps draft plans off disk until materialized", () => {
		const draft = PlanEngine.createDraft(store, {
			slug: "draft",
			title: "Untitled",
			repoPath: "/repo",
		});
		expect(draft.isDraft()).toBe(true);
		// A mutation while draft updates memory but writes nothing.
		draft.addDeliverable({ title: "A", dependsOn: [] });
		expect(store.exists("draft")).toBe(false);
		expect(store.list()).toHaveLength(0);
		expect(deliverables(draft.get())).toHaveLength(1);
		// Materialize assigns identity and persists once, with prior content.
		draft.materialize("named-plan", "Named plan");
		expect(draft.isDraft()).toBe(false);
		expect(store.exists("named-plan")).toBe(true);
		expect(store.load("named-plan")?.title).toBe("Named plan");
		expect(store.load("named-plan")?.nodes).toHaveLength(1);
		// Post-materialize mutations persist normally.
		draft.addDeliverable({ title: "B", dependsOn: [] });
		expect(store.load("named-plan")?.nodes).toHaveLength(2);
	});
});

describe("PlanEngine", () => {
	let store: PlanStore;
	let root: string;
	let engine: PlanEngine;
	beforeEach(() => {
		counter = 0;
		root = mkdtempSync(join(tmpdir(), "maestro-engine-"));
		store = createPlanStore(root);
		engine = PlanEngine.create(
			store,
			{ slug: "p", title: "P", repoPath: "/repo" },
			now,
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("adds deliverables chained off the previous sibling by default", () => {
		const a = engine.addDeliverable({ title: "First" });
		const b = engine.addDeliverable({ title: "Second" });
		expect(a.dependsOn).toEqual([]);
		expect(b.dependsOn).toEqual([a.id]);
		expect(b.branch).toBe(`feat/${b.id}`);
		// Persisted.
		expect(store.load("p")?.nodes).toHaveLength(2);
	});

	it("generates unique ids on collision", () => {
		const a = engine.addDeliverable({ title: "Thing" });
		const b = engine.addDeliverable({ title: "Thing" });
		expect(a.id).toBe("thing");
		expect(b.id).toBe("thing-2");
	});

	it("validates status transitions", () => {
		const a = engine.addDeliverable({ title: "A" });
		expect(() => engine.setStatus(a.id, "shipped")).toThrow(/illegal/);
		engine.setStatus(a.id, "active");
		expect(engine.get().nodes[0]).toMatchObject({ status: "active" });
	});

	it("manages work items and gating rules", () => {
		const a = engine.addDeliverable({ title: "A" });
		const t = engine.addWorkItem(a.id, { title: "do it", kind: "task" });
		expect(engine.toggleWorkItem(t.id)).toBe(true);
		expect(gatingTasks(engine.get().nodes[0] as Deliverable)).toHaveLength(1);
		// A plan-level loose item cannot be a gating task.
		expect(() =>
			engine.addWorkItem(PLAN_CONTAINER, { title: "loose", kind: "task" }),
		).toThrow(/cannot be gating/);
		const note = engine.addWorkItem(PLAN_CONTAINER, {
			title: "note",
			kind: "followup",
		});
		expect(engine.get().nodes.find((n) => n.id === note.id)).toBeTruthy();
	});

	it("records an answer and marks the question done", () => {
		const a = engine.addDeliverable({ title: "A" });
		const q = engine.addWorkItem(a.id, { title: "which?", kind: "question" });
		engine.updateWorkItem(q.id, { answer: "this one" });
		const stored = store.load("p");
		const item = (stored?.nodes[0] as Deliverable).children[0] as WorkItem;
		expect(item.answer).toBe("this one");
		expect(item.done).toBe(true);
		expect(item.decidedAt).toBeTruthy();
	});

	it("refuses a mutation that would invalidate the plan", () => {
		const a = engine.addDeliverable({ title: "A" });
		engine.addWorkItem(a.id, { title: "gate", kind: "task" });
		// Adding a child deliverable to a gating-task deliverable is invalid.
		expect(() =>
			engine.addDeliverable({ title: "child", parentId: a.id }),
		).toThrow(/invalid plan/);
		// The on-disk plan is untouched (still one node with its task).
		expect((store.load("p")?.nodes[0] as Deliverable).children).toHaveLength(1);
	});

	it("moves a work item between containers", () => {
		const a = engine.addDeliverable({ title: "A" });
		const note = engine.addWorkItem(a.id, { title: "note", kind: "followup" });
		engine.moveWorkItem(note.id, PLAN_CONTAINER);
		expect(engine.get().nodes.some((n) => n.id === note.id)).toBe(true);
		expect((engine.get().nodes[0] as Deliverable).children).toHaveLength(0);
	});
});

// Host tools execute as (id, params, signal?, _, ctx). Tests only need params.
function exec(
	tool: { execute: (...args: any[]) => Promise<any> },
	params: unknown,
) {
	return tool.execute("tool-call", params, undefined, undefined, {} as any);
}

describe("plan markdown", () => {
	it("renders deliverables, loose items, and answers", () => {
		const p = plan([
			deliverable({
				id: "pre",
				title: "Preflight",
				lifecycle: "pre",
				children: [{ ...task("manual", true), kind: "manual" }],
			}),
			deliverable({
				id: "ship",
				title: "Ship it",
				body: "What ships.",
				branch: "feat/ship",
				children: [
					task("gate"),
					{
						type: "work-item",
						id: "q",
						title: "Pick one",
						body: "",
						done: true,
						kind: "question",
						answer: "A",
						createdAt: "t",
						updatedAt: "t",
					},
				],
			}),
			{ ...task("loose"), kind: "followup" },
		]);
		const text = renderPlanMarkdown(p);
		expect(text).toContain("# P (`p`)");
		expect(text).toContain("## Preflight");
		expect(text).toContain("### Ship it `ship` [planned]");
		expect(text).toContain("> What ships.");
		expect(text).toContain("- [ ] **gate** `gate`");
		expect(text).toContain("→ answer: A");
		expect(text).toContain("## Loose items");
	});

	it("renders a deterministic plan seed", () => {
		const p = plan([
			deliverable({ id: "a", title: "A", status: "shipped", summary: "done" }),
			deliverable({ id: "b", title: "B", dependsOn: ["a"] }),
		]);
		const seed = renderPlanSeed(p, "b");
		expect(seed).toContain("# Maestro plan context");
		expect(seed).toContain("- a: shipped — A");
		// Dependency summaries are carried into the dependent's seed verbatim.
		expect(seed).toContain("## Carry-forward from dependencies");
		expect(seed).toContain("### `a` — A");
		expect(seed).toContain("done");
		expect(seed).toContain("→ b: planned depends on a — B");
	});
});

describe("plan tools", () => {
	let store: PlanStore;
	let root: string;
	let engine: PlanEngine;
	let changed = 0;
	beforeEach(() => {
		counter = 0;
		changed = 0;
		root = mkdtempSync(join(tmpdir(), "maestro-tools-"));
		store = createPlanStore(root);
		engine = PlanEngine.create(
			store,
			{ slug: "p", title: "P", repoPath: "/repo" },
			now,
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function deps() {
		return {
			engine: () => engine,
			onPlanChanged: () => {
				changed += 1;
			},
		};
	}

	it("performs deliverable CRUD and list actions", async () => {
		const tool = createDeliverableTool(deps());
		const added = await exec(tool, {
			action: "add",
			title: "First",
			body: "body",
			dependsOn: [],
		});
		expect(added.details.deliverable.id).toBe("first");
		expect(changed).toBe(1);

		await exec(tool, { action: "add", title: "Second" });
		await exec(tool, { action: "reorder", id: "second", position: 0 });
		expect((engine.get().nodes[0] as Deliverable).id).toBe("second");

		await exec(tool, { action: "update", id: "first", title: "Renamed" });
		expect(
			deliverables(engine.get()).find((d) => d.id === "first")?.title,
		).toBe("Renamed");

		const listed = await exec(tool, { action: "list" });
		expect(listed.content[0].text).toContain("first: planned — Renamed");

		await exec(tool, { action: "remove", id: "second" });
		expect(deliverables(engine.get()).map((d) => d.id)).toEqual(["first"]);
	});

	it("registers repos and assigns deliverable repos", async () => {
		const tool = createDeliverableTool(deps());
		await exec(tool, {
			action: "register-repo",
			repo: "service",
			repoPath: "/svc",
			repoDefaultBranch: "dev",
		});
		expect(engine.get().repos).toEqual([
			{ key: "service", path: "/svc", defaultBranch: "dev" },
		]);

		await exec(tool, {
			action: "add",
			title: "Svc work",
			dependsOn: [],
			repo: "service",
		});
		const find = () =>
			deliverables(engine.get()).find((d) => d.id === "svc-work");
		expect(find()?.repo).toBe("service");

		const bad = await exec(tool, {
			action: "update",
			id: "svc-work",
			repo: "ghost",
		});
		expect(bad.details.error).toContain("unknown repo `ghost`");
		expect(find()?.repo).toBe("service");

		await exec(tool, { action: "update", id: "svc-work", repo: "default" });
		expect(find()?.repo).toBeUndefined();

		await exec(tool, { action: "unregister-repo", repo: "service" });
		expect(engine.get().repos).toEqual([]);
	});

	it("rejects unregistering a repo still in use", async () => {
		const tool = createDeliverableTool(deps());
		await exec(tool, {
			action: "register-repo",
			repo: "service",
			repoPath: "/svc",
		});
		await exec(tool, {
			action: "add",
			title: "Svc",
			dependsOn: [],
			repo: "service",
		});
		const failed = await exec(tool, {
			action: "unregister-repo",
			repo: "service",
		});
		expect(failed.details.error).toContain("unknown repo `service`");
		expect(engine.get().repos).toHaveLength(1);
	});

	it("surfaces validation errors without mutating the plan", async () => {
		const dTool = createDeliverableTool(deps());
		const tTool = createTaskTool(deps());
		await exec(dTool, { action: "add", title: "A" });
		await exec(tTool, { action: "add", deliverableId: "a", title: "gate" });
		const failed = await exec(dTool, {
			action: "add",
			title: "Child",
			parentId: "a",
		});
		expect(failed.details.error).toContain("invalid plan");
		expect((engine.get().nodes[0] as Deliverable).children).toHaveLength(1);
	});

	it("performs work-item CRUD including move and answer stamping", async () => {
		const dTool = createDeliverableTool(deps());
		const tTool = createTaskTool(deps());
		await exec(dTool, { action: "add", title: "A" });
		await exec(dTool, { action: "add", title: "B" });
		const added = await exec(tTool, {
			action: "add",
			deliverableId: "a",
			title: "Question",
			kind: "question",
		});
		const id = added.details.workItem.id;
		await exec(tTool, { action: "update", id, answer: "yes" });
		expect(added.details.workItem.done).toBe(false);
		expect((findNode(engine.get(), id) as WorkItem).answer).toBe("yes");
		const toggled = await exec(tTool, { action: "toggle", id });
		expect(toggled.details.done).toBe(false);
		await exec(tTool, { action: "move", id, targetDeliverableId: "b" });
		expect((engine.get().nodes[1] as Deliverable).children[0]).toMatchObject({
			id,
		});
		await exec(tTool, { action: "remove", id });
		expect((engine.get().nodes[1] as Deliverable).children).toHaveLength(0);
	});

	it("returns markdown, seed, and json views", async () => {
		engine.addDeliverable({ title: "A" });
		const tool = createPlanTool(deps());
		const md = await exec(tool, {});
		expect(md.content[0].text).toContain("1. A [");
		const seed = await exec(tool, { view: "seed", activeDeliverableId: "a" });
		expect(seed.content[0].text).toContain("Active deliverable: a");
		const json = await exec(tool, { view: "json" });
		expect(json.content[0].text).toContain('"slug": "p"');
	});

	it("reports missing active plan", async () => {
		const tool = createPlanTool({ engine: () => undefined });
		const result = await exec(tool, {});
		expect(result.details.error).toContain("no plan active");
	});
});

describe("plan lifecycle guards", () => {
	let store: PlanStore;
	let root: string;
	let engine: PlanEngine;
	beforeEach(() => {
		counter = 0;
		root = mkdtempSync(join(tmpdir(), "maestro-guards-"));
		store = createPlanStore(root);
		engine = PlanEngine.create(
			store,
			{ slug: "p", title: "P", repoPath: "/repo" },
			now,
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function deps() {
		return { engine: () => engine, onPlanChanged: () => {} };
	}

	it("allows all actions before execution starts", async () => {
		const dTool = createDeliverableTool(deps());
		const tTool = createTaskTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		await exec(dTool, { action: "add", title: "B" });
		await exec(tTool, { action: "add", deliverableId: "a", title: "t1" });
		// All are planned — no guards fire
		const upd = await exec(dTool, { action: "update", id: "a", title: "A2" });
		expect(upd.details.error).toBeUndefined();
		const reord = await exec(dTool, {
			action: "reorder",
			id: "b",
			position: 0,
		});
		expect(reord.details.error).toBeUndefined();
		const rem = await exec(dTool, { action: "remove", id: "b" });
		expect(rem.details.error).toBeUndefined();
	});

	it("blocks reorder after execution starts", async () => {
		const dTool = createDeliverableTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		await exec(dTool, { action: "add", title: "B" });
		engine.setStatus("a", "active");
		const result = await exec(dTool, {
			action: "reorder",
			id: "b",
			position: 0,
		});
		expect(result.details.error).toContain("Cannot reorder");
	});

	it("blocks remove on active deliverable", async () => {
		const dTool = createDeliverableTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		engine.setStatus("a", "active");
		const result = await exec(dTool, { action: "remove", id: "a" });
		expect(result.details.error).toContain("Cannot remove an active");
		expect(result.details.error).toContain("abandoned");
	});

	it("allows remove on planned deliverable after execution starts", async () => {
		const dTool = createDeliverableTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		await exec(dTool, { action: "add", title: "B" });
		engine.setStatus("a", "active");
		// B is still planned — can be removed
		const result = await exec(dTool, { action: "remove", id: "b" });
		expect(result.details.error).toBeUndefined();
	});

	it("blocks title/body update on active deliverable", async () => {
		const dTool = createDeliverableTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		engine.setStatus("a", "active");
		const r1 = await exec(dTool, { action: "update", id: "a", title: "New" });
		expect(r1.details.error).toContain("Cannot update title/body");
		const r2 = await exec(dTool, { action: "update", id: "a", body: "New" });
		expect(r2.details.error).toContain("Cannot update title/body");
	});

	it("blocks dependsOn change on active deliverable", async () => {
		const dTool = createDeliverableTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		await exec(dTool, { action: "add", title: "B" });
		engine.setStatus("a", "active");
		const result = await exec(dTool, {
			action: "update",
			id: "a",
			dependsOn: ["b"],
		});
		expect(result.details.error).toContain("Cannot change dependencies");
	});

	it("allows status update to abandoned (escape hatch)", async () => {
		const dTool = createDeliverableTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		engine.setStatus("a", "active");
		const result = await exec(dTool, {
			action: "update",
			id: "a",
			status: "abandoned",
		});
		expect(result.details.error).toBeUndefined();
	});

	it("always allows deliverable add after execution starts", async () => {
		const dTool = createDeliverableTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		engine.setStatus("a", "active");
		const result = await exec(dTool, {
			action: "add",
			title: "C",
			dependsOn: [],
		});
		expect(result.details.error).toBeUndefined();
		expect(result.details.deliverable?.id).toBe("c");
	});

	it("allows task add to active deliverable (relayed)", async () => {
		const dTool = createDeliverableTool(deps());
		const tTool = createTaskTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		engine.setStatus("a", "active");
		const result = await exec(tTool, {
			action: "add",
			deliverableId: "a",
			title: "new task",
		});
		expect(result.details.error).toBeUndefined();
	});

	it("blocks task remove from active deliverable", async () => {
		const dTool = createDeliverableTool(deps());
		const tTool = createTaskTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		await exec(tTool, { action: "add", deliverableId: "a", title: "t1" });
		engine.setStatus("a", "active");
		const result = await exec(tTool, {
			action: "remove",
			id: "t1",
			deliverableId: "a",
		});
		expect(result.details.error).toContain("Cannot remove tasks");
	});

	it("blocks task update on active deliverable", async () => {
		const dTool = createDeliverableTool(deps());
		const tTool = createTaskTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		await exec(tTool, { action: "add", deliverableId: "a", title: "t1" });
		engine.setStatus("a", "active");
		const result = await exec(tTool, {
			action: "update",
			id: "t1",
			deliverableId: "a",
			title: "renamed",
		});
		expect(result.details.error).toContain("Cannot update tasks");
	});

	it("allows task toggle on active deliverable", async () => {
		const dTool = createDeliverableTool(deps());
		const tTool = createTaskTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		await exec(tTool, { action: "add", deliverableId: "a", title: "t1" });
		engine.setStatus("a", "active");
		const result = await exec(tTool, { action: "toggle", id: "t1" });
		expect(result.details.error).toBeUndefined();
		expect(result.details.done).toBe(true);
	});

	it("allows task update on planned deliverable after execution starts", async () => {
		const dTool = createDeliverableTool(deps());
		const tTool = createTaskTool(deps());
		await exec(dTool, { action: "add", title: "A", dependsOn: [] });
		await exec(dTool, { action: "add", title: "B" });
		await exec(tTool, { action: "add", deliverableId: "b", title: "t2" });
		engine.setStatus("a", "active");
		// B is still planned — task update allowed
		const result = await exec(tTool, {
			action: "update",
			id: "t2",
			deliverableId: "b",
			title: "renamed",
		});
		expect(result.details.error).toBeUndefined();
	});
});

describe("mode state and policy", () => {
	it("cycles modes and persists active plan", () => {
		const state = initialModesState(now);
		expect(state.mode).toBe("plan");
		expect(nextMode("hack")).toBe("plan");
		expect(nextMode("auto")).toBe("hack");
		const changed = transitionMode(state, "auto", now);
		expect(changed.previous).toBe("plan");
		const withPlan = setActivePlan(changed.state, "p", now);
		expect(toPersistedState(withPlan)).toMatchObject({
			version: 2,
			mode: "auto",
			activePlanSlug: "p",
		});
	});

	it("hydrates the latest mode state from session entries", () => {
		const entries = [
			{
				type: "custom",
				id: "1",
				parentId: null,
				timestamp: "t",
				customType: MODES_STATE_ENTRY,
				data: {
					version: 1,
					mode: "plan",
					activePlanSlug: "old",
					updatedAt: "1",
				},
			},
			{
				type: "custom",
				id: "2",
				parentId: "1",
				timestamp: "t",
				customType: MODES_STATE_ENTRY,
				data: {
					version: 1,
					mode: "auto",
					activePlanSlug: "new",
					updatedAt: "2",
				},
			},
		] as any[];
		expect(hydrateModesState(entries)).toEqual({
			mode: "auto",
			activePlanSlug: "new",
			execution: { stage: "idle" },
			updatedAt: "2",
		});
	});

	it("narrows active tools in plan and auto mode", () => {
		const tools = [
			"read",
			"bash",
			"edit",
			"deliverable",
			"task",
			"plan",
			"ask",
		];
		// Plan mode: read-only + plan tools + bash (via classifier) + always-allowed
		expect(
			computeActiveTools({
				mode: "plan",
				availableTools: tools,
				baselineTools: tools,
			}),
		).toEqual(["read", "bash", "deliverable", "task", "plan", "ask"]);
		// Auto mode: same restricted set as plan (bash gated by classifier)
		expect(
			computeActiveTools({
				mode: "auto",
				availableTools: tools,
				baselineTools: ["edit"],
			}),
		).toEqual(["read", "bash", "deliverable", "task", "plan", "ask"]);
		// Hack mode: full baseline
		expect(
			computeActiveTools({
				mode: "hack",
				availableTools: tools,
				baselineTools: tools,
			}),
		).toEqual(tools);
	});

	it("classifies bash commands for plan mode", () => {
		expect(classifyBash("git status --short").readOnly).toBe(true);
		expect(classifyBash("git branch -vv").readOnly).toBe(true);
		expect(classifyBash("git branch feat/x").readOnly).toBe(false);
		expect(classifyBash("echo hi > file").readOnly).toBe(false);
		expect(classifyBash("rm file").readOnly).toBe(false);
		expect(toolBlockedInPlanMode("edit")).toContain("disabled");
		expect(toolBlockedInPlanMode("deliverable")).toBeNull();
	});
});

describe("modes ask queue", () => {
	it("batches queued questions into ask.v1", () => {
		const queue = new ModesAskQueue();
		const batches: unknown[] = [];
		queue.enqueue([{ id: "a", question: "A?" }]);
		queue.enqueue([{ id: "b", question: "B?" }]);
		expect(queue.size).toBe(2);
		const flushed = queue.flushTo({
			ask: async () => [],
			queue: (questions) => batches.push(questions),
		});
		expect(flushed).toBe(2);
		expect(queue.size).toBe(0);
		expect(batches).toEqual([
			[
				{ id: "a", question: "A?" },
				{ id: "b", question: "B?" },
			],
		]);
	});
});

describe("modes runtime", () => {
	let root: string;
	let store: PlanStore;
	beforeEach(() => {
		counter = 0;
		root = mkdtempSync(join(tmpdir(), "maestro-runtime-"));
		store = createPlanStore(root);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function fakeHost() {
		const commands = new Map<string, any>();
		const handlers = new Map<string, any[]>();
		const tools: any[] = [];
		const shortcuts = new Map<string, any>();
		const entries: any[] = [];
		const notifications: string[] = [];
		const statuses = new Map<string, string | undefined>();
		const messages: any[] = [];
		let activeTools = ["read", "edit", "bash"];
		const allToolNames = [
			"read",
			"edit",
			"bash",
			"deliverable",
			"task",
			"plan",
			"ask",
		];
		const pi = {
			on: (name: string, handler: any) => {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			registerTool: (tool: any) => tools.push(tool),
			registerCommand: (name: string, options: any) =>
				commands.set(name, options),
			registerShortcut: (key: string, options: any) =>
				shortcuts.set(key, options),
			appendEntry: (customType: string, data?: unknown) => {
				entries.push({
					type: "custom",
					id: String(entries.length + 1),
					parentId: null,
					timestamp: "t",
					customType,
					data,
				});
			},
			getActiveTools: () => activeTools,
			getAllTools: () => allToolNames.map((name) => ({ name })),
			setActiveTools: (next: string[]) => {
				activeTools = next;
			},
			sendMessage: (message: unknown, options: unknown) =>
				messages.push({ message, options }),
			events: { emit: () => {}, on: () => () => {} },
		};
		const ctx = {
			cwd: "/repo/project",
			hasUI: true,
			ui: {
				notify: (message: string) => notifications.push(message),
				setStatus: (key: string, value: string | undefined) =>
					statuses.set(key, value),
				select: async () => "auto \u2014 fully autonomous",
			},
			sessionManager: {
				getEntries: () => entries,
				getSessionFile: () => "/sessions/current.jsonl",
			},
		};
		const emitted: Array<{ name: string; payload: unknown }> = [];
		const caps = new Map<string, unknown>();
		const maestro = {
			name: "modes",
			events: {
				emit: (name: string, payload: unknown) =>
					emitted.push({ name, payload }),
				on: () => () => {},
			},
			capabilities: {
				register: (id: string, cap: unknown) => caps.set(id, cap),
				get: (id: string) => caps.get(id),
			},
			flags: { enabled: () => true },
		};
		return {
			pi,
			ctx,
			commands,
			handlers,
			tools,
			shortcuts,
			entries,
			notifications,
			statuses,
			messages,
			emitted,
			caps,
			activeTools: () => activeTools,
			maestro,
		};
	}

	it("registers tools, commands, shortcut, and capability", () => {
		const host = fakeHost();
		createModesRuntime(host.pi as any, host.maestro as any, { store, now });
		expect(host.tools.map((t) => t.name)).toEqual([
			"deliverable",
			"task",
			"plan",
			"review",
			"refine",
			"validate",
			"ship",
		]);
		expect([...host.commands.keys()]).toEqual(
			expect.arrayContaining([
				"plan",
				"implement",
				"hack",
				"auto",
				"answer",
				"review",
				"refine",
				"validate",
				"modes-status",
			]),
		);
		expect(host.shortcuts.has("shift+tab")).toBe(true);
		expect(host.caps.has(CAPABILITIES.modes)).toBe(true);
	});

	it("exposes a read-only execution status capability (idle by default)", () => {
		const host = fakeHost();
		createModesRuntime(host.pi as any, host.maestro as any, { store, now });
		const cap = host.caps.get(CAPABILITIES.modes) as any;
		expect(cap.execution()).toMatchObject({
			mode: "plan",
			executing: false,
			compactionInFlight: false,
		});
	});

	it("hydrates an executing deliverable into the execution capability", () => {
		const host = fakeHost();
		const persisted = toPersistedState(
			setExecution(
				{ ...initialModesState(now), mode: "auto" },
				{ stage: "executing", deliverableId: "d1" },
				now,
			),
		);
		host.entries.push({
			type: "custom",
			id: "1",
			parentId: null,
			timestamp: "t",
			customType: MODES_STATE_ENTRY,
			data: persisted,
		});
		createModesRuntime(host.pi as any, host.maestro as any, { store, now });
		host.handlers.get("session_start")?.[0]({}, host.ctx);
		const cap = host.caps.get(CAPABILITIES.modes) as any;
		expect(cap.execution()).toMatchObject({
			mode: "auto",
			activeDeliverableId: "d1",
			executing: true,
			compactionInFlight: false,
		});
	});

	it("injects plan-mode preamble only when in plan mode", () => {
		const host = fakeHost();
		const runtime = createModesRuntime(host.pi as any, host.maestro as any, {
			store,
			now,
		});
		const hook = host.handlers.get("before_agent_start")?.[0];
		expect(hook).toBeDefined();
		// In auto/ask/hack mode: no system prompt override.
		runtime.setMode("auto" as ModeName, host.ctx as any);
		const autoResult = hook({ systemPrompt: "base", prompt: "hi" }, host.ctx);
		expect(autoResult).toBeUndefined();
		// In plan mode: preamble is appended.
		runtime.setMode("plan" as ModeName, host.ctx as any);
		const planResult = hook(
			{ systemPrompt: "base", prompt: "hi" },
			host.ctx,
		) as { systemPrompt: string };
		expect(planResult.systemPrompt).toContain("PLAN MODE");
		expect(planResult.systemPrompt).toContain("base");
	});

	it("renders the context budget breakdown in the footer during ask/auto", () => {
		const host = fakeHost();
		createModesRuntime(host.pi as any, host.maestro as any, { store, now });
		host.commands.get("auto").handler("", host.ctx);
		expect(host.statuses.get("maestro.mode")).toContain("/250000");
	});

	it("opens a plan through /plan and hydrates session state", async () => {
		const host = fakeHost();
		host.caps.set(CAPABILITIES.ask, {
			ask: async () => [],
			queue: () => {},
		});
		const runtime = createModesRuntime(host.pi as any, host.maestro as any, {
			store,
			now,
		});
		await host.commands.get("plan").handler("My Plan", host.ctx);
		expect(runtime.currentMode()).toBe("plan");
		// A named /plan still starts as a draft and isn't persisted until content.
		expect(runtime.currentEngine()?.isDraft()).toBe(true);
		expect(store.exists("my-plan")).toBe(false);
		expect(host.messages[0].message.content).toContain("My Plan");
		// Add content and end the turn -> persists under the explicit name.
		runtime.currentEngine()?.addDeliverable({ title: "A", dependsOn: [] });
		await host.handlers.get("turn_end")?.[0]({}, host.ctx);
		expect(runtime.currentEngine()?.get().slug).toBe("my-plan");
		expect(store.exists("my-plan")).toBe(true);
		expect(host.emitted.map((e) => e.name)).toContain(EVENTS.planUpdated);

		const host2 = fakeHost();
		host2.entries.push(...host.entries);
		const runtime2 = createModesRuntime(host2.pi as any, host2.maestro as any, {
			store,
			now,
		});
		host2.handlers.get("session_start")?.[0]({}, host2.ctx);
		expect(runtime2.currentMode()).toBe("plan");
		expect(runtime2.currentEngine()?.get().slug).toBe("my-plan");
	});

	it("applies plan-mode tool and bash policy", async () => {
		const host = fakeHost();
		createModesRuntime(host.pi as any, host.maestro as any, { store, now });
		await host.commands.get("plan").handler("My Plan", host.ctx);
		expect(host.activeTools()).toEqual([
			"read",
			"bash",
			"deliverable",
			"task",
			"plan",
			"ask",
		]);
		const pushResult = await host.handlers.get("tool_call")?.[0]({
			toolName: "bash",
			input: { command: "git push" },
		});
		// git push is allowed in auto mode (not destructive)
		expect(pushResult).toBeUndefined();
		// rm -rf is still blocked
		const blocked = await host.handlers.get("tool_call")?.[0]({
			toolName: "bash",
			input: { command: "rm -rf /tmp/foo" },
		});
		expect(blocked).toMatchObject({ block: true });
		const allowed = await host.handlers.get("tool_call")?.[0]({
			toolName: "bash",
			input: { command: "git status" },
		});
		expect(allowed).toBeUndefined();
	});

	it("does not block ship/review/write/edit in auto mode", async () => {
		const host = fakeHost();
		const runtime = createModesRuntime(host.pi as any, host.maestro as any, {
			store,
			now,
		});
		await host.commands.get("plan").handler("My Plan", host.ctx);
		// Transition to auto mode
		await host.shortcuts.get("shift+tab").handler(host.ctx);
		expect(runtime.currentMode()).toBe("auto");

		// These tools should NOT be blocked in auto mode
		for (const toolName of ["ship", "review", "edit", "write"]) {
			const result = await host.handlers.get("tool_call")?.[0]({
				toolName,
				input: {},
			});
			expect(result).toBeUndefined();
		}
	});

	it("blocks ship/review/write/edit in plan mode", async () => {
		const host = fakeHost();
		createModesRuntime(host.pi as any, host.maestro as any, { store, now });
		await host.commands.get("plan").handler("My Plan", host.ctx);

		for (const toolName of ["ship", "review", "edit", "write"]) {
			const result = await host.handlers.get("tool_call")?.[0]({
				toolName,
				input: {},
			});
			expect(result).toMatchObject({ block: true });
			expect(result.reason).toContain("disabled in plan mode");
		}
	});

	it("cycles plan mode to auto and flushes queued ask on turn_end", async () => {
		const host = fakeHost();
		const runtime = createModesRuntime(host.pi as any, host.maestro as any, {
			store,
			now,
		});
		const askBatches: unknown[] = [];
		host.caps.set(CAPABILITIES.ask, {
			ask: async () => [],
			queue: (questions: unknown) => askBatches.push(questions),
		});
		await host.commands.get("plan").handler("My Plan", host.ctx);
		await host.shortcuts.get("shift+tab").handler(host.ctx);
		expect(runtime.currentMode()).toBe("auto");
		runtime.setMode("plan" as ModeName, host.ctx as any);
		runtime.askQueue.enqueue([{ id: "q", question: "Q?" }]);
		host.handlers.get("turn_end")?.[0]({}, host.ctx);
		expect(askBatches).toEqual([[{ id: "q", question: "Q?" }]]);
	});

	it("cycle from plan mode transitions to auto and starts execution", async () => {
		const host = fakeHost();
		const runtime = createModesRuntime(host.pi as any, host.maestro as any, {
			store,
			now,
		});
		await host.commands.get("plan").handler("My Plan", host.ctx);
		runtime.currentEngine()?.addDeliverable({ title: "A", dependsOn: [] });
		runtime.setMode("plan" as ModeName, host.ctx as any);
		await runtime.cycle(host.ctx as any);
		expect(runtime.currentMode()).toBe("auto");
	});

	it("/plan opens a draft and names+persists it from the first message", async () => {
		const host = fakeHost();
		host.caps.set(CAPABILITIES.ask, {
			ask: async () => [],
			queue: () => {},
		});
		const runtime = createModesRuntime(host.pi as any, host.maestro as any, {
			store,
			now,
		});
		await host.commands.get("plan").handler("", host.ctx);
		expect(runtime.currentEngine()?.isDraft()).toBe(true);
		expect(store.list()).toHaveLength(0);
		// User describes the plan, then a deliverable is added (still draft).
		host.entries.push({
			type: "message",
			message: { role: "user", content: "Build a CSV exporter" },
		});
		runtime.currentEngine()?.addDeliverable({ title: "A", dependsOn: [] });
		expect(store.list()).toHaveLength(0);
		// Turn ends while planning -> materialize under the derived slug.
		await host.handlers.get("turn_end")?.[0]({}, host.ctx);
		expect(runtime.currentEngine()?.isDraft()).toBe(false);
		expect(runtime.currentEngine()?.get().slug).toBe("build-a-csv-exporter");
		expect(store.exists("build-a-csv-exporter")).toBe(true);
	});

	it("/plan leaves no file behind when nothing is added", async () => {
		const host = fakeHost();
		host.caps.set(CAPABILITIES.ask, {
			ask: async () => [],
			queue: () => {},
		});
		const runtime = createModesRuntime(host.pi as any, host.maestro as any, {
			store,
			now,
		});
		await host.commands.get("plan").handler("", host.ctx);
		host.entries.push({
			type: "message",
			message: { role: "user", content: "just exploring" },
		});
		await host.handlers.get("turn_end")?.[0]({}, host.ctx);
		expect(runtime.currentEngine()?.isDraft()).toBe(true);
		expect(store.list()).toHaveLength(0);
	});

	it("/plan with no args keeps the already-active plan", async () => {
		const host = fakeHost();
		host.caps.set(CAPABILITIES.ask, {
			ask: async () => [],
			queue: () => {},
		});
		const runtime = createModesRuntime(host.pi as any, host.maestro as any, {
			store,
			now,
		});
		// Open and materialize a plan.
		await host.commands.get("plan").handler("My Plan", host.ctx);
		runtime.currentEngine()?.addDeliverable({ title: "A", dependsOn: [] });
		await host.handlers.get("turn_end")?.[0]({}, host.ctx);
		expect(runtime.currentEngine()?.get().slug).toBe("my-plan");
		// Re-run /plan with no args -> same engine, not a new draft.
		await host.commands.get("plan").handler("", host.ctx);
		expect(runtime.currentEngine()?.get().slug).toBe("my-plan");
		expect(runtime.currentEngine()?.isDraft()).toBe(false);
	});
});

describe("execution driver", () => {
	let store: PlanStore;
	let root: string;
	let engine: PlanEngine;
	beforeEach(() => {
		counter = 0;
		root = mkdtempSync(join(tmpdir(), "maestro-execution-"));
		store = createPlanStore(root);
		engine = PlanEngine.create(
			store,
			{ slug: "p", title: "P", repoPath: "/repo" },
			now,
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("starts the next ready deliverable sequentially and emits a seed", () => {
		const a = engine.addDeliverable({ title: "A" });
		engine.addWorkItem(a.id, { title: "gate" });
		let seed = "";
		const result = startSequentialExecution(engine, {
			sendSeed: (text) => {
				seed = text;
			},
		});
		expect(result.kind).toBe("started");
		expect(deliverables(engine.get())[0].status).toBe("active");
		expect(seed).toContain("Active deliverable: a");
		expect(startSequentialExecution(engine).kind).toBe("already-active");
	});

	it("blocks sequential execution on incomplete preflight", () => {
		const pre = engine.addDeliverable({ title: "Pre", lifecycle: "pre" });
		engine.addWorkItem(pre.id, { title: "check", kind: "manual" });
		engine.addDeliverable({ title: "A" });
		expect(startSequentialExecution(engine)).toMatchObject({ kind: "blocked" });
	});

	it("completes an active deliverable only when gating tasks are done", () => {
		const a = engine.addDeliverable({ title: "A" });
		const gate = engine.addWorkItem(a.id, { title: "gate" });
		engine.setStatus(a.id, "active");
		expect(completionGateSatisfied(deliverables(engine.get())[0])).toBe(false);
		expect(completeActiveDeliverable(engine, a.id)).toBe(false);
		engine.toggleWorkItem(gate.id);
		expect(completionGateSatisfied(deliverables(engine.get())[0])).toBe(true);
		expect(completeActiveDeliverable(engine, a.id)).toBe(true);
		expect(deliverables(engine.get())[0].status).toBe("in-review");
	});

	it("classifies steering and parses shipped PR references", () => {
		expect(classifyExecutionSteering("status please")).toBe("status");
		expect(classifyExecutionSteering("stop this run")).toBe("stop");
		expect(classifyExecutionSteering("keep going")).toBe("continue");
		expect(parseShippedPr("shipped PR #42")).toBe(42);
		expect(parseShippedPr("https://github.com/o/r/pull/7")).toBe(7);
	});

	it("transitions through intermediate states", () => {
		const a = engine.addDeliverable({ title: "A" });
		transitionThrough(engine, a.id, "shipped");
		expect(deliverables(engine.get())[0].status).toBe("shipped");
	});

	it("fanout spawns ready chains and advances successors after shipped result", async () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		engine.addWorkItem(a.id, { title: "gate" });
		const b = engine.addDeliverable({ title: "B", dependsOn: [a.id] });
		engine.addWorkItem(b.id, { title: "gate" });
		const spawned: string[] = [];
		const pending: Array<{ id: string; resolve: (value: any) => void }> = [];
		const subagents = {
			spawn: (_prompt: string, profile: any) => {
				const id = `run-${pending.length + 1}`;
				spawned.push(`${id}:${profile.cwd}`);
				let resolve!: (value: any) => void;
				const promise = new Promise((r) => {
					resolve = r;
				});
				pending.push({ id, resolve });
				return { id, result: () => promise };
			},
			get: () => undefined,
			list: () => [],
			steer: () => {},
			stop: () => {},
		};
		const orch = new FanoutOrchestrator({
			engine,
			subagents: subagents as any,
			cwd: "/repo/worktree",
		});
		expect(orch.tick()).toBe(1);
		expect(spawned).toEqual(["run-1:/repo/worktree"]);
		expect(deliverables(engine.get())[0].status).toBe("active");
		pending[0].resolve({ status: "succeeded", summary: "shipped PR #9" });
		await Promise.resolve();
		expect(deliverables(engine.get())[0]).toMatchObject({
			status: "shipped",
			prNumber: 9,
		});
		expect(spawned).toEqual(["run-1:/repo/worktree", "run-2:/repo/worktree"]);
		expect(deliverables(engine.get())[1].status).toBe("active");
	});

	it("fanout routes progress to the owning deliverable", () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		engine.addWorkItem(a.id, { title: "gate" });
		const seen: string[] = [];
		const subagents = {
			spawn: () => ({ id: "run-1", result: () => new Promise(() => {}) }),
			get: () => undefined,
			list: () => [],
			steer: () => {},
			stop: () => {},
		};
		const orch = new FanoutOrchestrator({
			engine,
			subagents: subagents as any,
			onProgress: (deliverable, progress) =>
				seen.push(`${deliverable.id}:${progress.text}`),
		});
		orch.tick();
		orch.progress("run-1" as any, { text: "reading" });
		expect(seen).toEqual(["a:reading"]);
	});
});

describe("worktree and session lifecycle", () => {
	let store: PlanStore;
	let root: string;
	let engine: PlanEngine;
	beforeEach(() => {
		counter = 0;
		root = mkdtempSync(join(tmpdir(), "maestro-worktree-"));
		store = createPlanStore(root);
		engine = PlanEngine.create(
			store,
			{ slug: "p", title: "P", repoPath: "/repo/app" },
			now,
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("activates a deliverable worktree using the stacked base branch", () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		const b = engine.addDeliverable({ title: "B", dependsOn: [a.id] });
		engine.setStatus(a.id, "active");
		const calls: string[][] = [];
		const result = activateDeliverableWorktree(engine, b.id, "main", {
			addWorktree: (repo, target, branch, base) => {
				calls.push([repo, target, branch, base]);
				return { ok: true, path: target, created: true };
			},
			removeWorktree: () => ({ ok: true }),
		});
		expect(result).toMatchObject({
			kind: "ready",
			branch: "feat/b",
			baseBranch: "feat/a",
		});
		expect(calls[0][0]).toBe("/repo/app");
		expect(calls[0][2]).toBe("feat/b");
		expect(calls[0][3]).toBe("feat/a");
		expect(deliverables(engine.get())[1].worktreePath).toContain(
			"/worktrees/app/b",
		);
	});

	it("routes worktree creation to the deliverable's registered repo", () => {
		engine.registerRepo({ key: "service", path: "/repo/svc" });
		const d = engine.addDeliverable({
			title: "Svc work",
			dependsOn: [],
			repo: "service",
		});
		engine.setStatus(d.id, "active");
		const calls: string[][] = [];
		const result = activateDeliverableWorktree(engine, d.id, "main", {
			addWorktree: (repo, target, branch, base) => {
				calls.push([repo, target, branch, base]);
				return { ok: true, path: target, created: true };
			},
			removeWorktree: () => ({ ok: true }),
		});
		expect(result.kind).toBe("ready");
		expect(calls[0][0]).toBe("/repo/svc");
		expect(calls[0][1]).toContain("/worktrees/svc/svc-work");
	});

	it("checks out the sequential branch in the deliverable's registered repo", () => {
		engine.registerRepo({ key: "service", path: "/repo/svc" });
		const d = engine.addDeliverable({
			title: "Svc work",
			dependsOn: [],
			repo: "service",
		});
		engine.setStatus(d.id, "active");
		const calls: string[][] = [];
		activateDeliverableBranch(engine, d.id, "main", {
			checkoutOrCreateBranch: (repo, branch, base) => {
				calls.push([repo, branch, base]);
				return { ok: true };
			},
		});
		expect(calls[0][0]).toBe("/repo/svc");
	});

	it("checks out the deliverable branch in the repo path, no worktree", () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		const b = engine.addDeliverable({ title: "B", dependsOn: [a.id] });
		engine.setStatus(a.id, "active");
		const calls: string[][] = [];
		const result = activateDeliverableBranch(engine, b.id, "main", {
			checkoutOrCreateBranch: (repo, branch, base) => {
				calls.push([repo, branch, base]);
				return { ok: true };
			},
		});
		expect(result).toMatchObject({
			kind: "ready",
			branch: "feat/b",
			baseBranch: "feat/a",
		});
		expect(calls).toEqual([["/repo/app", "feat/b", "feat/a"]]);
		expect(deliverables(engine.get())[1].branch).toBe("feat/b");
		expect(deliverables(engine.get())[1].worktreePath).toBeUndefined();
	});

	it("surfaces a checkout failure as an error result", () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		engine.setStatus(a.id, "active");
		const result = activateDeliverableBranch(engine, a.id, "main", {
			checkoutOrCreateBranch: () => ({ ok: false, error: "boom" }),
		});
		expect(result).toEqual({ kind: "error", error: "boom" });
		expect(deliverables(engine.get())[0].worktreePath).toBeUndefined();
	});

	it("cleans inactive worktrees but keeps dirty failures", () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		const b = engine.addDeliverable({ title: "B", dependsOn: [a.id] });
		engine.updateDeliverable(a.id, { worktreePath: "/wt/a" });
		engine.updateDeliverable(b.id, { worktreePath: "/wt/b" });
		engine.setStatus(b.id, "active");
		const removed: string[] = [];
		const result = cleanupInactiveWorktrees(engine, {
			addWorktree: () => ({ ok: true, path: "", created: false }),
			removeWorktree: (_repo, path) => {
				removed.push(path);
				return path === "/wt/a"
					? { ok: false, error: "dirty", reason: "dirty" }
					: { ok: true };
			},
		});
		expect(removed).toEqual(["/wt/a"]);
		expect(result.kept).toEqual([{ id: "a", path: "/wt/a", reason: "dirty" }]);
		expect(deliverables(engine.get())[1].worktreePath).toBe("/wt/b");
	});

	it("reconciles filesystem worktrees into the plan and clears missing paths", () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		const b = engine.addDeliverable({ title: "B", dependsOn: [a.id] });
		engine.updateDeliverable(b.id, { worktreePath: "/missing" });
		const result = reconcileWorktrees(engine, [
			{ path: "/repo/app", branch: "main" },
			{ path: "/wt/a", branch: "feat/a" },
		]);
		expect(result).toEqual({ attached: ["a"], cleared: ["b"] });
		expect(deliverables(engine.get())[0].worktreePath).toBe("/wt/a");
		expect(deliverables(engine.get())[1].worktreePath).toBeUndefined();
	});

	it("records plan and deliverable sessions and builds seeds", () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		recordPlanSession(engine, "/sessions/plan.jsonl");
		recordDeliverableSession(engine, a.id, "/sessions/a.jsonl");
		expect(engine.get().planSessionPath).toBe("/sessions/plan.jsonl");
		expect(deliverables(engine.get())[0].sessionPath).toBe("/sessions/a.jsonl");
		expect(deliverableWorktreePath(engine.get(), { id: a.id })).toContain(
			"/worktrees/app/a",
		);
		expect(deliverableSessionSeed(engine.get(), a.id)).toContain(
			"Active deliverable: a",
		);
	});
});

describe("shipping policy", () => {
	let store: PlanStore;
	let root: string;
	let engine: PlanEngine;
	beforeEach(() => {
		counter = 0;
		root = mkdtempSync(join(tmpdir(), "maestro-shipping-"));
		store = createPlanStore(root);
		engine = PlanEngine.create(
			store,
			{ slug: "p", title: "P", repoPath: "/repo" },
			now,
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("ships through commit.v1 behind a single gate", async () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		engine.addWorkItem(a.id, { title: "gate" });
		transitionThrough(engine, a.id, "ready-to-ship");
		const calls: unknown[] = [];
		const result = await shipDeliverableFromPlan(engine, a.id, {
			confirm: ({ message }) => message.includes("Ship a"),
			commit: {
				shipDeliverable: async (input) => {
					calls.push(input);
					return {
						branch: "feat/a",
						committed: true,
						pushed: true,
						pr: 12,
					};
				},
			},
		});
		expect(result.kind).toBe("shipped");
		expect(calls).toEqual([
			{ deliverableId: "a", paths: undefined, openPr: true, cwd: "/repo" },
		]);
		expect(deliverables(engine.get())[0]).toMatchObject({
			prNumber: 12,
			status: "ready-to-ship",
		});
	});

	it("ships from the deliverable worktree when set, else the repo path", async () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		engine.addWorkItem(a.id, { title: "gate" });
		transitionThrough(engine, a.id, "ready-to-ship");
		engine.updateDeliverable(a.id, { worktreePath: "/wt/a" });
		let seen: { cwd?: string } | undefined;
		await shipDeliverableFromPlan(engine, a.id, {
			confirm: () => true,
			commit: {
				shipDeliverable: async (input) => {
					seen = input;
					return { branch: "feat/a", committed: true, pushed: true, pr: 1 };
				},
			},
		});
		expect(seen?.cwd).toBe("/wt/a");
	});

	it("ships to the deliverable's registered repo when no worktree is set", async () => {
		engine.registerRepo({ key: "service", path: "/repo/svc" });
		const a = engine.addDeliverable({
			title: "A",
			dependsOn: [],
			repo: "service",
		});
		engine.addWorkItem(a.id, { title: "gate" });
		transitionThrough(engine, a.id, "ready-to-ship");
		let seen: { cwd?: string } | undefined;
		await shipDeliverableFromPlan(engine, a.id, {
			confirm: () => true,
			commit: {
				shipDeliverable: async (input) => {
					seen = input;
					return { branch: "feat/a", committed: true, pushed: true, pr: 1 };
				},
			},
		});
		expect(seen?.cwd).toBe("/repo/svc");
	});

	it("cancels shipping before commit", async () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		let called = false;
		const result = await shipDeliverableFromPlan(engine, a.id, {
			confirm: () => false,
			commit: {
				shipDeliverable: async () => {
					called = true;
					return { branch: "", committed: false, pushed: false };
				},
			},
		});
		expect(result.kind).toBe("canceled");
		expect(called).toBe(false);
	});

	it("syncs merged and closed PR state", async () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		const b = engine.addDeliverable({ title: "B", dependsOn: [a.id] });
		transitionThrough(engine, a.id, "in-review");
		transitionThrough(engine, b.id, "in-review");
		engine.updateDeliverable(a.id, { prNumber: 1 });
		engine.updateDeliverable(b.id, { prNumber: 2 });
		const result = await syncPrState(engine, {
			state: (pr) => (pr === 1 ? "merged" : "closed"),
		});
		expect(result).toEqual({ shipped: ["a"], closed: ["b"] });
		expect(deliverables(engine.get())[0].status).toBe("shipped");
		expect(deliverables(engine.get())[1].status).toBe("needs-attention");
	});

	it("parks the plan as a parent issue plus deliverable issues", async () => {
		engine.addDeliverable({ title: "A", body: "Body", dependsOn: [] });
		engine.addDeliverable({ title: "B" });
		let n = 40;
		const seen: any[] = [];
		const result = await parkPlan(engine, {
			createIssue: async (input) => {
				seen.push(input);
				return ++n;
			},
		});
		expect(result).toEqual({ parent: 41, children: [42, 43] });
		expect(engine.get().parentIssueNumber).toBe(41);
		expect(deliverables(engine.get()).map((d) => d.issueNumber)).toEqual([
			42, 43,
		]);
		expect(seen[0].body).toContain("# P (`p`)");
		expect(seen[1]).toMatchObject({ title: "A", parent: 41 });
	});

	it("looks up each deliverable's PR state in its own repo", async () => {
		engine.registerRepo({ key: "service", path: "/repo/svc" });
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		const b = engine.addDeliverable({
			title: "B",
			dependsOn: [a.id],
			repo: "service",
		});
		transitionThrough(engine, a.id, "in-review");
		transitionThrough(engine, b.id, "in-review");
		engine.updateDeliverable(a.id, { prNumber: 1 });
		engine.updateDeliverable(b.id, { prNumber: 2 });
		const seen: Array<[number, string]> = [];
		await syncPrState(engine, {
			state: (pr, repoPath) => {
				seen.push([pr, repoPath]);
				return "open";
			},
		});
		expect(seen).toContainEqual([1, "/repo"]);
		expect(seen).toContainEqual([2, "/repo/svc"]);
	});

	it("parks each deliverable's issue in its own repo without cross-repo parent", async () => {
		engine.registerRepo({ key: "service", path: "/repo/svc" });
		engine.addDeliverable({ title: "A", dependsOn: [] });
		engine.addDeliverable({ title: "B", dependsOn: [], repo: "service" });
		let n = 40;
		const seen: Array<{ repoPath: string; title?: string; parent?: number }> =
			[];
		await parkPlan(engine, {
			createIssue: (input, repoPath) => {
				seen.push({ repoPath, title: input.title, parent: input.parent });
				return ++n;
			},
		});
		expect(seen[0].repoPath).toBe("/repo");
		const svc = seen.find((s) => s.title === "B");
		expect(svc?.repoPath).toBe("/repo/svc");
		expect(svc?.parent).toBeUndefined();
		const sameRepo = seen.find((s) => s.title === "A");
		expect(sameRepo?.repoPath).toBe("/repo");
		expect(sameRepo?.parent).toBe(41);
	});

	it("selects and sweeps shippable deliverables", async () => {
		const a = engine.addDeliverable({ title: "A", dependsOn: [] });
		const b = engine.addDeliverable({ title: "B", dependsOn: [a.id] });
		transitionThrough(engine, a.id, "ready-to-ship");
		transitionThrough(engine, b.id, "in-review");
		engine.updateDeliverable(a.id, { prNumber: 1 });
		expect(nextShippableDeliverable(engine.get())?.id).toBe("a");
		expect(await sweepMergedPrs(engine, { state: () => "merged" })).toEqual([
			"a",
		]);
		expect(deliverables(engine.get())[0].status).toBe("shipped");
	});
});

describe("compaction and modes UI", () => {
	it("declines compactions without the modes marker", () => {
		expect(decideCompactionOwnership(undefined, undefined)).toEqual({
			kind: "decline",
		});
		expect(decideCompactionOwnership("please summarise", undefined)).toEqual({
			kind: "decline",
		});
	});

	it("owns a compaction whose marker matches the pending nonce", () => {
		const pending = {
			nonce: "n1",
			deliverableId: "a",
			reason: "modes-trigger",
		};
		const decision = decideCompactionOwnership(
			buildCompactionMarker("n1"),
			pending,
		);
		expect(decision).toEqual({ kind: "own", pending });
	});

	it("leak-guards a marker that does not match the pending nonce", () => {
		const pending = {
			nonce: "n1",
			deliverableId: "a",
			reason: "modes-trigger",
		};
		expect(
			decideCompactionOwnership(buildCompactionMarker("n2"), pending),
		).toEqual({ kind: "leak-guard" });
		expect(
			decideCompactionOwnership(buildCompactionMarker("n1"), undefined),
		).toEqual({ kind: "leak-guard" });
	});

	it("redacts crash snapshots", () => {
		const snapshot = createCrashSnapshot(
			{
				error: new Error(
					"failed token=abcdefghijklmnopqrstuvwxyz0123456789 secret=plain",
				),
				mode: "auto",
				plan: plan([]),
				activeDeliverableId: "a",
				cwd: "/repo/api_key=abcdefghijklmnopqrstuvwxyz0123456789",
			},
			() => "2026-01-01T00:00:00.000Z",
		);
		expect(snapshot).toMatchObject({
			at: "2026-01-01T00:00:00.000Z",
			mode: "auto",
			planSlug: "p",
			activeDeliverableId: "a",
		});
		expect(snapshot.error).not.toContain(
			"abcdefghijklmnopqrstuvwxyz0123456789",
		);
		expect(snapshot.cwd).toBe("/repo/[redacted]");
	});

	it("renders compact footer and plan panels", () => {
		const p = plan([
			deliverable({ id: "a", status: "active" }),
			deliverable({ id: "b", status: "in-review" }),
		]);
		expect(
			renderModeFooter({
				mode: "auto",
				planSlug: "p",
				branch: "feat/a",
				contextPercent: 42.4,
			}),
		).toBe("maestro:auto  plan:p  branch:feat/a  ctx:42%");
		expect(renderPlanPanel(p, 4)).toEqual(expect.arrayContaining(["…"]));
		expect(renderPlanSidebar(p)).toEqual(
			expect.arrayContaining(["Deliverables: 2", "active: 1", "in-review: 1"]),
		);
	});
});

describe("repoFor", () => {
	it("falls back to the plan default repo when no repo is set", () => {
		const p = plan([deliverable({ id: "d1" })]);
		expect(repoFor(p, p.nodes[0] as Deliverable)).toEqual({
			key: "default",
			path: "/repo",
		});
	});

	it("treats the explicit default key as the default repo", () => {
		const p = plan([deliverable({ id: "d1", repo: "default" })]);
		expect(repoFor(p, { repo: "default" })).toEqual({
			key: "default",
			path: "/repo",
		});
	});

	it("resolves a registered repo by key", () => {
		const p: Plan = {
			...plan([deliverable({ id: "d1", repo: "service" })]),
			repos: [{ key: "service", path: "/svc", defaultBranch: "dev" }],
		};
		expect(repoFor(p, { repo: "service" })).toEqual({
			key: "service",
			path: "/svc",
			defaultBranch: "dev",
		});
	});

	it("defensively falls back when the key is unregistered", () => {
		const p = plan([deliverable({ id: "d1", repo: "ghost" })]);
		expect(repoFor(p, { repo: "ghost" })).toEqual({
			key: "default",
			path: "/repo",
		});
	});
});

describe("validatePlanShape — repo registry", () => {
	it("accepts a deliverable targeting a registered repo", () => {
		const p: Plan = {
			...plan([deliverable({ id: "d1", repo: "service" })]),
			repos: [{ key: "service", path: "/svc" }],
		};
		expect(validatePlanShape(p)).toEqual([]);
	});

	it("rejects a deliverable targeting an unknown repo", () => {
		const p = plan([deliverable({ id: "d1", repo: "service" })]);
		expect(validatePlanShape(p)).toContainEqual(
			expect.stringContaining("unknown repo `service`"),
		);
	});

	it("rejects duplicate repo keys and empty paths", () => {
		const p: Plan = {
			...plan([deliverable({ id: "d1" })]),
			repos: [
				{ key: "service", path: "/svc" },
				{ key: "service", path: "" },
			],
		};
		const problems = validatePlanShape(p);
		expect(problems).toContainEqual(
			expect.stringContaining("duplicate repo key `service`"),
		);
		expect(problems).toContainEqual(expect.stringContaining("empty path"));
	});
});
