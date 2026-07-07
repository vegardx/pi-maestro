// Adapter lifecycle correctness: idle-based completion for agents without a
// task-based done signal (read-only reviewers, zero-gating-task workers),
// tick serialization, and pollSessions overlap/summarizing guards — driven
// over a real RPC socket with a stub tmux, like observability.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
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
	const clients: MaestroRpcClient[] = [];

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
		prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpDir, "sessions");
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
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Start the adapter over a pre-provisioned active group (no git). */
	async function startAdapter(groupId: string): Promise<ExecutionAdapter> {
		engine.setGroupStatus(groupId, "active");
		engine.updateGroup(groupId, { worktreePath: tmpDir });
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
		// Hydrated active groups come up blocked (restart safety); unblock as
		// a user's /retry would so ticks may spawn agents.
		adapter.getExecutor().unblockGroup(groupId);
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
		engine.addGroup({ title: "Work", workerMode: "full" });
		engine.addWorkItem("work", { title: "implement it" });
		engine.addAgent("work", {
			name: "rev",
			mode: "read-only",
			slot: "alternate",
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

		// The second consecutive idle is: summarize → done → group complete.
		client.send({ type: "status", status: "idle" });
		await until(() => executor.getAgentState("work", "rev")!.status === "done");
		expect(executor.getAgentState("work", "rev")!.summary).toContain(
			"VERDICT: approve",
		);
		await until(() => engine.get().groups[0].status === "complete");
	});

	it("completes a zero-gating-task worker via consecutive idles", async () => {
		// Read-only workers may activate with no gating tasks; "all toggled"
		// is vacuously true, so idling is the only completion signal.
		engine.addGroup({ title: "Zero", workerMode: "read-only" });
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
		await until(() => engine.get().groups[0].status === "complete");
	});

	it("serializes overlapping tick calls through the mutex", async () => {
		engine.addGroup({ title: "Work", workerMode: "full" });
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
		engine.addGroup({ title: "Work", workerMode: "full" });
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
