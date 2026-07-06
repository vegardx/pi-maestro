import { describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import type { Plan } from "../packages/modes/src/schema.js";

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

describe("PlanEngine — groups", () => {
	it("creates a plan and adds a group", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		const g = engine.addGroup({
			title: "Implement auth",
			body: "JWT-based auth",
			workerMode: "full",
		});
		expect(g.id).toBe("implement-auth");
		expect(g.status).toBe("planned");
		expect(g.branch).toBe("feat/implement-auth");
		expect(g.worker.mode).toBe("full");
		expect(engine.get().groups).toHaveLength(1);
	});

	it("generates unique ids on collision", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		const g2 = engine.addGroup({ title: "Auth", workerMode: "full" });
		expect(g2.id).toBe("auth-2");
	});

	it("updates a group", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.updateGroup("auth", {
			body: "updated body",
			workerSlot: "alternate",
		});
		const g = engine.get().groups[0];
		expect(g.body).toBe("updated body");
		expect(g.worker.slot).toBe("alternate");
	});

	it("sets group status with transition check", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Implement" });
		engine.setGroupStatus("auth", "active");
		expect(engine.get().groups[0].status).toBe("active");
		expect(() => engine.setGroupStatus("auth", "shipped")).toThrow(/illegal/);
	});

	it("removes a group", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.removeGroup("auth");
		expect(engine.get().groups).toHaveLength(0);
	});

	it("rejects removal of unknown group", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		expect(() => engine.removeGroup("nope")).toThrow(/unknown group/);
	});
});

describe("PlanEngine — agents", () => {
	it("adds an agent to a group", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		const agent = engine.addAgent("auth", {
			name: "security",
			mode: "read-only",
			slot: "alternate",
			effort: "high",
			focus: "Check for timing attacks",
			after: ["worker"],
		});
		expect(agent.name).toBe("security");
		expect(engine.get().groups[0].agents).toHaveLength(1);
	});

	it("updates an agent", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.addAgent("auth", {
			name: "review",
			mode: "read-only",
			slot: "default",
			effort: "low",
			focus: "general review",
			after: ["worker"],
		});
		engine.updateAgent("auth", "review", {
			effort: "high",
			focus: "security focus",
		});
		const agent = engine.get().groups[0].agents[0];
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
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.addAgent("auth", {
			name: "review",
			mode: "read-only",
			slot: "default",
			effort: "low",
			focus: "review",
			after: ["worker"],
		});
		engine.removeAgent("auth", "review");
		expect(engine.get().groups[0].agents).toHaveLength(0);
	});

	it("rejects duplicate agent name", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.addAgent("auth", {
			name: "review",
			mode: "read-only",
			slot: "default",
			effort: "low",
			focus: "review",
			after: ["worker"],
		});
		expect(() =>
			engine.addAgent("auth", {
				name: "review",
				mode: "read-only",
				slot: "default",
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
		engine.addGroup({ title: "Auth", workerMode: "full" });
		expect(() =>
			engine.addAgent("auth", {
				name: "worker",
				mode: "read-only",
				slot: "default",
				effort: "low",
				focus: "x",
				after: [],
			}),
		).toThrow(/reserved/);
	});
});

describe("PlanEngine — work items", () => {
	it("adds a task to a group", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		const item = engine.addWorkItem("auth", {
			title: "Implement login",
			body: "POST /login with bcrypt",
		});
		expect(item.id).toBe("implement-login");
		expect(item.done).toBe(false);
		expect(engine.get().groups[0].tasks).toHaveLength(1);
	});

	it("toggles a task", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Login" });
		const done = engine.toggleWorkItem("auth", "login");
		expect(done).toBe(true);
		expect(engine.get().groups[0].tasks[0].done).toBe(true);
	});

	it("updates a task", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Login" });
		engine.updateWorkItem("auth", "login", { body: "updated details" });
		expect(engine.get().groups[0].tasks[0].body).toBe("updated details");
	});

	it("removes a task", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Login" });
		engine.removeWorkItem("auth", "login");
		expect(engine.get().groups[0].tasks).toHaveLength(0);
	});

	it("answers a question item", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test",
			repoPath: "/tmp/repo",
		});
		engine.addGroup({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Which hash?", kind: "question" });
		engine.updateWorkItem("auth", "which-hash", { answer: "bcrypt" });
		const item = engine.get().groups[0].tasks[0];
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
		engine.addGroup({ title: "Work", workerMode: "full" });
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
		engine.addGroup({ title: "A", workerMode: "full", dependsOn: [] });
		engine.addWorkItem("a", { title: "task a" });
		engine.addGroup({ title: "B", workerMode: "full", dependsOn: ["a"] });
		engine.addWorkItem("b", { title: "task b" });
		expect(() => engine.updateGroup("a", { dependsOn: ["b"] })).toThrow(
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
		engine.addGroup({ title: "Empty", workerMode: "full" });
		// But activating without tasks fails
		expect(() => engine.setGroupStatus("empty", "active")).toThrow(
			/no gating tasks/,
		);
	});
});
