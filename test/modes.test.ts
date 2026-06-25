import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES, EVENTS, type ModeName } from "@vegardx/pi-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModesAskQueue } from "../packages/modes/src/ask-queue.js";
import { PLAN_CONTAINER, PlanEngine } from "../packages/modes/src/engine.js";
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
	findNode,
	gatingTasks,
	isDeliverableReady,
	isGrouping,
	type Plan,
	type PlanNode,
	pickBaseBranch,
	planImplementBranch,
	readyDeliverables,
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
	initialModesState,
	nextMode,
	setActivePlan,
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
		expect(seed).toContain("summary: done");
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
		expect(md.content[0].text).toContain("### A `a` [planned]");
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

describe("mode state and policy", () => {
	it("cycles modes and persists active plan", () => {
		const state = initialModesState(now);
		expect(state.mode).toBe("hack");
		expect(nextMode("hack")).toBe("plan");
		expect(nextMode("auto")).toBe("hack");
		const changed = transitionMode(state, "plan", now);
		expect(changed.previous).toBe("hack");
		const withPlan = setActivePlan(changed.state, "p", now);
		expect(toPersistedState(withPlan)).toMatchObject({
			version: 1,
			mode: "plan",
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
					mode: "ask",
					activePlanSlug: "new",
					updatedAt: "2",
				},
			},
		] as any[];
		expect(hydrateModesState(entries)).toEqual({
			mode: "ask",
			activePlanSlug: "new",
			updatedAt: "2",
		});
	});

	it("narrows active tools in plan mode", () => {
		const tools = [
			"read",
			"bash",
			"edit",
			"deliverable",
			"task",
			"plan",
			"ask",
		];
		expect(
			computeActiveTools({
				mode: "plan",
				availableTools: tools,
				baselineTools: tools,
			}),
		).toEqual(["read", "deliverable", "task", "plan", "ask"]);
		expect(
			computeActiveTools({
				mode: "auto",
				availableTools: tools,
				baselineTools: ["edit"],
			}),
		).toEqual(["edit"]);
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
				select: async () => "Implement (auto)",
			},
			sessionManager: { getEntries: () => entries },
		};
		const emitted: Array<{ name: string; payload: unknown }> = [];
		const caps = new Map<string, unknown>();
		const maestro = {
			name: "modes",
			events: {
				emit: (name: string, payload: unknown) =>
					emitted.push({ name, payload }),
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
		]);
		expect([...host.commands.keys()]).toEqual(
			expect.arrayContaining([
				"plan",
				"implement",
				"hack",
				"ask",
				"auto",
				"modes-status",
			]),
		);
		expect(host.shortcuts.has("shift+tab")).toBe(true);
		expect(host.caps.has(CAPABILITIES.modes)).toBe(true);
	});

	it("opens a plan through /plan and hydrates session state", async () => {
		const host = fakeHost();
		const runtime = createModesRuntime(host.pi as any, host.maestro as any, {
			store,
			now,
		});
		await host.commands.get("plan").handler("My Plan", host.ctx);
		expect(runtime.currentMode()).toBe("plan");
		expect(runtime.currentEngine()?.get().slug).toBe("my-plan");
		expect(store.exists("my-plan")).toBe(true);
		expect(host.messages[0].message.content).toContain("# My Plan");
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
			"deliverable",
			"task",
			"plan",
			"ask",
		]);
		const blocked = host.handlers.get("tool_call")?.[0]({
			toolName: "bash",
			input: { command: "git push" },
		});
		expect(blocked).toMatchObject({ block: true });
		const allowed = host.handlers.get("tool_call")?.[0]({
			toolName: "bash",
			input: { command: "git status" },
		});
		expect(allowed).toBeUndefined();
	});

	it("cycles plan mode through the picker and flushes queued ask", async () => {
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
});
