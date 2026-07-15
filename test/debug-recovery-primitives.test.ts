import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MaestroRpcClient } from "@vegardx/pi-rpc";
import { afterEach, describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	ExecutionAdapter,
	type TmuxApi,
} from "../packages/modes/src/exec/execution-adapter.js";
import { validateRestartWorkspace } from "../packages/modes/src/exec/workspace-validation.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

function memStore(): PlanStore {
	let saved: Plan | null = null;
	return {
		root: "/tmp/plans",
		save(plan) {
			saved = plan;
		},
		load: () => saved,
		exists: () => saved !== null,
		remove: () => {
			saved = null;
		},
		list: () => [],
	};
}

class RestartTmux implements TmuxApi {
	readonly spawned: Array<{
		name: string;
		cwd: string;
		command: string | string[];
	}> = [];
	readonly live = new Set<string>();
	sticky = false;

	async spawn(
		name: string,
		cwd: string,
		command: string | string[],
	): Promise<void> {
		this.spawned.push({ name, cwd, command });
		this.live.add(name);
	}
	async hasSession(name: string): Promise<boolean> {
		return this.live.has(name);
	}
	async kill(name: string): Promise<void> {
		if (!this.sticky) this.live.delete(name);
	}
}

async function until(
	condition: () => boolean,
	what: string,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
}

function sessionSeed(path: string): string {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.find((line) => line.customType === "maestro.execution.seed")
		?.content as string;
}

