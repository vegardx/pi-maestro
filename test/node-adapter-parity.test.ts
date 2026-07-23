// PARITY TWINS (cutover PR-5b): lifecycle.e2e + dirty-completion.e2e replayed
// against the v2 stack — NodeExecutionAdapter + NodeExecutor + PlanEngineV2 —
// with a scripted worker speaking the REAL RPC protocol over a real socket and
// a stub tmux, exactly the v1 hermetic texture. This is the risk-R1 gate: the
// flip PR may not open unless these pass.
//
// Runs in the UNIT suite deliberately (not the e2e tier): the twins gate every
// push, not just e2e runs.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MaestroMessage, MaestroRpcClient } from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import { NodeExecutionAdapter } from "../packages/modes/src/plan/node-adapter.js";
import { findNodeV2 } from "../packages/modes/src/plan/schema.js";
import { createPlanStoreV2 } from "../packages/modes/src/plan/storage.js";

const TOKEN = "e2e-token";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function stubTmux() {
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
 * A scripted worker: a real RPC client playing the agent side of the
 * protocol, keyed by NODE ID (the v2 agent identity). Reflexively answers
 * ping/summarize; exposes toggle/status helpers — the exact wire sequence a
 * real worker performs.
 */
function scriptedWorker(socketPath: string, nodeId: string) {
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
		agentId: nodeId,
		role: "agent",
		token: TOKEN,
		pid: process.pid,
	});
	const ready = until(() =>
		received.some((m) => m.type === "helloAck" && m.ok),
	);
	return {
		client,
		received,
		ready,
		steers: () =>
			received.filter(
				(m): m is Extract<MaestroMessage, { type: "steer" }> =>
					m.type === "steer",
			),
		working: () => client.send({ type: "status", status: "working" }),
		idle: () => client.send({ type: "status", status: "idle" }),
		toggleTask(taskId: string, summary?: string) {
			client.send({
				type: "planMutate",
				id: `m${nextId++}`,
				action: "toggleTask",
				deliverableId: nodeId, // v6 wire field carries the node id
				params: { taskId, ...(summary ? { summary } : {}) },
			});
		},
		close: () => client.close(),
	};
}

let tmpDir: string;
let repoDir: string;
let planDir: string;
let socketPath: string;
let engine: PlanEngineV2;
let adapter: NodeExecutionAdapter;
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
	tasks?: string[];
}): Promise<void> {
	engine = PlanEngineV2.create(createPlanStoreV2(join(tmpDir, "plans")), {
		slug: "e2e",
		title: "E2E Plan",
		repoPath: repoDir,
	});
	engine.addNode(null, {
		agent: "worker",
		persona: "coder",
		title: "Ship the widget",
		branch: "feat/widget",
		tasks: opts?.tasks ?? ["build it", "test it"],
	});
	// Pre-provision as active so the executor hydrates without touching real
	// git worktree provisioning (v1 hermetic pattern): activation injects the
	// lifecycle pair, then the workspace is pinned to the seeded repo.
	engine.setNodeStatus("ship-the-widget", "active");
	engine.setNodeRuntime("ship-the-widget", { worktreePath: repoDir });

	adapter = new NodeExecutionAdapter({
		engine,
		planDir,
		launcher: stubTmux(),
		token: TOKEN,
		socketPath,
		defaultBranch: "main",
		onPlanChanged: () => {},
		...opts,
	});
	await adapter.start();
	// Hydrated actives come up blocked (restart safety); clear and tick.
	adapter.getExecutor().unblockNode("ship-the-widget");
	// Hydration lost the in-memory worktree pin? No — it reads the ledger.
	await adapter.tick();
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "v2-twin-"));
	repoDir = join(tmpDir, "repo");
	planDir = join(tmpDir, "plan");
	socketPath = join(tmpDir, "maestro.sock");
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
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("parity twin: lifecycle over the real RPC protocol", () => {
	it("spawns, injects the lifecycle pair, completes on toggles, ships", async () => {
		let shippedBranch: string | undefined;
		await boot();
		// Re-wire ship AFTER boot via a fresh adapter would lose state; instead
		// the default shipNode throws — so rebuild with a recording shipper.
		await adapter.destroy();
		adapter = new NodeExecutionAdapter({
			engine,
			planDir,
			launcher: stubTmux(),
			token: TOKEN,
			socketPath,
			defaultBranch: "main",
			onPlanChanged: () => {},
			shipNode: async (opts) => {
				shippedBranch = opts.branch;
				return "https://example/pr/1";
			},
		});
		await adapter.start();
		adapter.getExecutor().unblockNode("ship-the-widget");
		await adapter.tick();

		// The node's worker spawned (stub tmux) with its ledger fields set.
		const node = findNodeV2(engine.get(), "ship-the-widget");
		expect(node?.status).toBe("active");
		// Lifecycle injection: postflight present (branch owner), no preflight
		// (no sibling deps) — the v1 rule generalized.
		expect(node?.tasks.map((t) => t.kind ?? "task")).toEqual([
			"task",
			"task",
			"postflight",
		]);

		const worker = scriptedWorker(socketPath, "ship-the-widget");
		workers.push(worker);
		await worker.ready;

		worker.working();
		worker.toggleTask("build-it");
		worker.toggleTask("test-it");
		worker.toggleTask(
			"lifecycle-postflight",
			"## Handoff\nWidget built; API `ship()`.",
		);
		worker.idle();

		await until(
			() => findNodeV2(engine.get(), "ship-the-widget")?.status === "shipped",
		);
		const shipped = findNodeV2(engine.get(), "ship-the-widget");
		// The postflight handoff persisted onto the LEDGER (v2's upgrade).
		expect(shipped?.handoff).toContain("Widget built");
		expect(shipped?.summary).toContain("done.");
		expect(shipped?.prUrl).toBe("https://example/pr/1");
		expect(shippedBranch).toBe("feat/widget");
		expect(events()).toContain('"shipped"');
	});

	it("rejects a worker mutating another node (auth rule re-keyed)", async () => {
		await boot();
		const worker = scriptedWorker(socketPath, "ship-the-widget");
		workers.push(worker);
		await worker.ready;
		worker.client.send({
			type: "planMutate",
			id: "mx",
			action: "toggleTask",
			deliverableId: "some-other-node",
			params: { taskId: "build-it" },
		});
		await until(() =>
			worker.received.some(
				(m) =>
					m.type === "planMutateResult" &&
					m.success === false &&
					(m.error ?? "").includes("their own node"),
			),
		);
		expect(findNodeV2(engine.get(), "ship-the-widget")?.tasks[0].done).toBe(
			false,
		);
	});
});

