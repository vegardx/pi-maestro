// Observability seam: real token snapshots in ExecutionAdapter.snapshot(),
// the events.jsonl lifecycle log, steer targeting, and session-name
// resolution — driven over a real RPC socket with a stub tmux.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type MaestroMessage, MaestroRpcClient } from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	ExecutionAdapter,
	type TmuxApi,
} from "../packages/modes/src/exec/execution-adapter.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

const TOKEN = "obs-test-token";

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

function readEvents(
	planDir: string,
): { event: string; [k: string]: unknown }[] {
	return readFileSync(join(planDir, "events.jsonl"), "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

describe("execution adapter observability", () => {
	let tmpDir: string;
	let planDir: string;
	let adapter: ExecutionAdapter;
	let engine: PlanEngine;
	let tmux: ReturnType<typeof stubTmux>;
	const clients: MaestroRpcClient[] = [];
	let suiteStart = 0;
	let prevSessionDir: string | undefined;

	beforeEach(async () => {
		suiteStart = Date.now();
		tmpDir = mkdtempSync(join(tmpdir(), "obs-test-"));
		planDir = join(tmpDir, "plan");
		prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpDir, "sessions");

		engine = PlanEngine.create(memStore(), {
			slug: "obs",
			title: "Obs Plan",
			repoPath: tmpDir,
		});
		engine.addDeliverable({ title: "Deliverable One", workerMode: "full" });
		engine.addWorkItem("deliverable-one", {
			title: "do the thing",
			kind: "task",
		});
		// Pre-provisioned active deliverable: the executor hydrates it and spawns the
		// worker without touching git worktree provisioning.
		engine.setDeliverableStatus("deliverable-one", "active");
		engine.updateDeliverable("deliverable-one", { worktreePath: tmpDir });

		tmux = stubTmux();
		adapter = new ExecutionAdapter({
			engine,
			ctx: { cwd: tmpDir } as ExtensionContext,
			extensionPath: "/nonexistent/ext",
			defaultBranch: "main",
			planDir,
			tmux,
			token: TOKEN,
			socketPath: join(tmpDir, "maestro.sock"),
			resolveWorkerModel: async (choice) => ({
				modelId: choice.model ?? "test/worker",
				effort: choice.effort ?? "low",
			}),
			onPlanChanged: () => {},
		});
		await adapter.start();
		// Hydrated active deliverables come up blocked (restart safety); unblock as
		// a user's /retry would so the tick spawns the worker.
		adapter.getExecutor().unblockDeliverable("deliverable-one");
		await adapter.tick();
	});

	afterEach(async () => {
		for (const c of clients.splice(0)) c.close();
		await adapter.destroy();
		if (prevSessionDir === undefined) {
			delete process.env.PI_CODING_AGENT_SESSION_DIR;
		} else {
			process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDir;
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function connect(agentId: string): {
		client: MaestroRpcClient;
		received: MaestroMessage[];
		ready: Promise<void>;
	} {
		const client = new MaestroRpcClient({ reconnect: false });
		clients.push(client);
		const received: MaestroMessage[] = [];
		client.on("message", (msg) => received.push(msg));
		client.connect(join(tmpDir, "maestro.sock"), {
			agentId,
			role: "agent",
			token: TOKEN,
			pid: process.pid,
		});
		const ready = until(() =>
			received.some((m) => m.type === "helloAck" && m.ok),
		);
		return { client, received, ready };
	}

	it("snapshot() returns real tokens after a tokens message and real spawn time", async () => {
		const { client, ready } = connect("deliverable-one/worker");
		await ready;

		client.send({
			type: "tokens",
			snapshot: {
				input: 1234,
				output: 56,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1290,
				cost: 0.02,
				turns: 7,
			},
		});
		await until(() => {
			const agent = adapter.snapshot().agents.get("deliverable-one/worker");
			return agent?.tokens.input === 1234;
		});

		const snap = adapter.snapshot();
		const worker = snap.agents.get("deliverable-one/worker");
		expect(worker?.tokens).toEqual({ input: 1234, output: 56, turns: 7 });
		expect(worker?.status).toBe("working");
		expect(worker?.startedAt).toBeGreaterThanOrEqual(suiteStart);
		expect(worker?.startedAt).toBeLessThanOrEqual(Date.now());
		expect(snap.deliverables.get("deliverable-one")).toEqual({});
	});

	it("steer targets the worker by default and named agents by prefix", async () => {
		const worker = connect("deliverable-one/worker");
		const reviewer = connect("deliverable-one/reviewer-x");
		await worker.ready;
		await reviewer.ready;

		expect(adapter.steer("deliverable-one", "focus on the tests")).toBe(true);
		await until(() =>
			worker.received.some(
				(m) => m.type === "steer" && m.content === "focus on the tests",
			),
		);
		expect(reviewer.received.some((m) => m.type === "steer")).toBe(false);

		expect(
			adapter.steer("deliverable-one", "check the tests", "reviewer-x"),
		).toBe(true);
		await until(() =>
			reviewer.received.some(
				(m) => m.type === "steer" && m.content === "check the tests",
			),
		);

		expect(adapter.steer("deliverable-one", "hello?", "nobody")).toBe(false);
	});

	it("resolves deliverable ids, agent keys, agent names, and session names", () => {
		const sessionName = tmux.spawned[0];
		expect(sessionName).toBeTruthy();
		expect(adapter.resolveSessionName("deliverable-one")).toBe(sessionName);
		expect(adapter.resolveSessionName("deliverable-one/worker")).toBe(
			sessionName,
		);
		expect(adapter.resolveSessionName("worker")).toBe(sessionName);
		expect(adapter.resolveSessionName(sessionName)).toBe(sessionName);
		expect(adapter.resolveSessionName("nope")).toBeUndefined();
	});

	it("appends spawn and done events to events.jsonl", async () => {
		const afterSpawn = readEvents(planDir);
		const spawn = afterSpawn.find((e) => e.event === "spawn");
		expect(spawn).toMatchObject({
			agent: "deliverable-one/worker",
			session: tmux.spawned[0],
			resumed: false,
		});
		expect(typeof spawn?.ts).toBe("string");

		await adapter.markAgentDone("deliverable-one", "worker");
		const events = readEvents(planDir).map((e) => e.event);
		expect(events).toContain("done");
		const done = readEvents(planDir).find((e) => e.event === "done");
		expect(done?.agent).toBe("deliverable-one/worker");
	});
});

describe("UsageLedger snapshot normalization", () => {
	it("partial snapshots (spawn-time {input,output,turns}) never poison totals into NaN", async () => {
		const { UsageLedger } = await import(
			"../packages/modes/src/usage-ledger.js"
		);
		const ledger = new UsageLedger();
		// The execution adapter reports exactly this shape at spawn — the
		// missing cacheRead/totalTokens/cost summed as undefined → NaN, which
		// rendered as "CH NaN%" and a phantom "↑0 ↓0" in the footer.
		ledger.record({ kind: "agent", id: "g/worker" }, {
			input: 0,
			output: 0,
			turns: 0,
		} as never);
		const { totals } = ledger.snapshot();
		expect(totals.totalTokens).toBe(0);
		expect(Number.isNaN(totals.cacheRead)).toBe(false);
		expect(Number.isNaN(totals.cost)).toBe(false);
	});

	it("computes totalTokens when the partial omits it", async () => {
		const { UsageLedger } = await import(
			"../packages/modes/src/usage-ledger.js"
		);
		const ledger = new UsageLedger();
		ledger.record({ kind: "agent", id: "g/worker" }, {
			input: 100,
			output: 50,
			turns: 2,
		} as never);
		expect(ledger.snapshot().totals.totalTokens).toBe(150);
	});
});
