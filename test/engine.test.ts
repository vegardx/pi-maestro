import { describe, expect, it } from "vitest";
import {
	PlanEngine,
	planFingerprint,
} from "../packages/modes/src/engine.js";
import {
	validatePlanShape,
	workerRestartState,
	workerSessionGeneration,
	type Plan,
} from "../packages/modes/src/schema.js";

import type { PlanStore } from "../packages/modes/src/storage.js";

// Minimal PlanStore stub
function memStore(): PlanStore & { last: Plan | null } {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save(plan: Plan) {
			saved = plan;
		},
		load(_slug: string): Plan | null {
			return saved;
		},
		exists(_slug: string): boolean {
			return saved !== null;
		},
		remove(_slug: string) {
			saved = null;
		},
		list() {
			return [];
		},
		get last() {
			return saved;
		},
	};
}

describe("PlanEngine — safe recovery metadata and repair", () => {
	function repairEngine() {
		const store = memStore();
		const engine = PlanEngine.create(
			store,
			{ slug: "repair", title: "Repair", repoPath: "/tmp/repo" },
			() => "2026-01-01T00:00:00.000Z",
		);
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Implement auth" });
		return { engine, store };
	}

	it("hydrates absent restart metadata with generation zero and idle state", () => {
		const { engine } = repairEngine();
		const deliverable = engine.get().deliverables[0];
		expect(workerSessionGeneration(deliverable)).toBe(0);
		expect(workerRestartState(deliverable)).toBe("idle");
		expect(validatePlanShape(engine.get())).toEqual([]);
	});

	it("validates and bounds persisted worker session history", () => {
		const { engine } = repairEngine();
		engine.updateWorkerSession("auth", {
			sessionGeneration: 2,
			sessionPath: "/sessions/current.jsonl",
			previousSessionPaths: [
				"/sessions/0.jsonl",
				"/sessions/1.jsonl",
				"/sessions/2.jsonl",
				"/sessions/3.jsonl",
				"/sessions/4.jsonl",
				"/sessions/5.jsonl",
			],
			restartMode: "fresh",
			restartState: "running",
		});
		const deliverable = engine.get().deliverables[0];
		expect(deliverable.previousSessionPaths).toEqual([
			"/sessions/1.jsonl",
			"/sessions/2.jsonl",
			"/sessions/3.jsonl",
			"/sessions/4.jsonl",
			"/sessions/5.jsonl",
		]);
		expect(workerSessionGeneration(deliverable)).toBe(2);
	});

	it("applies a fingerprinted repair in one save and emits an audit event", () => {
		const { engine, store } = repairEngine();
		const base = planFingerprint(engine.get());
		const savesBefore = store.last;
		const result = engine.applyTaskRepair({
			baseFingerprint: base,
			reason: "review found missing verification",
			stoppedDeliverableIds: ["auth"],
			operations: [
				{
					type: "clarifyTask",
					deliverableId: "auth",
					taskId: "implement-auth",
					body: "Include expiry validation",
				},
				{
					type: "addManualCheckpoint",
					deliverableId: "auth",
					task: { id: "confirm-keys", title: "Confirm production keys" },
				},
			],
		});
		expect(store.last).not.toBe(savesBefore);
		expect(engine.get().deliverables[0].tasks).toHaveLength(2);
		expect(engine.get().deliverables[0].tasks[1].kind).toBe("manual");
		expect(engine.get().repairAudit?.[0]).toMatchObject({
			id: result.auditId,
			baseFingerprint: base,
			operations: ["clarifyTask", "addManualCheckpoint"],
		});
	});

	it("rejects fingerprint drift and rolls the entire repair back", () => {
		const { engine, store } = repairEngine();
		const base = planFingerprint(engine.get());
		engine.updateWorkItem("auth", "implement-auth", { body: "changed" });
		const before = structuredClone(engine.get());
		expect(() =>
			engine.applyTaskRepair({
				baseFingerprint: base,
				reason: "stale proposal",
				stoppedDeliverableIds: ["auth"],
				operations: [
					{
						type: "addCorrectiveTask",
						deliverableId: "auth",
						task: { id: "fix", title: "Fix" },
					},
				],
			}),
		).toThrow(/fingerprint drift/);
		expect(engine.get()).toEqual(before);
		expect(store.last).toEqual(before);
	});

	it("rolls back earlier operations when a later operation is disallowed", () => {
		const { engine } = repairEngine();
		const before = structuredClone(engine.get());
		expect(() =>
			engine.applyTaskRepair({
				baseFingerprint: planFingerprint(engine.get()),
				reason: "bad batch",
				stoppedDeliverableIds: ["auth"],
				operations: [
					{
						type: "addCorrectiveTask",
						deliverableId: "auth",
						task: { id: "new", title: "New" },
					},
					{
						type: "clarifyTask",
						deliverableId: "auth",
						taskId: "missing",
						body: "nope",
					},
				],
			}),
		).toThrow(/unknown task/);
		expect(engine.get()).toEqual(before);
	});

	it("reopens completed tasks idempotently but never rewrites decisions", () => {
		const { engine } = repairEngine();
		engine.toggleWorkItem("auth", "implement-auth");
		for (let attempt = 0; attempt < 2; attempt++) {
			engine.applyTaskRepair({
				baseFingerprint: planFingerprint(engine.get()),
				reason: "completion was incorrect",
				stoppedDeliverableIds: ["auth"],
				operations: [
					{
						type: "reopenTask",
						deliverableId: "auth",
						taskId: "implement-auth",
					},
				],
			});
		}
		expect(engine.get().deliverables[0].tasks[0].done).toBe(false);
	});

	it("requires execution-aware stopped confirmation", () => {
		const { engine } = repairEngine();
		expect(() =>
			engine.applyTaskRepair({
				baseFingerprint: planFingerprint(engine.get()),
				reason: "unsafe",
				stoppedDeliverableIds: [],
				operations: [
					{
						type: "addCorrectiveTask",
						deliverableId: "auth",
						task: { id: "fix", title: "Fix" },
					},
				],
			}),
		).toThrow(/not confirmed stopped/);
	});
});

