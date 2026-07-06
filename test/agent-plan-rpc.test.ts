import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OrchestratorMessage } from "@vegardx/pi-rpc";
import { createSocketPath, MaestroRpcClient } from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge } from "../packages/modes/src/agent-bridge.js";
import { PlanEngine } from "../packages/modes/src/engine.js";
import { TmuxFanout } from "../packages/modes/src/execution-tmux.js";
import { renderPlanForAgent } from "../packages/modes/src/markdown.js";
import { createPlanStore } from "../packages/modes/src/storage.js";

vi.mock("@vegardx/pi-tmux", () => ({
	spawn: vi.fn().mockResolvedValue(undefined),
	kill: vi.fn().mockResolvedValue(undefined),
	hasSession: vi.fn().mockResolvedValue(true),
}));

vi.mock("@vegardx/pi-git", () => ({
	addWorktree: vi.fn(() => ({
		ok: true,
		path: "/tmp/worktree/fake",
		created: true,
	})),
	removeWorktree: vi.fn(() => ({ ok: true })),
	worktreePathFor: vi.fn(
		(_repoPath: string, ...segments: string[]) =>
			`/tmp/worktrees/${segments.join("/")}`,
	),
}));

function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

let counter = 0;
function now(): string {
	counter++;
	return `2025-01-01T00:00:${String(counter).padStart(2, "0")}Z`;
}

function connectClient(
	socketPath: string,
	agentId: string,
): { client: MaestroRpcClient; connected: Promise<void> } {
	const client = new MaestroRpcClient({ reconnect: false });
	const connected = new Promise<void>((resolve) => {
		client.connect(socketPath, agentId);
		setTimeout(resolve, 30);
	});
	return { client, connected };
}

