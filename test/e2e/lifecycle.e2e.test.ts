// End-to-end lifecycle prototype: drives the REAL orchestrator
// (ExecutionAdapter + DeliverableExecutor + PlanEngine) through a deliverable's
// spawn -> work -> completion -> gate evaluation, over the REAL RPC protocol —
// with NO tmux, NO `pi`, NO API, NO git/gh. A scripted worker (a real
// MaestroRpcClient playing the agent side of protocol v6) stands in for a
// spawned pi worker; a stub tmux records the spawn instead of forking one.
//
// This is the automated, hermetic counterpart to manual dogfooding
// (dogfood-prompt.md). See docs/e2e-testing.md for how to author scenarios.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type MaestroMessage, MaestroRpcClient } from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanEngine } from "../../packages/modes/src/engine.js";
import {
	ExecutionAdapter,
	type TmuxApi,
} from "../../packages/modes/src/exec/execution-adapter.js";
import type { Plan } from "../../packages/modes/src/schema.js";
import type { PlanStore } from "../../packages/modes/src/storage.js";

const TOKEN = "e2e-token";

function memStore(): PlanStore {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save(plan: Plan) {
			saved = plan;
		},
		load: () => saved,
		exists: () => saved !== null,
		remove() {
			saved = null;
		},
		list: () => [],
	};
}

/** Stub tmux: records spawns; sessions never read "alive" (kill is a no-op). */
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

/**
 * A scripted worker: a real RPC client that plays the agent side. It reflexively
 * answers ping/summarize (so the maestro's completion summary resolves), and
 * exposes helpers to toggle tasks and report idle — the exact wire sequence a
 * real worker performs.
 */
function scriptedWorker(socketPath: string, agentId: string) {
	const client = new MaestroRpcClient({ reconnect: false });
	const received: MaestroMessage[] = [];
	let nextId = 1;
	client.on("message", (msg) => {
		received.push(msg);
		if (msg.type === "ping") client.send({ type: "pong", id: msg.id });
		if (msg.type === "summarize")
			client.send({
				type: "summary",
				id: msg.id,
				content: "## Summary\ndone.",
			});
	});
	client.connect(socketPath, {
		agentId,
		role: "agent",
		token: TOKEN,
		pid: process.pid,
	});
	const ready = until(() =>
		received.some((m) => m.type === "helloAck" && m.ok),
	);
	const deliverableId = agentId.split("/")[0];
	return {
		client,
		received,
		ready,
		working: () => client.send({ type: "status", status: "working" }),
		idle: () => client.send({ type: "status", status: "idle" }),
		toggleTask(taskId: string) {
			client.send({
				type: "planMutate",
				id: `m${nextId++}`,
				action: "toggleTask",
				deliverableId,
				params: { taskId },
			});
		},
		close: () => client.close(),
	};
}

describe("e2e: deliverable lifecycle over the real orchestrator", () => {
	let tmpDir: string;
	let planDir: string;
	let socketPath: string;
	let engine: PlanEngine;
	let adapter: ExecutionAdapter;
	let tmux: ReturnType<typeof stubTmux>;
	let prevSessionDir: string | undefined;
	const workers: { close: () => void }[] = [];

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "e2e-lifecycle-"));
		planDir = join(tmpDir, "plan");
		socketPath = join(tmpDir, "maestro.sock");
		prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpDir, "sessions");

		engine = PlanEngine.create(memStore(), {
			slug: "e2e",
			title: "E2E Plan",
			repoPath: tmpDir,
		});
		engine.addDeliverable({ title: "Ship the widget", workerMode: "full" });
		engine.addWorkItem("ship-the-widget", { title: "build it", kind: "task" });
		engine.addWorkItem("ship-the-widget", { title: "test it", kind: "task" });
		// Pre-provision as active so the executor hydrates + spawns the worker
		// without touching real git worktree provisioning.
		engine.setDeliverableStatus("ship-the-widget", "active");
		engine.updateDeliverable("ship-the-widget", { worktreePath: tmpDir });

		tmux = stubTmux();
		adapter = new ExecutionAdapter({
			engine,
			ctx: { cwd: tmpDir } as ExtensionContext,
			extensionPath: "/nonexistent/ext",
			defaultBranch: "main",
			planDir,
			tmux,
			token: TOKEN,
			socketPath,
			resolveWorkerModel: async (choice) => ({
				modelId: choice.model ?? "test/worker",
				effort: choice.effort ?? "low",
			}),
			onPlanChanged: () => {},
		});
		await adapter.start();
		// Hydrated active deliverables come up blocked (restart safety); clear it
		// so the tick spawns the worker.
		adapter.getExecutor().unblockDeliverable("ship-the-widget");
		await adapter.tick();
	});

	afterEach(async () => {
		for (const w of workers.splice(0)) w.close();
		await adapter.destroy();
		if (prevSessionDir === undefined)
			delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDir;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("spawns a worker and completes when all tasks toggle done", async () => {
		// The real adapter built a spawn spec and asked tmux to launch exactly one
		// worker session (tmux session names are generated display names; RPC
		// identity is the agentId the worker authenticates with below).
		expect(tmux.spawned).toHaveLength(1);

		const taskIds = engine
			.get()
			.deliverables[0].tasks.filter((t) => t.kind === "task")
			.map((t) => t.id);
		expect(taskIds).toEqual(["build-it", "test-it"]);

		const worker = scriptedWorker(socketPath, "ship-the-widget/worker");
		workers.push(worker);
		await worker.ready;

		worker.working();
		for (const id of taskIds) worker.toggleTask(id);
		// Toggling the final task only arms completion; the worker signals its
		// turn ended by reporting idle.
		worker.idle();

		// The real completion gate (checkCompletionGate -> workerMayComplete)
		// runs and finishes the worker.
		await until(() => adapter.isWorkerDone("ship-the-widget"));

		// Every gating task is done on the real plan...
		const tasks = engine
			.get()
			.deliverables[0].tasks.filter((t) => t.kind === "task");
		expect(tasks.every((t) => t.done)).toBe(true);
		// No maestro ship gate: the worker owns its findings and the deliverable
		// is free to ship once complete (trust-the-worker model).
	});
});