describe("PlanEngine — deliverables", () => {
	it("creates a plan and adds a deliverable", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		const g = engine.addDeliverable({
			title: "Implement auth",
			body: "JWT-based auth",
			workerMode: "full",
		});
		expect(g.id).toBe("implement-auth");
		expect(g.status).toBe("planned");
		expect(g.branch).toBe("feat/implement-auth");
		expect(g.worker.mode).toBe("full");
		expect(engine.get().deliverables).toHaveLength(1);
	});

	it("addWaiver records human gate overrides permanently", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWaiver("auth", {
			reviewer: "security-audit",
			reason: "token already scoped",
		});
		engine.addWaiver("auth", {
			reviewer: "correctness",
			reason: "flagged path is dead code",
		});
		const waivers = store.last?.deliverables[0].waivers ?? [];
		expect(waivers).toHaveLength(2);
		expect(waivers[0].reviewer).toBe("security-audit");
		expect(waivers[0].reason).toBe("token already scoped");
		expect(waivers[0].at).toBeTruthy();
	});

	it("generates unique ids on collision", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		const g2 = engine.addDeliverable({ title: "Auth", workerMode: "full" });
		expect(g2.id).toBe("auth-2");
	});

	it("honors a caller-provided id on add (slugified), else derives from title", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		// Provided id wins over the title-derived one.
		const g = engine.addDeliverable({
			id: "AWS Static Site",
			title: "AWS static website deployment",
			workerMode: "full",
		});
		expect(g.id).toBe("aws-static-site");
		// Collisions on the provided id still de-dupe.
		const g2 = engine.addDeliverable({
			id: "aws-static-site",
			title: "Another",
			workerMode: "full",
		});
		expect(g2.id).toBe("aws-static-site-2");
	});

	it("updates a deliverable", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.updateDeliverable("auth", {
			body: "updated body",
		});
		const g = engine.get().deliverables[0];
		expect(g.body).toBe("updated body");
	});

	it("sets deliverable status with transition check", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Implement" });
		engine.setDeliverableStatus("auth", "active");
		expect(engine.get().deliverables[0].status).toBe("active");
		expect(() => engine.setDeliverableStatus("auth", "shipped")).toThrow(
			/illegal/,
		);
	});

	it("removes a deliverable", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.removeDeliverable("auth");
		expect(engine.get().deliverables).toHaveLength(0);
	});

	it("rejects removal of unknown deliverable", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		expect(() => engine.removeDeliverable("nope")).toThrow(
			/unknown deliverable/,
		);
	});
});

