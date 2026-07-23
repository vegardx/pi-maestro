// NodeExecutionAdapter onEvent emission: spawn/done payloads (summary,
// duration, tokens), the shipped event, and the settled event firing exactly
// once — then RE-ARMING when new runnable work appears (append-only children).
// Driven over a real RPC socket with a stub tmux, like the parity twins.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MaestroMessage, MaestroRpcClient } from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import {
	type ExecutionEvent,
	type LauncherApi,
	NodeExecutionAdapter,
} from "../packages/modes/src/plan/node-adapter.js";
import { findNodeV2 } from "../packages/modes/src/plan/schema.js";
import { createPlanStoreV2 } from "../packages/modes/src/plan/storage.js";

const TOKEN = "agent-events-token";

/** Stub tmux: records spawns; sessions are never "alive" (skips kill waits). */
function stubTmux(): LauncherApi & { spawned: string[] } {
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

function until(pred: () => boolean, timeoutMs = 8000): Promise<void> {
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

describe("node execution adapter — onEvent emission", () => {
	let tmpDir: string;
	let engine: PlanEngineV2;
	let tmux: ReturnType<typeof stubTmux>;
	let adapter: NodeExecutionAdapter | undefined;
	let events: ExecutionEvent[];
	let settledCalls: number;
	const clients: MaestroRpcClient[] = [];

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "agent-events-"));
		engine = PlanEngineV2.create(createPlanStoreV2(join(tmpDir, "plans")), {
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
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeAdapter(): NodeExecutionAdapter {
		adapter = new NodeExecutionAdapter({
			engine,
			planDir: join(tmpDir, "plan"),
			launcher: tmux,
			token: TOKEN,
			socketPath: join(tmpDir, "maestro.sock"),
			defaultBranch: "main",
			onPlanChanged: () => {},
			shipNode: async () => "https://example/pr/1",
			onAllSettled: () => {
				settledCalls++;
			},
			onEvent: (event) => {
				events.push(event);
			},
		});
		return adapter;
	}

	/** Start the adapter over a pre-provisioned active node (no git). */
	async function startAdapter(nodeId: string): Promise<NodeExecutionAdapter> {
		engine.setNodeStatus(nodeId, "active");
		engine.setNodeRuntime(nodeId, { worktreePath: tmpDir });
		const a = makeAdapter();
		await a.start();
		// Hydrated active nodes come up blocked (restart safety); audited
		// recovery clears this before ticks may spawn agents.
		a.getExecutor().unblockNode(nodeId);
		await a.tick();
		return a;
	}

	/** Connect a scripted agent that auto-answers summarize requests. */
	function connect(
		agentId: string,
		summary: string,
	): {
		client: MaestroRpcClient;
		ready: Promise<void>;
		toggleTask: (taskId: string) => void;
		idle: () => void;
	} {
		const client = new MaestroRpcClient({ reconnect: false });
		clients.push(client);
		const received: MaestroMessage[] = [];
		let nextId = 1;
		client.on("message", (msg) => {
			received.push(msg);
			if (msg.type === "ping") client.send({ type: "pong", id: msg.id });
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
		return {
			client,
			ready,
			toggleTask: (taskId: string) => {
				client.send({
					type: "planMutate",
					id: `m${nextId++}`,
					action: "toggleTask",
					deliverableId: agentId,
					params: { taskId },
				});
			},
			idle: () => client.send({ type: "status", status: "idle" }),
		};
	}

	it("emits spawn, done (summary + duration + tokens), and shipped", async () => {
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Work",
			branch: "feat/work",
			tasks: ["implement it"],
		});
		const adapter = await startAdapter("work");

		const spawn = events.find((e) => e.kind === "spawn");
		expect(spawn).toMatchObject({
			kind: "spawn",
			agentKey: "work",
			resumed: false,
			deliverableTitle: "Work",
		});
		expect(spawn && "session" in spawn && spawn.session).toBe(tmux.spawned[0]);

		// The worker is a live pane before completion.
		expect(adapter.getWorkerSessions()).toEqual([tmux.spawned[0]]);

		const worker = connect("work", "## Summary\nshipped the login flow");
		await worker.ready;
		worker.client.send({
			type: "tokens",
			revision: 1,
			snapshot: {
				input: 4000,
				output: 900,
				cacheRead: 6000,
				cacheWrite: 0,
				promptTokens: 10_000,
				totalTokens: 10_900,
				cost: 0.05,
				turns: 5,
			},
		});
		await until(
			() => adapter.snapshot().agents.get("work")?.tokens.input === 4000,
		);

		// The real completion path: toggle every gating task (the postflight was
		// injected at activation), then report idle.
		worker.toggleTask("implement-it");
		worker.toggleTask("lifecycle-postflight");
		worker.idle();

		await until(() => events.some((e) => e.kind === "shipped"));

		const done = events.find((e) => e.kind === "done");
		expect(done).toBeDefined();
		if (done?.kind !== "done") throw new Error("unreachable");
		expect(done.agentKey).toBe("work");
		expect(done.deliverableTitle).toBe("Work");
		expect(done.summary).toContain("shipped the login flow");
		expect(done.durationMs).toBeGreaterThanOrEqual(0);
		expect(done.tokens).toEqual({
			input: 4000,
			output: 900,
			cacheRead: 6000,
			cacheWrite: 0,
			turns: 5,
		});

		const shipped = events.find((e) => e.kind === "shipped");
		expect(shipped).toMatchObject({
			kind: "shipped",
			deliverableId: "work",
			deliverableTitle: "Work",
			prUrl: "https://example/pr/1",
		});
		expect(findNodeV2(engine.get(), "work")?.status).toBe("shipped");
	});

	it("emits settled exactly once, then re-arms when new runnable work appears", async () => {
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Alpha",
			tasks: ["some task"],
		});
		engine.setNodeStatus("alpha", "abandoned");
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

		// Append-only child work re-arms the settled gate: no new event while
		// the child is runnable, a second settled once it terminates.
		engine.appendChild(
			"alpha",
			{ agent: "worker", persona: "coder", title: "Beta" },
			"plan",
		);
		await adapter.tick();
		expect(events.filter((e) => e.kind === "settled")).toHaveLength(1);

		engine.setNodeStatus("beta", "abandoned");
		await adapter.tick();
		expect(events.filter((e) => e.kind === "settled")).toHaveLength(2);
		expect(settledCalls).toBe(2);
	});
});
