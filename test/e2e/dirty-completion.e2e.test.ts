// Dirty-worktree completion hold, hermetically: a worker that finishes all
// gating tasks but leaves uncommitted changes must NOT complete silently.
// The gate steers it to commit on a cadence, logs every hold transition to
// events.jsonl, and — when the reminder budget is exhausted — escalates to a
// visible failed agent + blocked deliverable instead of wedging the run
// (drive 2, 2026-07-18: both live workers held for hours with zero signal).
//
// Same scaffolding as lifecycle.e2e.test.ts, except worktreePath is a REAL
// git repo so workingTreeClean() sees actual dirt.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function stubTmux(): TmuxApi {
	return {
		async spawn() {},
		async hasSession() {
			return false;
		},
		async kill() {},
	};
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
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

function scriptedWorker(socketPath: string, agentId: string) {
	const client = new MaestroRpcClient({ reconnect: false });
	const received: MaestroMessage[] = [];
	let nextId = 1;
	client.on("message", (msg) => {
		received.push(msg);
		if (msg.type === "ping") client.send({ type: "pong", id: msg.id });
		if (msg.type === "summarize")
			client.send({ type: "summary", id: msg.id, content: "## Summary\nok." });
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
		steers: () =>
			received.filter(
				(m): m is Extract<MaestroMessage, { type: "steer" }> =>
					m.type === "steer",
			),
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

describe("e2e: dirty-worktree completion hold", () => {
	let tmpDir: string;
	let repoDir: string;
	let planDir: string;
	let socketPath: string;
	let engine: PlanEngine;
	let adapter: ExecutionAdapter;
	let prevSessionDir: string | undefined;
	const workers: { close: () => void }[] = [];

	function events(): string {
		try {
			return readFileSync(join(planDir, "events.jsonl"), "utf-8");
		} catch {
			return "";
		}
	}

	async function boot(opts?: {
		dirtyHoldResteerMs?: number;
		dirtyHoldMaxSteers?: number;
	}): Promise<void> {
		engine = PlanEngine.create(memStore(), {
			slug: "e2e",
			title: "E2E Plan",
			repoPath: repoDir,
		});
		engine.addDeliverable({ title: "Ship the widget", workerMode: "full" });
		engine.addWorkItem("ship-the-widget", { title: "build it", kind: "task" });
		engine.setDeliverableStatus("ship-the-widget", "active");
		engine.updateDeliverable("ship-the-widget", { worktreePath: repoDir });

		adapter = new ExecutionAdapter({
			engine,
			ctx: { cwd: repoDir } as ExtensionContext,
			extensionPath: "/nonexistent/ext",
			defaultBranch: "main",
			planDir,
			tmux: stubTmux(),
			token: TOKEN,
			socketPath,
			resolveWorkerModel: async (choice) => ({
				modelId: choice.model ?? "test/worker",
				effort: choice.effort ?? "low",
			}),
			onPlanChanged: () => {},
			...opts,
		});
		await adapter.start();
		adapter.getExecutor().unblockDeliverable("ship-the-widget");
		await adapter.tick();
	}

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "e2e-dirty-"));
		repoDir = join(tmpDir, "repo");
		planDir = join(tmpDir, "plan");
		socketPath = join(tmpDir, "maestro.sock");
		prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpDir, "sessions");

		git(tmpDir, "init", "-q", "repo");
		git(repoDir, "config", "user.email", "e2e@test");
		git(repoDir, "config", "user.name", "e2e");
		writeFileSync(join(repoDir, "README.md"), "seed\n");
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "seed");
	});

	afterEach(async () => {
		for (const w of workers.splice(0)) w.close();
		await adapter.destroy();
		if (prevSessionDir === undefined)
			delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDir;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("holds completion while dirty, steers to commit, completes once clean", async () => {
		await boot();
		const worker = scriptedWorker(socketPath, "ship-the-widget/worker");
		workers.push(worker);
		await worker.ready;

		// Worker "writes code" but does not commit, then finishes its tasks.
		writeFileSync(join(repoDir, "widget.ts"), "export const widget = 1;\n");
		worker.toggleTask("build-it");
		worker.toggleTask("lifecycle-postflight");
		worker.idle();

		const workerStatus = () =>
			adapter
				.getExecutor()
				.getStates()
				.get("ship-the-widget")
				?.agents.get("worker")?.status;

		// The gate refuses and steers the worker to commit — visibly.
		await until(() =>
			worker.steers().some((s) => s.content.includes("uncommitted changes")),
		);
		expect(workerStatus()).not.toBe("done");
		expect(events()).toContain('"completion-held"');

		// Worker complies; the next idle observation releases the hold and the
		// full completion path (summarize -> done) runs.
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "widget");
		worker.idle();
		await until(() => workerStatus() === "done");
		expect(events()).toContain('"completion-hold-released"');
	});

	it("escalates to failed agent + blocked deliverable after the steer budget", async () => {
		await boot({ dirtyHoldResteerMs: 30, dirtyHoldMaxSteers: 2 });
		const worker = scriptedWorker(socketPath, "ship-the-widget/worker");
		workers.push(worker);
		await worker.ready;

		writeFileSync(join(repoDir, "widget.ts"), "export const widget = 1;\n");
		worker.toggleTask("build-it");
		worker.toggleTask("lifecycle-postflight");

		// The worker ignores every reminder: keep reporting idle past the
		// cadence until both steers have fired and the escalation lands.
		await until(() => {
			worker.idle();
			return (
				adapter.getExecutor().getStates().get("ship-the-widget")?.blocked !==
				undefined
			);
		}, 8000);

		expect(worker.steers().length).toBe(2);
		const state = adapter.getExecutor().getStates().get("ship-the-widget");
		expect(state?.blocked).toContain("uncommitted changes");
		expect(state?.blocked).toContain("/recover ship-the-widget");
		expect(state?.agents.get("worker")?.status).toBe("failed");
		const log = events();
		expect(log).toContain('"completion-held"');
		expect(log).toContain('"completion-hold-escalated"');
	});
});