describe("Agent plan RPC operations", () => {
	let root: string;
	let planDir: string;
	let engine: PlanEngine;
	let fanout: TmuxFanout;
	const clients: MaestroRpcClient[] = [];

	beforeEach(() => {
		counter = 0;
		root = mkdtempSync(join(tmpdir(), "maestro-plan-rpc-"));
		planDir = mkdtempSync(join(tmpdir(), "maestro-plan-rpc-plan-"));
		const store = createPlanStore(root);
		engine = PlanEngine.create(
			store,
			{ slug: "test", title: "Test Plan", repoPath: "/repo" },
			now,
		);
	});

	afterEach(async () => {
		for (const c of clients) c.close();
		clients.length = 0;
		if (fanout) await fanout.destroy();
	});

	function createFanout(opts: { onPlanChanged?: () => void } = {}) {
		const mockCtx = {
			cwd: root,
			model: undefined,
			modelRegistry: {
				find: (provider: string, id: string) => ({
					provider,
					id,
					name: `${provider}/${id}`,
				}),
				getApiKeyAndHeaders: async () => ({
					ok: true,
					apiKey: "test-key",
					headers: {},
				}),
			},
		} as unknown as ExtensionContext;
		fanout = new TmuxFanout({
			engine,
			extensionPath: "/ext",
			planDir,
			defaultBranch: "main",
			ctx: mockCtx,
			onPlanChanged: opts.onPlanChanged,
		});
		return fanout;
	}

	/** Spawn agent via tick(), then connect a client. */
	async function spawnAndConnect(agentId: string) {
		const socketPath = createSocketPath(planDir);
		const { client, connected } = connectClient(socketPath, agentId);
		clients.push(client);
		await connected;
		await wait(20);
		return client;
	}

	describe("planRead", () => {
		it("returns rendered plan for the requesting agent", async () => {
			engine.addDeliverable({ title: "Write API", dependsOn: [] });
			engine.addWorkItem("write-api", {
				title: "Create endpoints",
				kind: "task",
			});
			const f = createFanout();
			await f.start();
			await f.tick();

			const client = await spawnAndConnect("write-api");

			const messages: OrchestratorMessage[] = [];
			client.on("message", (msg) => messages.push(msg));

			client.send({ type: "planRead" });
			await wait(50);

			const response = messages.find((m) => m.type === "planReadResponse");
			expect(response).toBeDefined();
			expect((response as { content: string }).content).toContain("write-api");
			expect((response as { content: string }).content).toContain(
				"Create endpoints",
			);
		});
	});

	describe("planMutate — toggleTask", () => {
		it("toggles a task and fires onPlanChanged", async () => {
			const onPlanChanged = vi.fn();
			engine.addDeliverable({ title: "Write API", dependsOn: [] });
			const item = engine.addWorkItem("write-api", {
				title: "Create endpoints",
				kind: "task",
			});
			// Add a second task so completion gate doesn't fire on toggle
			engine.addWorkItem("write-api", {
				title: "Add tests",
				kind: "task",
			});
			const f = createFanout({ onPlanChanged });
			await f.start();
			await f.tick();
			onPlanChanged.mockClear();

			const client = await spawnAndConnect("write-api");

			const messages: OrchestratorMessage[] = [];
			client.on("message", (msg) => messages.push(msg));

			client.send({
				type: "planMutate",
				action: "toggleTask",
				deliverableId: "write-api",
				params: { taskId: item.id },
			});
			await wait(50);

			const result = messages.find((m) => m.type === "planMutateResult");
			expect(result).toBeDefined();
			expect((result as { success: boolean }).success).toBe(true);
			expect(onPlanChanged).toHaveBeenCalled();
		});
	});

	describe("planMutate — addTask", () => {
		it("adds a gating task to own deliverable", async () => {
			engine.addDeliverable({ title: "Write API", dependsOn: [] });
			const f = createFanout();
			await f.start();
			await f.tick();

			const client = await spawnAndConnect("write-api");

			const messages: OrchestratorMessage[] = [];
			client.on("message", (msg) => messages.push(msg));

			client.send({
				type: "planMutate",
				action: "addTask",
				deliverableId: "write-api",
				params: { title: "Add validation", kind: "task" },
			});
			await wait(50);

			const result = messages.find((m) => m.type === "planMutateResult") as {
				success: boolean;
				taskId?: string;
			};
			expect(result).toBeDefined();
			expect(result.success).toBe(true);
			expect(result.taskId).toBeTruthy();
		});

		it("rejects gating task to another deliverable", async () => {
			engine.addDeliverable({ title: "Write API", dependsOn: [] });
			engine.addDeliverable({ title: "Write Docs" });
			const f = createFanout();
			await f.start();
			await f.tick();

			const client = await spawnAndConnect("write-api");

			const messages: OrchestratorMessage[] = [];
			client.on("message", (msg) => messages.push(msg));

			client.send({
				type: "planMutate",
				action: "addTask",
				deliverableId: "write-docs",
				params: { title: "Hijack other deliverable", kind: "task" },
			});
			await wait(50);

			const result = messages.find((m) => m.type === "planMutateResult") as {
				success: boolean;
				error?: string;
			};
			expect(result).toBeDefined();
			expect(result.success).toBe(false);
			expect(result.error).toContain("own deliverable");
		});

		it("allows followup to another deliverable", async () => {
			engine.addDeliverable({ title: "Write API", dependsOn: [] });
			engine.addDeliverable({ title: "Write Docs" });
			const f = createFanout();
			await f.start();
			await f.tick();

			const client = await spawnAndConnect("write-api");

			const messages: OrchestratorMessage[] = [];
			client.on("message", (msg) => messages.push(msg));

			client.send({
				type: "planMutate",
				action: "addTask",
				deliverableId: "write-docs",
				params: { title: "Consider adding examples", kind: "followup" },
			});
			await wait(50);

			const result = messages.find((m) => m.type === "planMutateResult") as {
				success: boolean;
				taskId?: string;
			};
			expect(result).toBeDefined();
			expect(result.success).toBe(true);
			expect(result.taskId).toBeTruthy();
		});
	});

	describe("planMutate — updateTask", () => {
		it("updates own deliverable task", async () => {
			engine.addDeliverable({ title: "Write API", dependsOn: [] });
			const item = engine.addWorkItem("write-api", {
				title: "Create endpoints",
				kind: "task",
			});
			const f = createFanout();
			await f.start();
			await f.tick();

			const client = await spawnAndConnect("write-api");

			const messages: OrchestratorMessage[] = [];
			client.on("message", (msg) => messages.push(msg));

			client.send({
				type: "planMutate",
				action: "updateTask",
				deliverableId: "write-api",
				params: { taskId: item.id, body: "Updated details" },
			});
			await wait(50);

			const result = messages.find((m) => m.type === "planMutateResult") as {
				success: boolean;
			};
			expect(result).toBeDefined();
			expect(result.success).toBe(true);

			// Verify update persisted
			const plan = engine.get();
			const d = plan.nodes.find(
				(n) => n.type === "deliverable" && n.id === "write-api",
			);
			const updated = (
				d as { children: { id: string; body: string }[] }
			).children.find((c) => c.id === item.id);
			expect(updated?.body).toBe("Updated details");
		});

		it("rejects update of other deliverable task", async () => {
			engine.addDeliverable({ title: "Write API", dependsOn: [] });
			engine.addDeliverable({ title: "Write Docs" });
			const otherItem = engine.addWorkItem("write-docs", {
				title: "Write README",
				kind: "task",
			});
			const f = createFanout();
			await f.start();
			await f.tick();

			const client = await spawnAndConnect("write-api");

			const messages: OrchestratorMessage[] = [];
			client.on("message", (msg) => messages.push(msg));

			client.send({
				type: "planMutate",
				action: "updateTask",
				deliverableId: "write-api",
				params: { taskId: otherItem.id, body: "Hijack" },
			});
			await wait(50);

			const result = messages.find((m) => m.type === "planMutateResult") as {
				success: boolean;
				error?: string;
			};
			expect(result).toBeDefined();
			expect(result.success).toBe(false);
			expect(result.error).toContain("own deliverable");
		});
	});

	describe("renderPlanForAgent", () => {
		it("shows active deliverable tasks and plan overview", () => {
			engine.addDeliverable({ title: "Write API", dependsOn: [] });
			engine.addDeliverable({
				title: "Write Docs",
				dependsOn: ["write-api"],
			});
			engine.addWorkItem("write-api", {
				title: "Create endpoints",
				kind: "task",
			});
			engine.addWorkItem("write-api", {
				title: "Add tests",
				kind: "task",
			});

			const result = renderPlanForAgent(engine.get(), "write-api");

			expect(result).toContain("Your deliverable: write-api");
			expect(result).toContain("Create endpoints");
			expect(result).toContain("Add tests");
			expect(result).toContain("[ ]");
			expect(result).toContain("Plan overview");
			expect(result).toContain("write-docs");
			expect(result).toContain("← you are here");
		});

		it("respects locally toggled tasks", () => {
			engine.addDeliverable({ title: "Write API", dependsOn: [] });
			const item = engine.addWorkItem("write-api", {
				title: "Create endpoints",
				kind: "task",
			});

			const toggled = new Set([item.id]);
			const result = renderPlanForAgent(engine.get(), "write-api", {
				toggledLocally: toggled,
			});

			expect(result).toContain("[x]");
		});

		it("includes dependency summaries when available", () => {
			engine.addDeliverable({ title: "Build lib", dependsOn: [] });
			engine.addDeliverable({
				title: "Write Docs",
				dependsOn: ["build-lib"],
			});
			// Transition through valid statuses
			engine.setStatus("build-lib", "active");
			engine.setStatus("build-lib", "in-review");
			engine.setStatus("build-lib", "ready-to-ship");
			engine.setStatus("build-lib", "shipped");
			engine.updateDeliverable("build-lib", {
				summary: "exports multiply(a,b) and divide(a,b)",
			});

			const result = renderPlanForAgent(engine.get(), "write-docs");

			expect(result).toContain("From completed dependencies");
			expect(result).toContain("multiply");
		});
	});

	describe("plan tool in agent mode", () => {
		it("returns RPC response via agentBridge.planRead", async () => {
			const { createPlanTool } = await import("../packages/modes/src/tools.js");
			const mockBridge = {
				planRead: vi.fn().mockResolvedValue("## Your deliverable: test"),
				planMutate: vi.fn(),
			};
			const tool = createPlanTool({
				engine: () => undefined,
				agentBridge: mockBridge as unknown as AgentBridge,
				seedContent: () => "fallback seed",
			});

			const result = await (tool as any).execute("test-id", {});
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: "## Your deliverable: test",
			});
		});

		it("falls back to seed if RPC returns empty", async () => {
			const { createPlanTool } = await import("../packages/modes/src/tools.js");
			const mockBridge = {
				planRead: vi.fn().mockResolvedValue(""),
				planMutate: vi.fn(),
			};
			const tool = createPlanTool({
				engine: () => undefined,
				agentBridge: mockBridge as unknown as AgentBridge,
				seedContent: () => "fallback seed content",
			});

			const result = await (tool as any).execute("test-id", {});
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: "fallback seed content",
			});
		});
	});

	describe("task tool in agent mode", () => {
		it("routes add through RPC", async () => {
			const { createTaskTool } = await import("../packages/modes/src/tools.js");
			const mockBridge = {
				planRead: vi.fn(),
				planMutate: vi.fn().mockResolvedValue({
					type: "planMutateResult",
					success: true,
					taskId: "new-task-id",
				}),
			};
			const tool = createTaskTool({
				engine: () => undefined,
				agentBridge: mockBridge as unknown as AgentBridge,
				agentDeliverableId: () => "my-deliverable",
			});

			const result = await (tool as any).execute("test-id", {
				action: "add",
				title: "New task",
				body: "Task body",
			});
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: "✓ new-task-id",
			});
			expect(mockBridge.planMutate).toHaveBeenCalledWith(
				"addTask",
				"my-deliverable",
				{ title: "New task", body: "Task body", kind: undefined },
			);
		});

		it("blocks remove in agent mode", async () => {
			const { createTaskTool } = await import("../packages/modes/src/tools.js");
			const mockBridge = {
				planRead: vi.fn(),
				planMutate: vi.fn(),
			};
			const tool = createTaskTool({
				engine: () => undefined,
				agentBridge: mockBridge as unknown as AgentBridge,
				agentDeliverableId: () => "my-deliverable",
			});

			const result = await (tool as any).execute("test-id", {
				action: "remove",
				id: "some-task",
			});
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: "agents cannot remove tasks",
			});
		});

		it("blocks move in agent mode", async () => {
			const { createTaskTool } = await import("../packages/modes/src/tools.js");
			const mockBridge = {
				planRead: vi.fn(),
				planMutate: vi.fn(),
			};
			const tool = createTaskTool({
				engine: () => undefined,
				agentBridge: mockBridge as unknown as AgentBridge,
				agentDeliverableId: () => "my-deliverable",
			});

			const result = await (tool as any).execute("test-id", {
				action: "move",
				id: "some-task",
				targetDeliverableId: "other",
			});
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: "agents cannot move tasks",
			});
		});
	});

	describe("deliverable tool in agent mode", () => {
		it("blocks structural changes", async () => {
			const { createDeliverableTool } = await import(
				"../packages/modes/src/tools.js"
			);
			const mockBridge = {
				planRead: vi.fn().mockResolvedValue("plan content"),
				planMutate: vi.fn(),
			};
			const tool = createDeliverableTool({
				engine: () => undefined,
				agentBridge: mockBridge as unknown as AgentBridge,
			});

			const result = await (tool as any).execute("test-id", {
				action: "add",
				title: "New deliverable",
			});
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("cannot modify plan structure"),
			});
		});

		it("allows list action (redirects to planRead)", async () => {
			const { createDeliverableTool } = await import(
				"../packages/modes/src/tools.js"
			);
			const mockBridge = {
				planRead: vi.fn().mockResolvedValue("plan overview content"),
				planMutate: vi.fn(),
			};
			const tool = createDeliverableTool({
				engine: () => undefined,
				agentBridge: mockBridge as unknown as AgentBridge,
			});

			const result = await (tool as any).execute("test-id", { action: "list" });
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: "plan overview content",
			});
		});
	});
});
