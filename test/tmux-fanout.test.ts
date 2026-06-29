import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaestroRpcClient } from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import { TmuxFanout } from "../packages/modes/src/execution-tmux.js";
import { createPlanStore } from "../packages/modes/src/storage.js";

// Mock tmux + git worktree modules
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

import * as git from "@vegardx/pi-git";
import * as tmux from "@vegardx/pi-tmux";

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
		// The client is connected once the socket "connect" event fires
		// and hello is sent. We observe this externally via a small delay.
		client.connect(socketPath, agentId);
		setTimeout(resolve, 30);
	});
	return { client, connected };
}

describe("TmuxFanout", () => {
	let root: string;
	let planDir: string;
	let engine: PlanEngine;
	let fanout: TmuxFanout;
	const clients: MaestroRpcClient[] = [];

	beforeEach(() => {
		counter = 0;
		root = mkdtempSync(join(tmpdir(), "maestro-fanout-"));
		planDir = mkdtempSync(join(tmpdir(), "maestro-fanout-plan-"));
		const store = createPlanStore(root);
		engine = PlanEngine.create(
			store,
			{ slug: "test", title: "Test Plan", repoPath: "/repo" },
			now,
		);
		vi.mocked(tmux.spawn).mockClear();
		vi.mocked(tmux.kill).mockClear();
		vi.mocked(tmux.hasSession).mockClear();
		vi.mocked(git.addWorktree).mockClear();
		vi.mocked(git.removeWorktree).mockClear();
		vi.mocked(git.worktreePathFor).mockClear();
	});

	afterEach(async () => {
		for (const c of clients) c.close();
		clients.length = 0;
		if (fanout) await fanout.destroy();
		rmSync(root, { recursive: true, force: true });
		rmSync(planDir, { recursive: true, force: true });
	});

	function createFanout(
		overrides?: Partial<ConstructorParameters<typeof TmuxFanout>[0]>,
	): TmuxFanout {
		fanout = new TmuxFanout({
			engine,
			extensionPath: "/ext/path",
			planDir,
			defaultBranch: "main",
			...overrides,
		});
		return fanout;
	}

	function makeClient(agentId: string): {
		client: MaestroRpcClient;
		connected: Promise<void>;
	} {
		const socketPath = join(planDir, "orchestrator.sock");
		const { client, connected } = connectClient(socketPath, agentId);
		clients.push(client);
		return { client, connected };
	}

	describe("tick()", () => {
		it("spawns ready deliverables with tmux and correct env vars", async () => {
			engine.addDeliverable({ title: "First", dependsOn: [] });
			const f = createFanout();
			await f.start();
			const spawned = await f.tick();
			expect(spawned).toBe(1);
			expect(tmux.spawn).toHaveBeenCalledTimes(1);
			const call = vi.mocked(tmux.spawn).mock.calls[0];
			// First arg is agent name
			expect(call[0]).toMatch(/^[a-z]+-[a-z]+$/);
			// Third arg is command with env vars
			expect(call[2]).toContain("PI_MAESTRO_SOCK=");
			expect(call[2]).toContain("PI_MAESTRO_AGENT_ID=");
		});

		it("does not spawn already-tracked deliverables", async () => {
			engine.addDeliverable({ title: "First", dependsOn: [] });
			const f = createFanout();
			await f.start();
			await f.tick();
			await f.tick();
			expect(tmux.spawn).toHaveBeenCalledTimes(1);
		});

		it("respects dependency ordering — blocks on unshipped parent", async () => {
			engine.addDeliverable({ title: "First", dependsOn: [] });
			engine.addDeliverable({ title: "Second" }); // auto-depends on "first"
			const f = createFanout();
			await f.start();
			const spawned = await f.tick();
			// Only first is ready
			expect(spawned).toBe(1);
			expect(tmux.spawn).toHaveBeenCalledTimes(1);
		});

		it("marks deliverable active on spawn", async () => {
			const d = engine.addDeliverable({ title: "First", dependsOn: [] });
			const f = createFanout();
			await f.start();
			await f.tick();
			const plan = engine.get();
			const updated = plan.nodes.find(
				(n) => n.type === "deliverable" && n.id === d.id,
			);
			expect(updated && "status" in updated ? updated.status : null).toBe(
				"active",
			);
		});
	});

	describe("RPC lifecycle", () => {
		it("transitions to 'working' when agent connects", async () => {
			const d = engine.addDeliverable({ title: "Work", dependsOn: [] });
			const stateChanges: string[] = [];
			const f = createFanout({
				onAgentStateChanged: (id, state) => {
					stateChanges.push(`${id}:${state.status}`);
				},
			});
			await f.start();
			await f.tick();

			const { connected } = makeClient(d.id);
			await connected;
			await wait(30);

			expect(stateChanges).toContain(`${d.id}:working`);
		});

		it("sends shutdown and transitions on idle", async () => {
			const d = engine.addDeliverable({ title: "Work", dependsOn: [] });
			const f = createFanout();
			await f.start();
			await f.tick();

			const { client, connected } = makeClient(d.id);
			const messages: unknown[] = [];
			client.on("message", (msg) => messages.push(msg));
			await connected;
			await wait(30);

			client.send({ type: "status", status: "idle" });
			await wait(80);

			// Should have received shutdown
			expect(messages.some((m: any) => m.type === "shutdown")).toBe(true);
			// Deliverable should be in-review
			const plan = engine.get();
			const updated = plan.nodes.find(
				(n) => n.type === "deliverable" && n.id === d.id,
			);
			expect(updated && "status" in updated ? updated.status : null).toBe(
				"in-review",
			);
		});

		it("updates token snapshot on tokens message", async () => {
			const d = engine.addDeliverable({ title: "Work", dependsOn: [] });
			const f = createFanout();
			await f.start();
			await f.tick();

			const { client, connected } = makeClient(d.id);
			await connected;
			await wait(30);

			client.send({
				type: "tokens",
				snapshot: {
					input: 100,
					output: 50,
					cacheRead: 20,
					cacheWrite: 10,
					totalTokens: 180,
					cost: 0.5,
					turns: 3,
				},
			});
			await wait(80);

			const snapshot = f.snapshot();
			const state = snapshot.agents.get(d.id);
			expect(state?.tokens.input).toBe(100);
			expect(state?.tokens.turns).toBe(3);
		});

		it("marks failed on error status", async () => {
			const d = engine.addDeliverable({ title: "Work", dependsOn: [] });
			const f = createFanout();
			await f.start();
			await f.tick();

			const { client, connected } = makeClient(d.id);
			await connected;
			await wait(30);

			client.send({ type: "status", status: "error", detail: "crash" });
			await wait(80);

			const plan = engine.get();
			const updated = plan.nodes.find(
				(n) => n.type === "deliverable" && n.id === d.id,
			);
			expect(updated && "status" in updated ? updated.status : null).toBe(
				"needs-attention",
			);
		});
	});

	describe("steer()", () => {
		it("sends steer message to correct agent", async () => {
			const d = engine.addDeliverable({ title: "Work", dependsOn: [] });
			const f = createFanout();
			await f.start();
			await f.tick();

			const { client, connected } = makeClient(d.id);
			const messages: unknown[] = [];
			client.on("message", (msg) => messages.push(msg));
			await connected;
			await wait(30);

			const sent = f.steer(d.id, "please also fix tests");
			expect(sent).toBe(true);
			await wait(50);

			expect(
				messages.some(
					(m: any) =>
						m.type === "steer" && m.content === "please also fix tests",
				),
			).toBe(true);
		});

		it("returns false for unknown deliverable", async () => {
			const f = createFanout();
			await f.start();
			expect(f.steer("nonexistent", "hi")).toBe(false);
		});
	});

	describe("snapshot()", () => {
		it("returns current agent states", async () => {
			engine.addDeliverable({ title: "A", dependsOn: [] });
			engine.addDeliverable({ title: "B", dependsOn: [] });
			const f = createFanout();
			await f.start();
			await f.tick();
			const snap = f.snapshot();
			expect(snap.agents.size).toBe(2);
		});
	});

	describe("destroy()", () => {
		it("kills all sessions and closes server", async () => {
			engine.addDeliverable({ title: "Work", dependsOn: [] });
			const f = createFanout();
			await f.start();
			await f.tick();
			await f.destroy();
			expect(tmux.kill).toHaveBeenCalledTimes(1);
		});
	});
});