describe("PlanEngine — agents", () => {
	it("adds an agent to a deliverable", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		const agent = engine.addAgent("auth", {
			name: "security",
			mode: "read-only",
			effort: "high",
			focus: "Check for timing attacks",
			after: ["worker"],
		});
		expect(agent.name).toBe("security");
		expect(engine.get().deliverables[0].agents).toHaveLength(1);
	});

	it("updates an agent", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addAgent("auth", {
			name: "review",
			mode: "read-only",
			effort: "low",
			focus: "general review",
			after: ["worker"],
		});
		engine.updateAgent("auth", "review", {
			effort: "high",
			focus: "security focus",
		});
		const agent = engine.get().deliverables[0].agents[0];
		expect(agent.effort).toBe("high");
		expect(agent.focus).toBe("security focus");
	});

	it("removes an agent", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addAgent("auth", {
			name: "review",
			mode: "read-only",
			effort: "low",
			focus: "review",
			after: ["worker"],
		});
		engine.removeAgent("auth", "review");
		expect(engine.get().deliverables[0].agents).toHaveLength(0);
	});

	it("rejects duplicate agent name", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addAgent("auth", {
			name: "review",
			mode: "read-only",
			effort: "low",
			focus: "review",
			after: ["worker"],
		});
		expect(() =>
			engine.addAgent("auth", {
				name: "review",
				mode: "read-only",
				effort: "low",
				focus: "dup",
				after: [],
			}),
		).toThrow(/duplicate agent name/);
	});

	it("rejects agent named 'worker'", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		expect(() =>
			engine.addAgent("auth", {
				name: "worker",
				mode: "read-only",
				effort: "low",
				focus: "x",
				after: [],
			}),
		).toThrow(/reserved/);
	});
});

describe("PlanEngine — work items", () => {
	it("adds a task to a deliverable", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		const item = engine.addWorkItem("auth", {
			title: "Implement login",
			body: "POST /login with bcrypt",
		});
		expect(item.id).toBe("implement-login");
		expect(item.done).toBe(false);
		expect(engine.get().deliverables[0].tasks).toHaveLength(1);
	});

	it("toggles a task", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Login" });
		const done = engine.toggleWorkItem("auth", "login");
		expect(done).toBe(true);
		expect(engine.get().deliverables[0].tasks[0].done).toBe(true);
	});

	it("updates a task", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Login" });
		engine.updateWorkItem("auth", "login", { body: "updated details" });
		expect(engine.get().deliverables[0].tasks[0].body).toBe("updated details");
	});

	it("removes a task", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Login" });
		engine.removeWorkItem("auth", "login");
		expect(engine.get().deliverables[0].tasks).toHaveLength(0);
	});

	it("answers a question item", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Which hash?", kind: "question" });
		engine.updateWorkItem("auth", "which-hash", { answer: "bcrypt" });
		const item = engine.get().deliverables[0].tasks[0];
		expect(item.answer).toBe("bcrypt");
		expect(item.done).toBe(true);
		expect(item.decidedAt).toBeDefined();
	});
});

describe("PlanEngine — draft lifecycle", () => {
	it("draft does not persist until materialized", () => {
		const store = memStore();
		const engine = PlanEngine.createDraft(store, {
			slug: "draft",
			title: "Draft",
			repoPath: "/tmp/repo",
		});
		expect(engine.isDraft()).toBe(true);
		expect(store.last).toBeNull();
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		expect(store.last).toBeNull(); // Still not persisted
		engine.materialize("final-slug", "Final Title");
		expect(engine.isDraft()).toBe(false);
		expect(store.last).not.toBeNull();
		expect(store.last!.slug).toBe("final-slug");
	});
});

describe("PlanEngine — validation integration", () => {
	it("rejects cyclic dependsOn", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "A", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("a", { title: "task a" });
		engine.addDeliverable({ title: "B", workerMode: "full", dependsOn: ["a"] });
		engine.addWorkItem("b", { title: "task b" });
		expect(() => engine.updateDeliverable("a", { dependsOn: ["b"] })).toThrow(
			/cycle/,
		);
	});

	it("rejects full-mode worker with no tasks when activating", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		// Adding with no tasks is fine (planned status)
		engine.addDeliverable({ title: "Empty", workerMode: "full" });
		// But activating without tasks fails
		expect(() => engine.setDeliverableStatus("empty", "active")).toThrow(
			/no gating tasks/,
		);
	});
});

