// Adapter lifecycle correctness: idle-based completion for agents without a
// task-based done signal (read-only reviewers, zero-gating-task workers),
// tick serialization, and pollSessions overlap/summarizing guards — driven
// over a real RPC socket with a stub tmux, like observability.test.ts.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type MaestroMessage, MaestroRpcClient } from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	ExecutionAdapter,
	type TmuxApi,
} from "../packages/modes/src/exec/execution-adapter.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

const TOKEN = "lifecycle-test-token";

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

/** Stub tmux with a swappable hasSession, for poll-overlap tests. */
function stubTmux(): TmuxApi & {
	spawned: string[];
	hasSessionImpl: (name: string) => Promise<boolean>;
} {
	const api = {
		spawned: [] as string[],
		hasSessionImpl: async (_name: string) => false,
		async spawn(name: string) {
			api.spawned.push(name);
		},
		hasSession(name: string) {
			return api.hasSessionImpl(name);
		},
		async kill() {},
	};
	return api;
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

function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("execution adapter — lifecycle correctness", () => {
	let tmpDir: string;
	let engine: PlanEngine;
	let tmux: ReturnType<typeof stubTmux>;
	let adapter: ExecutionAdapter | undefined;
	let prevSessionDir: string | undefined;
	let prevAgentDir: string | undefined;
	const clients: MaestroRpcClient[] = [];

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
		prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpDir, "sessions");
		// Isolate the global config: role resolution now reads the active preset,
		// so without this the dev's real ~/.config/pi preset leaks in.
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(tmpDir, "empty-agent");
		engine = PlanEngine.create(memStore(), {
			slug: "lifecycle",
			title: "Lifecycle Plan",
			repoPath: tmpDir,
		});
		tmux = stubTmux();
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
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Start the adapter over a pre-provisioned active deliverable (no git). */
	async function startAdapter(
		deliverableId: string,
	): Promise<ExecutionAdapter> {
		engine.setDeliverableStatus(deliverableId, "active");
		engine.updateDeliverable(deliverableId, { worktreePath: tmpDir });
		adapter = new ExecutionAdapter({
			engine,
			ctx: { cwd: tmpDir } as ExtensionContext,
			extensionPath: "/nonexistent/ext",
			defaultBranch: "main",
			planDir: join(tmpDir, "plan"),
			tmux,
			token: TOKEN,
			socketPath: join(tmpDir, "maestro.sock"),
			onPlanChanged: () => {},
		});
		await adapter.start();
		// Hydrated active deliverables come up blocked (restart safety); unblock as
		// a user's /retry would so ticks may spawn agents.
		adapter.getExecutor().unblockDeliverable(deliverableId);
		await adapter.tick();
		return adapter;
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

	it("completes a read-only reviewer after consecutive idle reports", async () => {
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "implement it" });
		engine.addAgent("work", {
			name: "rev",
			mode: "read-only",
			effort: "high",
			focus: "security review",
			after: ["worker"],
		});
		const adapter = await startAdapter("work");

		// Worker finishes; the reviewer spawns on the next tick.
		await adapter.markAgentDone("work", "worker");
		await adapter.tick();
		const executor = adapter.getExecutor();
		expect(executor.getAgentState("work", "rev")!.status).toBe("working");

		const { client, ready } = connect(
			"work/rev",
			"## Summary\nlooks good\nVERDICT: approve",
		);
		await ready;

		// One idle is not completion — the reviewer may just be thinking.
		client.send({ type: "status", status: "idle" });
		await wait(100);
		expect(executor.getAgentState("work", "rev")!.status).toBe("working");

		// The second consecutive idle is: summarize → done → deliverable complete.
		client.send({ type: "status", status: "idle" });
		await until(() => executor.getAgentState("work", "rev")!.status === "done");
		expect(executor.getAgentState("work", "rev")!.summary).toContain(
			"VERDICT: approve",
		);
		await until(() => engine.get().deliverables[0].status === "complete");
	});

	it("completes a zero-gating-task worker via consecutive idles", async () => {
		// Read-only workers may activate with no gating tasks; "all toggled"
		// is vacuously true, so idling is the only completion signal.
		engine.addDeliverable({ title: "Zero", workerMode: "read-only" });
		const adapter = await startAdapter("zero");
		const executor = adapter.getExecutor();
		expect(executor.getAgentState("zero", "worker")!.status).toBe("working");

		const { client, ready } = connect(
			"zero/worker",
			"## Summary\nsurveyed the code",
		);
		await ready;

		client.send({ type: "status", status: "idle" });
		await wait(100);
		expect(executor.getAgentState("zero", "worker")!.status).toBe("working");

		client.send({ type: "status", status: "idle" });
		await until(
			() => executor.getAgentState("zero", "worker")!.status === "done",
		);
		await until(() => engine.get().deliverables[0].status === "complete");
	});

	// Replays the crisp-oak incident: a worker with a REQUIRED review panel
	// toggled its last task, called `review`, and was summarized/killed before
	// the round returned — verdicts never arrived, the gate blocked "not yet
	// reviewed", and the human overrode blind.
	it("does not complete a worker whose required panel never reported — steers it to review", async () => {
		engine.addDeliverable({ title: "Gated", workerMode: "full" });
		engine.addWorkItem("gated", { title: "implement it" });
		engine.addSubAgent("gated", {
			name: "sec",
			persona: "security-audit",
			kind: "review",
			required: true,
		});
		const adapter = await startAdapter("gated");
		const executor = adapter.getExecutor();

		const steers: string[] = [];
		const client = new MaestroRpcClient({ reconnect: false });
		clients.push(client);
		const received: MaestroMessage[] = [];
		client.on("message", (msg) => {
			received.push(msg);
			if (msg.type === "steer") steers.push(msg.content);
			if (msg.type === "summarize") {
				client.send({ type: "summary", id: msg.id, content: "done" });
			}
		});
		client.connect(join(tmpDir, "maestro.sock"), {
			agentId: "gated/worker",
			role: "agent",
			token: TOKEN,
			pid: process.pid,
		});
		await until(() => received.some((m) => m.type === "helloAck" && m.ok));

		// Toggle the only gating task — previously this killed the worker here.
		const taskId = engine.get().deliverables[0].tasks[0].id;
		client.send({
			type: "planMutate",
			id: "m1",
			action: "toggleTask",
			deliverableId: "gated",
			params: { taskId },
		});
		await until(() => steers.length > 0);
		expect(steers[0]).toContain("review");
		expect(executor.getAgentState("gated", "worker")!.status).toBe("working");

		// Sustained idling without a panel round still must not complete it.
		client.send({ type: "status", status: "idle" });
		client.send({ type: "status", status: "idle" });
		client.send({ type: "status", status: "idle" });
		await wait(150);
		expect(executor.getAgentState("gated", "worker")!.status).toBe("working");

		// The worker complies: runs the panel and reports a round. Now idle
		// completes it normally.
		client.send({ type: "panelRead", id: "p1", deliverableId: "gated" });
		await until(() => received.some((m) => m.type === "panelReadResponse"));
		client.send({
			type: "panelVerdict",
			deliverableId: "gated",
			round: 1,
			verdicts: [
				{
					name: "sec",
					persona: "security-audit",
					required: true,
					verdict: "approve",
					ok: true,
				},
			],
		});
		client.send({ type: "status", status: "idle" });
		client.send({ type: "status", status: "idle" });
		await until(
			() => executor.getAgentState("gated", "worker")!.status === "done",
		);
	});

	it("defers completion while a review round is in flight (panelRead seen, no verdict yet)", async () => {
		engine.addDeliverable({ title: "Midreview", workerMode: "full" });
		engine.addWorkItem("midreview", { title: "implement it" });
		engine.addSubAgent("midreview", {
			name: "cor",
			persona: "correctness-review",
			kind: "review",
			required: true,
		});
		const adapter = await startAdapter("midreview");
		const executor = adapter.getExecutor();

		const { client, ready } = connect("midreview/worker", "done");
		await ready;

		// The worker starts its review round FIRST (panelRead), then toggles the
		// last task while reviewers are still running. The toggle-triggered
		// completion check must hold — killing here is the incident.
		client.send({ type: "panelRead", id: "p1", deliverableId: "midreview" });
		await wait(50);
		const taskId = engine.get().deliverables[0].tasks[0].id;
		client.send({
			type: "planMutate",
			id: "m1",
			action: "toggleTask",
			deliverableId: "midreview",
			params: { taskId },
		});
		client.send({ type: "status", status: "idle" });
		client.send({ type: "status", status: "idle" });
		await wait(150);
		expect(executor.getAgentState("midreview", "worker")!.status).toBe(
			"working",
		);

		// Round reports → completion proceeds.
		client.send({
			type: "panelVerdict",
			deliverableId: "midreview",
			round: 1,
			verdicts: [
				{
					name: "cor",
					persona: "correctness-review",
					required: true,
					verdict: "approve",
					ok: true,
				},
			],
		});
		client.send({ type: "status", status: "idle" });
		await until(
			() => executor.getAgentState("midreview", "worker")!.status === "done",
		);
	});

	it("workers without required reviewers complete exactly as before", async () => {
		engine.addDeliverable({ title: "Plain", workerMode: "full" });
		engine.addWorkItem("plain", { title: "implement it" });
		// Advisory-only panel: not required → must not hold completion.
		engine.addSubAgent("plain", {
			name: "docs",
			persona: "documentation",
			kind: "review",
			required: false,
		});
		const adapter = await startAdapter("plain");
		const executor = adapter.getExecutor();

		const { client, ready } = connect("plain/worker", "done");
		await ready;
		const taskId = engine.get().deliverables[0].tasks[0].id;
		client.send({
			type: "planMutate",
			id: "m1",
			action: "toggleTask",
			deliverableId: "plain",
			params: { taskId },
		});
		await until(
			() => executor.getAgentState("plain", "worker")!.status === "done",
		);
	});

	it("serializes overlapping tick calls through the mutex", async () => {
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });
		const adapter = await startAdapter("work");

		let active = 0;
		let maxActive = 0;
		const spy = vi
			.spyOn(adapter.getExecutor(), "tick")
			.mockImplementation(async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await wait(20);
				active -= 1;
				return [];
			});

		await Promise.all([adapter.tick(), adapter.tick(), adapter.tick()]);

		expect(spy).toHaveBeenCalledTimes(3);
		expect(maxActive).toBe(1);
	});

	it("skips overlapping pollSessions runs and summarizing agents", async () => {
		engine.addDeliverable({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "task" });
		const adapter = await startAdapter("work");
		const poll = () =>
			(adapter as unknown as { pollSessions(): Promise<void> }).pollSessions();

		// A hasSession that blocks until released, counting calls.
		let calls = 0;
		let release: ((alive: boolean) => void) | undefined;
		tmux.hasSessionImpl = () => {
			calls += 1;
			return new Promise<boolean>((resolve) => {
				release = resolve;
			});
		};

		const first = poll();
		const second = poll();
		await second; // returns immediately: a run is already in flight
		expect(calls).toBe(1);
		release!(true); // session alive — nothing to do
		await first;
		expect(calls).toBe(1);

		// Summarizing agents are being torn down deliberately — not polled.
		calls = 0;
		const worker = adapter.getExecutor().getAgentState("work", "worker")!;
		worker.status = "summarizing";
		await poll();
		expect(calls).toBe(0);

		// Restore a benign stub so destroy() does not hang on hasSession.
		worker.status = "working";
		tmux.hasSessionImpl = async () => false;
	});
});

