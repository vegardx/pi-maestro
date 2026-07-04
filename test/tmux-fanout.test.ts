import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSocketPath, MaestroRpcClient } from "@vegardx/pi-rpc";
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
			extensionPath: "/ext/path",
			planDir,
			defaultBranch: "main",
			ctx: mockCtx,
			...overrides,
		});
		return fanout;
	}

	function makeClient(agentId: string): {
		client: MaestroRpcClient;
		connected: Promise<void>;
	} {
		const socketPath = createSocketPath(planDir);
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

		it("does not shutdown on idle if tasks remain", async () => {
			const d = engine.addDeliverable({ title: "Work", dependsOn: [] });
			engine.addWorkItem(d.id, { title: "Do something" });
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

			// Should NOT have received shutdown
			expect(messages.some((m: any) => m.type === "shutdown")).toBe(false);
			// Deliverable still active
			const plan = engine.get();
			const updated = plan.nodes.find(
				(n) => n.type === "deliverable" && n.id === d.id,
			);
			expect(updated && "status" in updated ? updated.status : null).toBe(
				"active",
			);
		});

		it("marks failed when agent disconnects and session is dead without shutdown", async () => {
			const d = engine.addDeliverable({ title: "Work", dependsOn: [] });
			engine.addWorkItem(d.id, { title: "Incomplete task" });
			const f = createFanout();
			await f.start();
			await f.tick();

			const { client, connected } = makeClient(d.id);
			await connected;
			await wait(30);

			// Session is dead when disconnect happens (no shutdown was sent)
			vi.mocked(tmux.hasSession).mockResolvedValue(false);
			client.close();
			await wait(80);

			const plan = engine.get();
			const updated = plan.nodes.find(
				(n) => n.type === "deliverable" && n.id === d.id,
			);
			expect(updated && "status" in updated ? updated.status : null).toBe(
				"needs-attention",
			);
		});

		it("does not mark done on disconnect if session is still alive", async () => {
			const d = engine.addDeliverable({ title: "Work", dependsOn: [] });
			const f = createFanout();
			await f.start();
			await f.tick();

			const { client, connected } = makeClient(d.id);
			await connected;
			await wait(30);

			// Session still alive (transient RPC disconnect)
			vi.mocked(tmux.hasSession).mockResolvedValue(true);
			client.close();
			await wait(80);

			const plan = engine.get();
			const updated = plan.nodes.find(
				(n) => n.type === "deliverable" && n.id === d.id,
			);
			expect(updated && "status" in updated ? updated.status : null).toBe(
				"active",
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

	describe("review loop circuit breaker", () => {
		it("increments reviewCycles on review lensUsage", async () => {
			const d = engine.addDeliverable({ title: "Work", dependsOn: [] });
			engine.addWorkItem(d.id, { title: "Implement" });
			const f = createFanout();
			await f.start();
			await f.tick();

			const { client, connected } = makeClient(d.id);
			await connected;
			await wait(30);

			client.send({
				type: "lensUsage",
				lens: "review",
				snapshot: {
					input: 1000,
					output: 500,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1500,
					cost: 0,
					turns: 1,
				},
			});
			await wait(50);

			const state = f.snapshot().agents.get(d.id);
			expect(state?.reviewCycles).toBe(1);
			expect(state?.lensRuns).toBe(1);
		});

		it("increments lensRuns for non-review lenses without incrementing reviewCycles", async () => {
			const d = engine.addDeliverable({ title: "Work", dependsOn: [] });
			engine.addWorkItem(d.id, { title: "Implement" });
			const f = createFanout();
			await f.start();
			await f.tick();

			const { client, connected } = makeClient(d.id);
			await connected;
			await wait(30);

			client.send({
				type: "lensUsage",
				lens: "refine",
				snapshot: {
					input: 1000,
					output: 500,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1500,
					cost: 0,
					turns: 1,
				},
			});
			await wait(50);

			const state = f.snapshot().agents.get(d.id);
			expect(state?.reviewCycles).toBe(0);
			expect(state?.lensRuns).toBe(1);
		});

		it("steers agent at MAX_REVIEW_CYCLES (2)", async () => {
			const d = engine.addDeliverable({ title: "Work", dependsOn: [] });
			engine.addWorkItem(d.id, { title: "Implement" });
			const f = createFanout();
			await f.start();
			await f.tick();

			const { client, connected } = makeClient(d.id);
			const messages: unknown[] = [];
			client.on("message", (msg) => messages.push(msg));
			await connected;
			await wait(30);

			const snapshot = {
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1500,
				cost: 0,
				turns: 1,
			};

			// First review — no steer
			client.send({ type: "lensUsage", lens: "review", snapshot });
			await wait(50);
			expect(messages.filter((m: any) => m.type === "steer").length).toBe(0);

			// Second review — triggers soft steer
			client.send({ type: "lensUsage", lens: "review", snapshot });
			await wait(50);
			const steers = messages.filter((m: any) => m.type === "steer") as any[];
			expect(steers.length).toBe(1);
			expect(steers[0].content).toContain("only fix IMPORTANT");
		});

		it("force-steers agent beyond MAX_REVIEW_CYCLES", async () => {
			const d = engine.addDeliverable({ title: "Work", dependsOn: [] });
			engine.addWorkItem(d.id, { title: "Implement" });
			const f = createFanout();
			await f.start();
			await f.tick();

			const { client, connected } = makeClient(d.id);
			const messages: unknown[] = [];
			client.on("message", (msg) => messages.push(msg));
			await connected;
			await wait(30);

			const snapshot = {
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1500,
				cost: 0,
				turns: 1,
			};

			// Three reviews — third triggers force steer
			client.send({ type: "lensUsage", lens: "review", snapshot });
			await wait(50);
			client.send({ type: "lensUsage", lens: "review", snapshot });
			await wait(50);
			client.send({ type: "lensUsage", lens: "review", snapshot });
			await wait(50);

			const steers = messages.filter((m: any) => m.type === "steer") as any[];
			// Soft steer at cycle 2, force steer at cycle 3
			expect(steers.length).toBe(2);
			expect(steers[1].content).toContain("STOP");
			expect(steers[1].content).toContain("ship tool");
		});
	});

	describe("concurrency cap", () => {
		it("limits spawned agents to maxWorkers (default 4)", async () => {
			// Add 8 independent deliverables
			for (let i = 0; i < 8; i++) {
				engine.addDeliverable({ title: `Task ${i + 1}`, dependsOn: [] });
			}
			const f = createFanout();
			await f.start();
			const spawned = await f.tick();
			// Default maxWorkers = 4
			expect(spawned).toBe(4);
			expect(tmux.spawn).toHaveBeenCalledTimes(4);
		});

		it("spawns more when active count drops below limit", async () => {
			const ds = [];
			for (let i = 0; i < 6; i++) {
				ds.push(
					engine.addDeliverable({ title: `Task ${i + 1}`, dependsOn: [] }),
				);
			}
			const f = createFanout();
			await f.start();
			await f.tick();
			expect(tmux.spawn).toHaveBeenCalledTimes(4);

			// Simulate first agent completing via RPC
			const { client, connected } = makeClient(ds[0].id);
			await connected;
			await wait(30);
			client.send({ type: "done", summary: "done" });
			await wait(80);

			// markDone calls tick() which should spawn one more
			expect(tmux.spawn).toHaveBeenCalledTimes(5);
		});

		it("respects MAESTRO_MAX_WORKERS env override", async () => {
			const original = process.env.MAESTRO_MAX_WORKERS;
			process.env.MAESTRO_MAX_WORKERS = "2";

			try {
				for (let i = 0; i < 5; i++) {
					engine.addDeliverable({ title: `Task ${i + 1}`, dependsOn: [] });
				}
				const f = createFanout();
				await f.start();
				const spawned = await f.tick();
				expect(spawned).toBe(2);
				expect(tmux.spawn).toHaveBeenCalledTimes(2);
			} finally {
				if (original === undefined) delete process.env.MAESTRO_MAX_WORKERS;
				else process.env.MAESTRO_MAX_WORKERS = original;
			}
		});
	});

	describe("destroy()", () => {
		it("kills all sessions and closes server", async () => {
			engine.addDeliverable({ title: "Work", dependsOn: [] });
			const f = createFanout();
			await f.start();
			await f.tick();
			await f.destroy();
			expect(tmux.kill).toHaveBeenCalledTimes(2); // stale cleanup + destroy
		});
	});

	describe("checkpoint forking", () => {
		it("uses cold start when no analyzeOpts provided", async () => {
			engine.addDeliverable({ title: "Cold", dependsOn: [] });
			const f = createFanout(); // no analyzeOpts
			await f.start();
			await f.tick();

			// Session file is created in worktree (cold start path)
			const call = vi.mocked(tmux.spawn).mock.calls[0];
			expect(call[2]).toContain("--session");
			expect(call[2]).toContain("_agent-cold.jsonl");
		});

		it("forks from checkpoint when analyzeResult is available", async () => {
			const { writeFileSync, mkdirSync } = await import("node:fs");
			const { readFileSync } = await import("node:fs");

			// Create a compacted session file
			const compactDir = mkdtempSync(join(tmpdir(), "compact-"));
			const compactFile = join(compactDir, "compact_core.jsonl");
			const lines = [
				JSON.stringify({
					type: "session",
					version: 3,
					id: "compact-sess",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: "/original",
				}),
				JSON.stringify({
					type: "custom_message",
					customType: "maestro.analyze.context",
					content: "Explored: project uses vitest, TypeScript strict mode",
					display: false,
					id: "ctx-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
				}),
			];
			writeFileSync(compactFile, `${lines.join("\n")}\n`);

			engine.addDeliverable({ title: "Forked", dependsOn: [] });

			// Provide analyzeOpts with a spawn that writes a dummy session
			// (analyze won't actually run since we pre-set the result)
			const analyzeOpts = {
				sessionDir: join(root, "analyze-sessions"),
				compactDir,
				spawn: async (opts: { sessionFile: string }) => {
					// Write session with a checkpoint
					const header = JSON.stringify({
						type: "session",
						version: 3,
						id: "analyze-sess",
						timestamp: "t",
						cwd: "/repo",
					});
					const cp = JSON.stringify({
						type: "custom",
						customType: "maestro.analyze.checkpoint",
						data: { label: "core" },
						id: "cp-1",
						parentId: null,
						timestamp: "t",
					});
					mkdirSync(join(root, "analyze-sessions"), { recursive: true });
					writeFileSync(opts.sessionFile, `${header}\n${cp}\n`);
				},
				compact: async () => compactFile,
			};

			const f = createFanout({ analyzeOpts });
			await f.start();
			await f.tick();

			// The spawned session should reference a forked file
			const call = vi.mocked(tmux.spawn).mock.calls[0];
			expect(call[2]).toContain("fork_");

			// The forked file should contain the compacted context + appended entries
			const sessionMatch = call[2].match(/--session "([^"]+)"/);
			expect(sessionMatch).not.toBeNull();
			const sessionContent = readFileSync(sessionMatch![1], "utf8");
			expect(sessionContent).toContain("maestro.analyze.context");
			expect(sessionContent).toContain("maestro.modes.state");
			expect(sessionContent).toContain("maestro-execution-seed");
			expect(sessionContent).toContain("forked"); // deliverableId

			rmSync(compactDir, { recursive: true, force: true });
		});

		it("falls back to cold start when fork fails", async () => {
			engine.addDeliverable({ title: "Fallback", dependsOn: [] });

			const analyzeOpts = {
				sessionDir: join(root, "analyze-sessions"),
				compactDir: join(root, "compact"),
				spawn: async (opts: { sessionFile: string }) => {
					const { writeFileSync: wf, mkdirSync: md } = await import("node:fs");
					md(join(root, "analyze-sessions"), { recursive: true });
					const header = JSON.stringify({
						type: "session",
						version: 3,
						id: "s",
						timestamp: "t",
						cwd: "/repo",
					});
					const cp = JSON.stringify({
						type: "custom",
						customType: "maestro.analyze.checkpoint",
						data: { label: "core" },
						id: "cp-1",
						parentId: null,
						timestamp: "t",
					});
					wf(opts.sessionFile, `${header}\n${cp}\n`);
				},
				// compact returns a nonexistent file → fork will fail
				compact: async () => "/nonexistent/file.jsonl",
			};

			const f = createFanout({ analyzeOpts });
			await f.start();
			await f.tick();

			// Should still spawn (cold start fallback)
			expect(tmux.spawn).toHaveBeenCalledTimes(1);
			const call = vi.mocked(tmux.spawn).mock.calls[0];
			// Cold start path: _agent-fallback.jsonl
			expect(call[2]).toContain("_agent-fallback.jsonl");
		});

		it("passes MAESTRO_WORKER_MODEL as PI_MODEL env var", async () => {
			const original = process.env.MAESTRO_WORKER_MODEL;
			process.env.MAESTRO_WORKER_MODEL = "anthropic/test-model";

			try {
				engine.addDeliverable({ title: "Model", dependsOn: [] });
				const f = createFanout();
				await f.start();
				await f.tick();

				const call = vi.mocked(tmux.spawn).mock.calls[0];
				expect(call[2]).toContain("PI_MODEL=anthropic/test-model");
			} finally {
				if (original === undefined) delete process.env.MAESTRO_WORKER_MODEL;
				else process.env.MAESTRO_WORKER_MODEL = original;
			}
		});
	});
});