describe("safe worker restart primitives", () => {
	const cleanups: string[] = [];
	const clients: MaestroRpcClient[] = [];
	let adapter: ExecutionAdapter | undefined;

	afterEach(async () => {
		for (const client of clients.splice(0)) client.close();
		await adapter?.destroy();
		adapter = undefined;
		for (const dir of cleanups.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	async function connectWorker(socketPath: string): Promise<MaestroRpcClient> {
		const client = new MaestroRpcClient({ reconnect: false });
		clients.push(client);
		const ack = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no helloAck")), 2000);
			client.once("message", (msg) => {
				clearTimeout(timer);
				if (msg.type === "helloAck" && msg.ok) resolve();
				else reject(new Error(`hello rejected: ${JSON.stringify(msg)}`));
			});
		});
		client.connect(socketPath, {
			agentId: "auth/worker",
			role: "agent",
			token: "test-token",
			pid: process.pid,
		});
		await ack;
		return client;
	}

	function activePlan() {
		const root = mkdtempSync(join(tmpdir(), "restart-worker-"));
		cleanups.push(root);
		const workspace = join(root, "worktree");
		mkdirSync(workspace);
		writeFileSync(join(workspace, "dirty.txt"), "keep me");
		const engine = PlanEngine.create(memStore(), {
			slug: "restart",
			title: "Restart",
			repoPath: root,
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		engine.addWorkItem("auth", { title: "Done task", body: "already done" });
		engine.addWorkItem("auth", {
			title: "Remaining task",
			body: "continue it",
		});
		engine.toggleWorkItem("auth", "done-task");
		engine.setDeliverableStatus("auth", "active");
		engine.updateDeliverable("auth", {
			worktreePath: workspace,
			branch: "feat/auth",
			summary: "Previous summary",
		});
		return { root, workspace, engine };
	}

	async function started(
		sticky = false,
		timing: { restartKillTimeoutMs?: number; restartPollMs?: number } = {},
	) {
		const { root, workspace, engine } = activePlan();
		const tmux = new RestartTmux();
		tmux.sticky = sticky;
		process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
		adapter = new ExecutionAdapter({
			engine,
			ctx: { cwd: root } as ExtensionContext,
			extensionPath: "/missing/ext",
			defaultBranch: "main",
			planDir: join(root, "plan"),
			tmux,
			token: "test-token",
			socketPath: join(root, "rpc.sock"),
			restartKillTimeoutMs: timing.restartKillTimeoutMs ?? 15,
			restartPollMs: timing.restartPollMs ?? 1,
			workspaceValidation: {
				pathExists: () => true,
				realpath: (path) => resolve(path),
				gitToplevel: () => resolve(workspace),
				currentBranch: () => "feat/auth",
				worktrees: () => [{ path: workspace, branch: "feat/auth" }],
			},
			resolveWorkerModel: async () => ({
				modelId: "test/worker",
				effort: "low",
			}),
			onPlanChanged: () => {},
		});
		await adapter.start();
		adapter.getExecutor().unblockDeliverable("auth");
		await adapter.tick();
		return { root, workspace, engine, tmux };
	}

	it("resume replaces the process but retains JSONL and dirty work", async () => {
		const { workspace, engine, tmux } = await started();
		const before = engine.get().deliverables[0].sessionPath;
		const oldName = engine.get().deliverables[0].sessionName!;
		expect(tmux.live.has(oldName)).toBe(true);

		const result = await adapter!.restartWorkerResume("auth");
		expect(result.ok).toBe(true);
		expect(result.generation).toBe(1);
		expect(engine.get().deliverables[0].sessionPath).toBe(before);
		expect(engine.get().deliverables[0].previousSessionPaths).toBeUndefined();
		expect(tmux.live.has(oldName)).toBe(false);
		expect(readFileSync(join(workspace, "dirty.txt"), "utf8")).toBe("keep me");
	});

	it("fresh allocates a new JSONL, records history, and writes deterministic recovery facts", async () => {
		const { workspace, engine } = await started();
		const before = engine.get().deliverables[0].sessionPath!;
		const result = await adapter!.restartWorkerFresh("auth");
		const current = engine.get().deliverables[0];
		expect(result.ok, result.error).toBe(true);
		expect(current.sessionPath).not.toBe(before);
		expect(current.previousSessionPaths).toContain(before);
		expect(readFileSync(join(workspace, "dirty.txt"), "utf8")).toBe("keep me");
		const seed = sessionSeed(current.sessionPath!);
		expect(seed).toContain("# Fresh-session recovery");
		expect(seed).toContain("Worker generation: 1");
		expect(seed).toContain(`Workspace: ${workspace}`);
		expect(seed).toContain("Done task");
		expect(seed).toContain("Remaining task");
		expect(seed).toContain("Previous summary");
		expect(seed).toContain("Do not create another worktree");
		expect(seed).toContain("Preserve all valid dirty/uncommitted changes");
	});

	it("blocks without spawning when the old tmux session cannot be proven absent", async () => {
		const { engine, tmux } = await started(true);
		const spawnCount = tmux.spawned.length;
		const result = await adapter!.restartWorkerFresh("auth");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/did not exit/);
		expect(tmux.spawned).toHaveLength(spawnCount);
		expect(engine.get().deliverables[0].restartState).toBe("blocked");
	});

	it("leaves a failed restart retryable instead of wedged in restarting", async () => {
		const { tmux } = await started(true);
		const failed = await adapter!.restartWorkerFresh("auth");
		expect(failed.ok).toBe(false);
		const executor = adapter!.getExecutor();
		const worker = executor.getAgentState("auth", "worker")!;
		expect(worker.status).toBe("pending");
		expect(worker.sessionId).toBeUndefined();
		expect(worker.error).toMatch(/did not exit/);
		expect(executor.getStates().get("auth")?.blocked).toMatch(/did not exit/);

		// The wedge test: once the cause is fixed, the SAME deliverable restarts.
		tmux.sticky = false;
		const retried = await adapter!.restartWorkerFresh("auth");
		expect(retried.ok, retried.error).toBe(true);
		expect(executor.getAgentState("auth", "worker")?.status).toBe("working");
		expect(executor.getStates().get("auth")?.blocked).toBeUndefined();
	});

	it("detaches the old connection and ignores stale worker rpc during restart", async () => {
		const { root, engine } = await started(false, {
			restartKillTimeoutMs: 1500,
			restartPollMs: 10,
		});
		const stale = await connectWorker(join(root, "rpc.sock"));
		expect(stale.connected).toBe(true);

		// Parked in the graceful-shutdown window while the tmux session lives.
		const restart = adapter!.restartWorkerResume("auth");
		await until(() => !stale.connected, "old connection detach");

		// A reconnecting old generation passes hello but must not mutate state.
		const reconnected = await connectWorker(join(root, "rpc.sock"));
		reconnected.send({
			type: "planMutate",
			id: "m1",
			action: "toggleTask",
			deliverableId: "auth",
			params: { taskId: "remaining-task" },
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		const task = () =>
			engine.get().deliverables[0].tasks.find((t) => t.id === "remaining-task");
		expect(task()?.done).toBe(false);

		const result = await restart;
		expect(result.ok, result.error).toBe(true);
		// The gate is the restart barrier, not a permanent lockout.
		reconnected.send({
			type: "planMutate",
			id: "m2",
			action: "toggleTask",
			deliverableId: "auth",
			params: { taskId: "remaining-task" },
		});
		await until(() => task()?.done === true, "post-restart mutate");
	});

	it("ignores stale generation completion after replacement", async () => {
		const { engine } = await started();
		const worker = adapter!.getExecutor().getAgentState("auth", "worker")!;
		const stale = {
			generation: worker.generation ?? 0,
			sessionId: worker.sessionId,
		};
		await adapter!.restartWorkerResume("auth");
		await adapter!.getExecutor().markAgentDone("auth", "worker", stale);
		expect(adapter!.getExecutor().getAgentState("auth", "worker")?.status).toBe(
			"working",
		);
		expect(engine.get().deliverables[0].status).toBe("active");
	});
});

describe("restart workspace validation", () => {
	function planWithTwoClaims(alias = false): {
		plan: Plan;
		paths: Record<string, string>;
	} {
		const root = "/repo";
		const first = "/wt/one";
		const second = alias ? "/wt/alias" : "/wt/two";
		const now = "2026-01-01T00:00:00Z";
		const deliverable = (
			id: string,
			path: string,
			branch: string,
		): Plan["deliverables"][number] => ({
			type: "deliverable",
			id,
			title: id,
			body: "",
			status: "active",
			worker: { mode: "full" },
			agents: [],
			tasks: [
				{
					type: "work-item",
					id: "t",
					title: "t",
					body: "",
					done: false,
					createdAt: now,
					updatedAt: now,
				},
			],
			branch,
			worktreePath: path,
			createdAt: now,
			updatedAt: now,
		});
		return {
			plan: {
				slug: "p",
				title: "p",
				repoPath: root,
				deliverables: [
					deliverable("one", first, "feat/one"),
					deliverable("two", second, "feat/two"),
				],
				createdAt: now,
				updatedAt: now,
			},
			paths: { root, first, second },
		};
	}

	it("reports a missing workspace as the only reprovisionable case", () => {
		const { plan } = planWithTwoClaims();
		const result = validateRestartWorkspace(plan, plan.deliverables[0], {
			pathExists: () => false,
		});
		expect(result).toMatchObject({
			ok: true,
			missing: true,
			canReprovision: true,
		});
	});

	it("rejects realpath aliases claimed by another active deliverable", () => {
		const { plan, paths } = planWithTwoClaims(true);
		const result = validateRestartWorkspace(plan, plan.deliverables[0], {
			pathExists: () => true,
			realpath: (path) => (path === paths.second ? paths.first : path),
		});
		expect(result.error).toMatch(/also claimed/);
	});

	it("rejects duplicate active branch claims before touching Git", () => {
		const { plan, paths } = planWithTwoClaims();
		plan.deliverables[1].branch = "feat/one";
		const result = validateRestartWorkspace(plan, plan.deliverables[0], {
			pathExists: () => true,
			realpath: (path) => path,
			gitToplevel: () => paths.first,
			currentBranch: () => "feat/one",
			worktrees: () => [{ path: paths.first, branch: "feat/one" }],
		});
		expect(result.error).toMatch(/branch feat\/one is also claimed/);
	});

	it("pins scratch workspaces to the authoritative plan directory", () => {
		const { plan } = planWithTwoClaims();
		const scratch = plan.deliverables[0];
		scratch.workspace = "scratch";
		scratch.worktreePath = "/plans/p/workspaces/one";
		const deps = {
			pathExists: () => true,
			realpath: (path: string) => path,
		};

		const ok = validateRestartWorkspace(plan, scratch, deps, "/plans/p");
		expect(ok).toMatchObject({ ok: true, path: "/plans/p/workspaces/one" });

		scratch.worktreePath = "/elsewhere/one";
		const mismatch = validateRestartWorkspace(plan, scratch, deps, "/plans/p");
		expect(mismatch.ok).toBe(false);
		expect(mismatch.error).toMatch(/scratch workspace mismatch/);

		const noPlanDir = validateRestartWorkspace(plan, scratch, deps);
		expect(noPlanDir.ok).toBe(false);
		expect(noPlanDir.error).toMatch(/authoritative plan directory/);
	});

	it("rejects repository and branch mismatches with previewable errors", () => {
		const { plan, paths } = planWithTwoClaims();
		const mismatch = validateRestartWorkspace(plan, plan.deliverables[0], {
			pathExists: () => true,
			realpath: (path) => path,
			gitToplevel: () => paths.first,
			currentBranch: () => "wrong",
			worktrees: () => [{ path: paths.first, branch: "wrong" }],
		});
		expect(mismatch.ok).toBe(false);
		expect(mismatch.error).toMatch(/branch mismatch/);
	});
});