describe("parity twin: dirty-worktree completion hold", () => {
	it("holds completion while dirty, steers to commit, completes once clean", async () => {
		await boot({ tasks: ["build it"] });
		const worker = scriptedWorker(socketPath, "ship-the-widget");
		workers.push(worker);
		await worker.ready;

		// Worker "writes code" but does not commit, then finishes its tasks.
		writeFileSync(join(repoDir, "widget.ts"), "export const widget = 1;\n");
		worker.working();
		worker.toggleTask("build-it");
		worker.toggleTask("lifecycle-postflight");
		worker.idle();

		const status = () =>
			adapter.getExecutor().getRunState("ship-the-widget")?.status;

		await until(() =>
			worker.steers().some((s) => s.content.includes("uncommitted changes")),
		);
		expect(status()).not.toBe("done");
		expect(events()).toContain('"completion-held"');

		// Worker complies; the next idle observation releases the hold and the
		// full completion path (summarize → done) runs.
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "widget");
		worker.idle();
		await until(() => status() === "done");
		expect(events()).toContain('"completion-hold-released"');
	});

	it("escalates to failed agent + blocked node after the steer budget", async () => {
		await boot({
			tasks: ["build it"],
			dirtyHoldResteerMs: 30,
			dirtyHoldMaxSteers: 2,
		});
		const worker = scriptedWorker(socketPath, "ship-the-widget");
		workers.push(worker);
		await worker.ready;

		writeFileSync(join(repoDir, "widget.ts"), "export const widget = 1;\n");
		worker.working();
		worker.toggleTask("build-it");
		worker.toggleTask("lifecycle-postflight");

		// The worker ignores every reminder, idling past the cadence budget.
		const kick = setInterval(() => worker.idle(), 20);
		try {
			await until(() => events().includes('"completion-hold-escalated"'), 8000);
		} finally {
			clearInterval(kick);
		}
		const run = adapter.getExecutor().getRunState("ship-the-widget");
		expect(run?.status).toBe("failed");
		expect(run?.blocked).toContain("uncommitted changes");
		expect(run?.blocked).toContain("/recover");
		expect(worker.steers().length).toBeGreaterThanOrEqual(2);
	});
});
