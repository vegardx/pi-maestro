// ExecutionAdapter onEvent emission: spawn/done payloads (summary, duration,
// tokens), the settled event firing exactly once, and live-session
// bookkeeping being pruned after finishAgent so getWorkerSessions() only
// returns live workers (auto-closing /watch panes). Driven over a real RPC
// socket with a stub tmux, like lifecycle-correctness.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type MaestroMessage, MaestroRpcClient } from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	ExecutionAdapter,
	type ExecutionEvent,
	type TmuxApi,
} from "../packages/modes/src/exec/execution-adapter.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

const TOKEN = "agent-events-token";

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

/** Stub tmux: records spawns; sessions are never "alive" (skips kill waits). */
function stubTmux(): TmuxApi & { spawned: string[] } {
	const spawned: string[] = [];
	return {
		spawned,
		async spawn(name: string) {
			spawned.push(name);
		},
		async hasSession() {
			return false;
		},
		async kill() {},
	};
}

function until(pred: () => boolean, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const timer = setInterval(() => {
			if (pred()) {
				clearInterval(timer);
				resolve();
			} else if (Date.now() - start > timeoutMs) {
				clearInterval(timer);
				reject(new Error("timed out waiting for condition"));
			}
		}, 10);
	});
}

describe("execution adapter — onEvent emission", () => {
	let tmpDir: string;
	let engine: PlanEngine;
	let tmux: ReturnType<typeof stubTmux>;
	let adapter: ExecutionAdapter | undefined;
	let events: ExecutionEvent[];
	let settledCalls: number;
	let prevSessionDir: string | undefined;
	const clients: MaestroRpcClient[] = [];

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "agent-events-"));
		prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpDir, "sessions");
		engine = PlanEngine.create(memStore(), {
			slug: "events",
			title: "Events Plan",
			repoPath: tmpDir,
		});
		tmux = stubTmux();
		events = [];
		settledCalls = 0;
	});

	afterEach(async () => {
		for (const c of clients.splice(0)) c.close();
		await adapter?.destroy();
		adapter = undefined;
		if (prevSessionDir === undefined) {
			delete process.env.PI_CODING_AGENT_SESSION_DIR;
		} else {
			process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDir;
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeAdapter(): ExecutionAdapter {
		adapter = new ExecutionAdapter({
			engine,
			ctx: { cwd: tmpDir } as ExtensionContext,
			extensionPath: "/nonexistent/ext",
			defaultBranch: "main",
			planDir: join(tmpDir, "plan"),
			tmux,
			token: TOKEN,
			socketPath: join(tmpDir, "maestro.sock"),
			resolveWorkerModel: async (choice) => ({
				modelId: choice.model ?? "test/worker",
				effort: choice.effort ?? "low",
			}),
			onPlanChanged: () => {},
			onAllSettled: () => {
				settledCalls++;
			},
			onEvent: (event) => {
				events.push(event);
			},
		});
		return adapter;
	}

	/** Start the adapter over a pre-provisioned active deliverable (no git). */
	async function startAdapter(
		deliverableId: string,
	): Promise<ExecutionAdapter> {
		engine.setDeliverableStatus(deliverableId, "active");
		engine.updateDeliverable(deliverableId, { worktreePath: tmpDir });
		const a = makeAdapter();
		await a.start();
		// Hydrated active deliverables come up blocked (restart safety); audited
		// recovery clears this before ticks may spawn agents.
		a.getExecutor().unblockDeliverable(deliverableId);
		await a.tick();
		return a;
	}

	/** Connect a fake agent that auto-answers summarize requests. */
	function connect(
		agentId: string,
		summary: string,
	): { client: MaestroRpcClient; ready: Promise<void> } {
		const client = new MaestroRpcClient({ reconnect: false });
		clients.push(client);
		const received: MaestroMessage[] = [];
		client.on("message", (msg) => {
			received.push(msg);
			if (msg.type === "summarize") {
				client.send({ type: "summary", id: msg.id, content: summary });
			}
		});
		client.connect(join(tmpDir, "maestro.sock"), {
			agentId,
			role: "agent",
			token: TOKEN,
			pid: process.pid,
		});
		const ready = until(() =>
			received.some((m) => m.type === "helloAck" && m.ok),
		);
		return { client, ready };
	}

	it("emits spawn and done (summary + duration + tokens) and prunes live-session bookkeeping", async () => {
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "implement it" });
		const adapter = await startAdapter("work");

		const spawn = events.find((e) => e.kind === "spawn");
		expect(spawn).toMatchObject({
			kind: "spawn",
			agentKey: "work/worker",
			resumed: false,
			deliverableTitle: "Work",
		});
		expect(spawn && "session" in spawn && spawn.session).toBe(tmux.spawned[0]);

		// The worker is a live pane before completion.
		expect(adapter.getWorkerSessions()).toEqual([tmux.spawned[0]]);

		const { client, ready } = connect(
			"work/worker",
			"## Summary\nshipped the login flow",
		);
		await ready;
		client.send({
			type: "tokens",
			snapshot: {
				input: 4000,
				output: 900,
				cacheRead: 6000,
				cacheWrite: 0,
				totalTokens: 10_900,
				cost: 0.05,
				turns: 5,
			},
		});
		await until(
			() => adapter.snapshot().agents.get("work/worker")?.tokens.input === 4000,
		);

		await adapter.markAgentDone("work", "worker");

		const done = events.find((e) => e.kind === "done");
		expect(done).toBeDefined();
		if (done?.kind !== "done") throw new Error("unreachable");
		expect(done.agentKey).toBe("work/worker");
		expect(done.deliverableTitle).toBe("Work");
		expect(done.summary).toContain("shipped the login flow");
		expect(done.durationMs).toBeGreaterThanOrEqual(0);
		expect(done.tokens).toEqual({ input: 4000, output: 900, turns: 5 });
		expect(done.cacheRatio).toBeCloseTo(0.6);

		// Session bookkeeping pruned: /watch panes for this agent auto-close.
		expect(adapter.getWorkerSessions()).toEqual([]);
		expect(adapter.resolveSessionName("work")).toBeUndefined();
	});

	it("emits settled exactly once with the final deliverable list", async () => {
		engine.addDeliverable({ title: "Alpha", workerMode: "full" });
		engine.addWorkItem("alpha", { title: "some task" });
		engine.setDeliverableStatus("alpha", "abandoned");
		const adapter = makeAdapter();
		await adapter.start();

		await adapter.tick();
		await adapter.tick();

		const settled = events.filter((e) => e.kind === "settled");
		expect(settled).toHaveLength(1);
		if (settled[0]?.kind !== "settled") throw new Error("unreachable");
		expect(settled[0].deliverables).toEqual([
			{ id: "alpha", title: "Alpha", status: "abandoned" },
		]);
		expect(settledCalls).toBe(1);
	});
});
