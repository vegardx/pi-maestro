// Observability seam: real token snapshots in NodeExecutionAdapter.snapshot(),
// per-agent state reports (onAgentStateChanged with incrementing revisions),
// the events.jsonl lifecycle log, steer targeting, and session-name
// resolution — driven over a real RPC socket with a stub tmux.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MaestroMessage, MaestroRpcClient } from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import {
	type AgentStateSnapshot,
	NodeExecutionAdapter,
	type TmuxLikeApi,
} from "../packages/modes/src/plan/node-adapter.js";
import { createPlanStoreV2 } from "../packages/modes/src/plan/storage.js";

const TOKEN = "obs-test-token";

/** Stub tmux: records spawns; sessions are never "alive" (skips kill waits). */
function stubTmux(): TmuxLikeApi & { spawned: string[] } {
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

describe("node execution adapter observability", () => {
	let tmpDir: string;
	let planDir: string;
	let adapter: NodeExecutionAdapter;
	let engine: PlanEngineV2;
	let tmux: ReturnType<typeof stubTmux>;
	let stateReports: { nodeId: string; state: AgentStateSnapshot }[];
	const clients: MaestroRpcClient[] = [];
	let suiteStart = 0;

	beforeEach(async () => {
		suiteStart = Date.now();
		tmpDir = mkdtempSync(join(tmpdir(), "obs-test-"));
		planDir = join(tmpDir, "plan");

		engine = PlanEngineV2.create(createPlanStoreV2(join(tmpDir, "plans")), {
			slug: "obs",
			title: "Obs Plan",
			repoPath: tmpDir,
		});
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Deliverable One",
			branch: "feat/one",
			tasks: ["do the thing"],
		});
		// Pre-provisioned active node: the executor hydrates it and spawns the
		// worker without touching git worktree provisioning.
		engine.setNodeStatus("deliverable-one", "active");
		engine.setNodeRuntime("deliverable-one", { worktreePath: tmpDir });

		tmux = stubTmux();
		stateReports = [];
		adapter = new NodeExecutionAdapter({
			engine,
			planDir,
			tmux,
			token: TOKEN,
			socketPath: join(tmpDir, "maestro.sock"),
			defaultBranch: "main",
			onPlanChanged: () => {},
			onAgentStateChanged: (nodeId, state) => {
				stateReports.push({ nodeId, state });
			},
		});
		await adapter.start();
		// Hydrated active nodes come up blocked (restart safety); audited
		// recovery clears this before the tick spawns the worker.
		adapter.getExecutor().unblockNode("deliverable-one");
		await adapter.tick();
	});

	afterEach(async () => {
		for (const c of clients.splice(0)) c.close();
		await adapter.destroy();
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
		const { client, ready } = connect("deliverable-one");
		await ready;

		client.send({
			type: "tokens",
			revision: 1,
			snapshot: {
				input: 1234,
				output: 56,
				cacheRead: 0,
				cacheWrite: 0,
				promptTokens: 1234,
				totalTokens: 1290,
				cost: 0.02,
				turns: 7,
			},
		});
		await until(() => {
			const agent = adapter.snapshot().agents.get("deliverable-one");
			return agent?.tokens.input === 1234;
		});

		const snap = adapter.snapshot();
		const worker = snap.agents.get("deliverable-one");
		expect(worker?.tokens).toEqual({
			input: 1234,
			output: 56,
			cacheRead: 0,
			cacheWrite: 0,
			turns: 7,
		});
		expect(worker?.status).toBe("working");
		expect(worker?.startedAt).toBeGreaterThanOrEqual(suiteStart);
		expect(worker?.startedAt).toBeLessThanOrEqual(Date.now());
		expect(snap.deliverables.get("deliverable-one")).toEqual({});
	});

	it("reports per-agent state with incrementing revisions (0 at spawn, then 1, 2, …)", async () => {
		// The spawn seeded revision 0 with a zero snapshot — the agent's first
		// real cumulative report must be revision 1 (a tie at 1 would be
		// rejected by checkpoint recording downstream).
		expect(stateReports[0]).toMatchObject({
			nodeId: "deliverable-one",
			state: { status: "working", revision: 0 },
		});
		expect(stateReports[0].state.tokens.input).toBe(0);

		const { client, ready } = connect("deliverable-one");
		await ready;
		const snapshot = {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			promptTokens: 100,
			totalTokens: 110,
			cost: 0.01,
			turns: 1,
		};
		client.send({ type: "tokens", revision: 1, snapshot });
		client.send({
			type: "tokens",
			revision: 2,
			snapshot: { ...snapshot, input: 200, turns: 2 },
		});
		await until(() => stateReports.length >= 3);

		expect(stateReports[1].state.revision).toBe(1);
		expect(stateReports[1].state.tokens.input).toBe(100);
		expect(stateReports[2].state.revision).toBe(2);
		expect(stateReports[2].state.tokens.input).toBe(200);
	});

	it("steer targets the node's connected agent; unconnected targets return false", async () => {
		const worker = connect("deliverable-one");
		await worker.ready;

		expect(adapter.steer("deliverable-one", "focus on the tests")).toBe(true);
		await until(() =>
			worker.received.some(
				(m) => m.type === "steer" && m.content === "focus on the tests",
			),
		);

		expect(adapter.steer("nobody", "hello?")).toBe(false);
	});

	it("resolves node ids, tmux session ids, and display names", () => {
		const sessionName = tmux.spawned[0];
		expect(sessionName).toBeTruthy();
		const displayName = adapter
			.getExecutor()
			.getRunState("deliverable-one")?.displayName;
		expect(displayName).toBeTruthy();
		expect(adapter.resolveSessionName("deliverable-one")).toBe(sessionName);
		expect(adapter.resolveSessionName(sessionName)).toBe(sessionName);
		expect(adapter.resolveSessionName(displayName as string)).toBe(sessionName);
		expect(adapter.resolveSessionName("nope")).toBeUndefined();
	});

	it("appends lifecycle events to events.jsonl (agent-stopped vocabulary)", async () => {
		const stopped = await adapter.stop(
			"deliverable-one",
			undefined,
			"stopping for the test",
		);
		expect(stopped).toBe(true);

		const events = readEvents(planDir);
		const entry = events.find((e) => e.event === "agent-stopped");
		expect(entry).toMatchObject({
			agent: "deliverable-one",
			reason: "stopping for the test",
		});
		expect(typeof entry?.ts).toBe("string");
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
