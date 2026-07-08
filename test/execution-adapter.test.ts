import { describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import { renderPlanForAgent } from "../packages/modes/src/exec/execution-adapter.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

function memStore(): PlanStore {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save(plan: Plan) {
			saved = plan;
		},
		load(): Plan | null {
			return saved;
		},
		exists(): boolean {
			return saved !== null;
		},
		remove() {
			saved = null;
		},
		list() {
			return [];
		},
	};
}

describe("renderPlanForAgent", () => {
	it("renders scoped plan view for a deliverable", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test Plan",
			repoPath: "/tmp/test-repo",
		});
		engine.addDeliverable({
			title: "Implement auth",
			body: "Build the auth system with JWT tokens.",
			workerMode: "full",
		});
		engine.addWorkItem("implement-auth", {
			title: "Create login endpoint",
			body: "POST /login in src/auth.ts",
			kind: "task",
		});
		engine.addWorkItem("implement-auth", {
			title: "Add refresh token",
			body: "In src/auth/refresh.ts",
			kind: "task",
		});
		engine.addWorkItem("implement-auth", {
			title: "Consider rate limiting",
			body: "",
			kind: "followup",
		});

		// Toggle the first task
		engine.toggleWorkItem("implement-auth", "create-login-endpoint");

		const content = renderPlanForAgent(engine, "implement-auth");

		expect(content).toContain("# Implement auth");
		expect(content).toContain("Build the auth system with JWT tokens.");
		expect(content).toContain("## Tasks");
		expect(content).toContain("- [x] **Create login endpoint**");
		expect(content).toContain("- [ ] **Add refresh token**");
		expect(content).toContain("_(followup)_");
		expect(content).toContain("POST /login in src/auth.ts");
	});

	it("includes dependency summaries", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test Plan",
			repoPath: "/tmp/test-repo",
		});
		engine.addDeliverable({
			title: "Setup DB",
			body: "Create database schema.",
			workerMode: "full",
		});
		engine.addDeliverable({
			title: "Implement auth",
			body: "Auth depends on DB.",
			workerMode: "full",
			dependsOn: ["setup-db"],
		});
		// Simulate summary on the dependency
		engine.updateDeliverable("setup-db", {
			summary: "Database tables created: users, sessions.",
		});

		const content = renderPlanForAgent(engine, "implement-auth");
		expect(content).toContain("## Dependency: Setup DB");
		expect(content).toContain("Database tables created: users, sessions.");
	});

	it("returns fallback for unknown deliverable", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test Plan",
			repoPath: "/tmp/test-repo",
		});
		const content = renderPlanForAgent(engine, "nonexistent");
		expect(content).toBe("(deliverable not found)");
	});
});
