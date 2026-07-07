import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	buildSessionFile,
	renderPlanForAgent,
} from "../packages/modes/src/execution-adapter.js";
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

describe("buildSessionFile", () => {
	const tmpDir = join("/tmp", "test-session-file");

	it("creates a valid JSONL session file", () => {
		rmSync(tmpDir, { recursive: true, force: true });
		const { mkdirSync } = require("node:fs");
		mkdirSync(tmpDir, { recursive: true });

		const path = buildSessionFile({
			agentKey: "my-group/worker",
			seed: "# Implement auth\n\nDo the thing.",
			cwd: "/tmp/worktree",
			outDir: tmpDir,
		});

		expect(existsSync(path)).toBe(true);
		expect(path).toMatch(/agent-my-group_worker\.jsonl$/);

		const content = readFileSync(path, "utf-8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(3);

		// Session header
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
		expect(header.cwd).toBe("/tmp/worktree");

		// Modes state
		const modesState = JSON.parse(lines[1]);
		expect(modesState.type).toBe("custom");
		expect(modesState.customType).toBe("maestro.modes.state");
		expect(modesState.data.version).toBe(2);
		expect(modesState.data.mode).toBe("agent");
		expect(modesState.data.execution.stage).toBe("executing");
		expect(modesState.data.execution.deliverableId).toBe("my-group/worker");

		// Seed entry
		const seedEntry = JSON.parse(lines[2]);
		expect(seedEntry.type).toBe("custom");
		expect(seedEntry.customType).toBe("maestro-execution-seed");
		expect(seedEntry.data.content).toBe("# Implement auth\n\nDo the thing.");
		expect(seedEntry.data.deliverableId).toBe("my-group/worker");
		expect(seedEntry.parentId).toBe(modesState.id);

		rmSync(tmpDir, { recursive: true, force: true });
	});
});

describe("renderPlanForAgent", () => {
	it("renders scoped plan view for a group", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test Plan",
		});
		engine.addGroup({
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
		});
		engine.addGroup({
			title: "Setup DB",
			body: "Create database schema.",
			workerMode: "full",
		});
		engine.addGroup({
			title: "Implement auth",
			body: "Auth depends on DB.",
			workerMode: "full",
			dependsOn: ["setup-db"],
		});
		// Simulate summary on the dependency
		engine.updateGroup("setup-db", {
			summary: "Database tables created: users, sessions.",
		});

		const content = renderPlanForAgent(engine, "implement-auth");
		expect(content).toContain("## Dependency: Setup DB");
		expect(content).toContain("Database tables created: users, sessions.");
	});

	it("returns fallback for unknown group", () => {
		const store = memStore();
		const engine = PlanEngine.create(store, {
			slug: "test",
			title: "Test Plan",
		});
		const content = renderPlanForAgent(engine, "nonexistent");
		expect(content).toBe("(group not found)");
	});
});