describe("crash-cap fail fires once", () => {
	let tmpDir: string;
	let engine: PlanEngine;
	let tmux: ReturnType<typeof stubTmux>;
	let adapter: ExecutionAdapter | undefined;
	let prevSessionDir: string | undefined;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-failspam-"));
		prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpDir, "sessions");
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(tmpDir, "empty-agent");
		engine = PlanEngine.create(memStore(), {
			slug: "failspam",
			title: "Failspam",
			repoPath: tmpDir,
		});
		tmux = stubTmux();
	});

	afterEach(async () => {
		await adapter?.destroy();
		adapter = undefined;
		if (prevSessionDir === undefined)
			delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDir;
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("a crash-capped worker fails ONCE — later polls skip it", async () => {
		// The radicalai run logged ~30 identical failed events at 5s cadence:
		// the poll's skip-list did not include status "failed", so the same
		// dead session re-failed/re-blocked/re-carded forever.
		engine.addDeliverable({ title: "Doc", workerMode: "full" });
		engine.addWorkItem("doc", { title: "write docs" });
		engine.setDeliverableStatus("doc", "active");
		engine.updateDeliverable("doc", { worktreePath: tmpDir });
		adapter = new ExecutionAdapter({
			engine,
			ctx: { cwd: tmpDir } as ExtensionContext,
			extensionPath: "/nonexistent/ext",
			defaultBranch: "main",
			planDir: join(tmpDir, "plan"),
			tmux,
			token: TOKEN,
			socketPath: join(tmpDir, "maestro.sock"),
			onPlanChanged: () => {},
		});
		await adapter.start();
		adapter.getExecutor().unblockDeliverable("doc");
		await adapter.tick();
		const executor = adapter.getExecutor();
		expect(executor.getAgentState("doc", "worker")!.status).toBe("working");

		// Session is gone and the respawn budget is spent.
		tmux.hasSessionImpl = async () => false;
		(adapter as unknown as { respawnCount: Map<string, number> }).respawnCount =
			new Map([["doc/worker", 2]]);
		const poll = () =>
			(adapter as unknown as { pollSessions(): Promise<void> }).pollSessions();

		await poll();
		expect(executor.getAgentState("doc", "worker")!.status).toBe("failed");
		await poll();
		await poll();

		const events = readFileSync(join(tmpDir, "plan", "events.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { event: string });
		expect(events.filter((e) => e.event === "failed")).toHaveLength(1);
	});
});