describe("PlanEngine — workspaces and the repo registry", () => {
	function setup() {
		const store = memStore();
		return PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
	}

	it("scratch deliverables get no branch and drop stacked/repo", () => {
		const engine = setup();
		const g = engine.addDeliverable({
			title: "Bootstrap repos",
			workerMode: "full",
			workspace: "scratch",
			stacked: false, // meaningless for scratch — dropped, not rejected
			repo: "svc", // likewise
		});
		expect(g.workspace).toBe("scratch");
		expect(g.branch).toBeUndefined();
		expect(g.stacked).toBeUndefined();
		expect(g.repo).toBeUndefined();
	});

	it("repo-backed deliverables keep the branch default", () => {
		const engine = setup();
		const g = engine.addDeliverable({ title: "Auth", workerMode: "full" });
		expect(g.branch).toBe("feat/auth");
	});

	it("registers a late-bound repo and validates its createdBy reference", () => {
		const engine = setup();
		engine.addDeliverable({
			title: "Bootstrap",
			workerMode: "full",
			workspace: "scratch",
		});
		engine.registerRepo({
			key: "svc",
			path: "/tmp/svc",
			createdBy: "bootstrap",
		});
		expect(engine.get().repos).toEqual([
			{ key: "svc", path: "/tmp/svc", createdBy: "bootstrap" },
		]);

		expect(() =>
			engine.registerRepo({ key: "x", path: "/tmp/x", createdBy: "ghost" }),
		).toThrow(/unknown deliverable/);
	});

	it("rejects a deliverable targeting a late-bound repo without depending on its creator", () => {
		const engine = setup();
		engine.addDeliverable({
			title: "Bootstrap",
			workerMode: "full",
			workspace: "scratch",
		});
		engine.registerRepo({
			key: "svc",
			path: "/tmp/svc",
			createdBy: "bootstrap",
		});
		expect(() =>
			engine.addDeliverable({ title: "Impl", workerMode: "full", repo: "svc" }),
		).toThrow(/does not depend on it/);
		// With the dependency it goes through.
		const g = engine.addDeliverable({
			title: "Impl",
			workerMode: "full",
			repo: "svc",
			dependsOn: ["bootstrap"],
		});
		expect(g.repo).toBe("svc");
	});
});

describe("PlanEngine — update patches never wipe unset fields", () => {
	// Live incident: `deliverable(action="update", id=…, status=…)` nulled the
	// deliverable's title, dependsOn, and stacked — tool handlers forward all
	// optional params as explicit undefined, and Object.assign copied them.
	it("updateDeliverable with sparse patch keeps title/dependsOn/stacked", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Base", workerMode: "full" });
		engine.addDeliverable({
			title: "Provision",
			workerMode: "full",
			dependsOn: ["base"],
			stacked: false,
		});
		// The exact shape the deliverable tool sends when only updating status.
		engine.updateDeliverable("provision", {
			title: undefined,
			body: undefined,
			dependsOn: undefined,
			stacked: undefined,
			workspace: undefined,
			repo: undefined,
			workerMode: undefined,
			workerEffort: undefined,
		});
		const g = engine.get().deliverables[1];
		expect(g.title).toBe("Provision");
		expect(g.dependsOn).toEqual(["base"]);
		expect(g.stacked).toBe(false);
	});

	it("updateWorkItem and updateAgent keep unset fields too", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "Task A", body: "details" });
		engine.updateWorkItem("work", "task-a", {
			title: undefined,
			body: undefined,
			kind: undefined,
		});
		expect(engine.get().deliverables[0].tasks[0].title).toBe("Task A");
		expect(engine.get().deliverables[0].tasks[0].body).toBe("details");

		engine.addAgent("work", {
			name: "sec",
			mode: "read-only",
			effort: "high",
			focus: "audit",
			after: [],
		});
		engine.updateAgent("work", "sec", { focus: undefined, effort: undefined });
		const agent = engine.get().deliverables[0].agents[0];
		expect(agent.focus).toBe("audit");
		expect(agent.effort).toBe("high");
	});
});
