// Debug/recovery primitives over the v2 stack: the atomic plan repair
// (PlanEngineV2.applyTaskRepair, v1 semantics — fingerprint-pinned via
// planFingerprintV2, stopped-assertion, terminal/restarting guards, the
// narrow four-operation vocabulary, repairAudit provenance), safe worker
// restart through NodeExecutionAdapter.restartWorker, the cooperative fleet
// stop, and read-only restart workspace validation over the v2 tree.
//
// Ported from the v1 restart-primitives suite. Behavior that died with v1's
// ExecutionAdapter (dropped here, not weakened):
// - the deterministic "# Fresh-session recovery" fact assembly and the
//   previousSessionPaths history write on fresh restarts: v2's replaceWorker
//   takes a caller-supplied recoverySeed and writes no session history.
// - the execution-stop.json artifact with per-agent recovery hints and the
//   idempotent bounded-deadline escalation: v2 prepareStop is a cooperative
//   RPC barrier that freezes ticks and parks agents /recover-able.
// - the proof-of-death gate ("old tmux session did not exit" blocking the
//   respawn) and the restart-window RPC barrier (stale-connection detach +
//   stale-mutation gating): v2 defers restart barriers to periphery
//   (packages/modes/src/plan/node-adapter.ts header).
// - stale-generation completion guarding survives in NodeExecutor and is
//   pinned in test/node-executor.test.ts; not duplicated here.

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateRestartWorkspace } from "../packages/modes/src/exec/workspace-validation.js";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import { NodeExecutionAdapter } from "../packages/modes/src/plan/node-adapter.js";
import type { SpawnNodeOpts } from "../packages/modes/src/plan/node-executor.js";
import {
	findNodeV2,
	gatingNodeTasks,
	type PlanNode,
	type PlanV2,
	planFingerprintV2,
} from "../packages/modes/src/plan/schema.js";
import type { PlanStoreV2 } from "../packages/modes/src/plan/storage.js";

function memStore(): PlanStoreV2 {
	let saved: PlanV2 | null = null;
	return {
		root: "/tmp/plans",
		save(plan) {
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

describe("atomic plan repair (applyTaskRepair)", () => {
	function repairEngine(): PlanEngineV2 {
		const engine = PlanEngineV2.create(memStore(), {
			slug: "repair",
			title: "Repair",
			repoPath: "/tmp/repo",
		});
		engine.addNode(null, {
			id: "auth",
			agent: "worker",
			persona: "coder",
			title: "Auth",
			tasks: ["done task", "remaining task"],
		});
		engine.toggleTask("auth", "done-task");
		engine.setNodeStatus("auth", "active");
		return engine;
	}

	it("applies the full operation vocabulary in one write and appends the audit", () => {
		const engine = repairEngine();
		const base = planFingerprintV2(engine.get());
		const result = engine.applyTaskRepair({
			baseFingerprint: base,
			reason: "clarify remaining work after a wedged worker",
			operations: [
				{
					type: "addCorrectiveTask",
					deliverableId: "auth",
					task: { id: "fix-timeout", title: "Fix the timeout" },
				},
				{
					type: "addManualCheckpoint",
					deliverableId: "auth",
					task: { id: "verify-manually", title: "Verify by hand" },
				},
				{
					type: "clarifyTask",
					deliverableId: "auth",
					taskId: "remaining-task",
					body: "use the retry helper",
				},
				{ type: "reopenTask", deliverableId: "auth", taskId: "done-task" },
			],
			stoppedDeliverableIds: ["auth"],
		});

		const node = findNodeV2(engine.get(), "auth");
		// Corrective tasks gate completion; manual checkpoints do not.
		const gatingIds = gatingNodeTasks(node ?? { tasks: [] }).map((t) => t.id);
		expect(gatingIds).toContain("fix-timeout");
		expect(gatingIds).not.toContain("verify-manually");
		expect(node?.tasks.find((t) => t.id === "verify-manually")?.kind).toBe(
			"manual",
		);
		expect(node?.tasks.find((t) => t.id === "remaining-task")?.body).toBe(
			"use the retry helper",
		);
		expect(node?.tasks.find((t) => t.id === "done-task")?.done).toBe(false);

		expect(engine.get().repairAudit).toHaveLength(1);
		expect(engine.get().repairAudit?.[0]).toMatchObject({
			id: result.auditId,
			reason: "clarify remaining work after a wedged worker",
			baseFingerprint: base,
			appliedAt: expect.any(String),
			operations: [
				"addCorrectiveTask",
				"addManualCheckpoint",
				"clarifyTask",
				"reopenTask",
			],
		});
		expect(result.fingerprint).not.toBe(base);
		expect(result.fingerprint).toBe(planFingerprintV2(engine.get()));
	});

	it("rejects fingerprint drift, unstopped targets, terminal and restarting nodes", () => {
		const engine = PlanEngineV2.create(memStore(), {
			slug: "repair-guards",
			title: "Repair Guards",
			repoPath: "/tmp/repo",
		});
		engine.addNode(null, {
			id: "auth",
			agent: "worker",
			persona: "coder",
			title: "Auth",
			tasks: ["done task", "remaining task"],
		});
		engine.addNode(null, {
			id: "old",
			agent: "worker",
			persona: "coder",
			title: "Old",
		});
		engine.toggleTask("auth", "done-task");
		engine.setNodeStatus("auth", "active");
		engine.setNodeStatus("old", "active");
		engine.setNodeStatus("old", "complete");
		engine.setNodeStatus("old", "shipped");

		const op = (deliverableId: string) =>
			({
				type: "reopenTask",
				deliverableId,
				taskId: "done-task",
			}) as const;

		expect(() =>
			engine.applyTaskRepair({
				baseFingerprint: "stale",
				reason: "r",
				operations: [op("auth")],
				stoppedDeliverableIds: ["auth"],
			}),
		).toThrow(/fingerprint drift/);

		expect(() =>
			engine.applyTaskRepair({
				baseFingerprint: planFingerprintV2(engine.get()),
				reason: "r",
				operations: [op("auth")],
				stoppedDeliverableIds: [],
			}),
		).toThrow(/not confirmed stopped/);

		expect(() =>
			engine.applyTaskRepair({
				baseFingerprint: planFingerprintV2(engine.get()),
				reason: "r",
				operations: [op("old")],
				stoppedDeliverableIds: ["old"],
			}),
		).toThrow(/terminal \(shipped\)/);

		engine.setNodeRuntime("auth", { restartState: "restarting" });
		expect(() =>
			engine.applyTaskRepair({
				baseFingerprint: planFingerprintV2(engine.get()),
				reason: "r",
				operations: [op("auth")],
				stoppedDeliverableIds: ["auth"],
			}),
		).toThrow(/is restarting/);
	});

	it("cannot reopen decided or clarify acted-upon tasks; a failing op aborts atomically", () => {
		const engine = repairEngine();
		engine.updateTask("auth", "remaining-task", { answer: "chose option b" });
		const fingerprint = () => planFingerprintV2(engine.get());

		expect(() =>
			engine.applyTaskRepair({
				baseFingerprint: fingerprint(),
				reason: "r",
				operations: [
					{
						type: "reopenTask",
						deliverableId: "auth",
						taskId: "remaining-task",
					},
				],
				stoppedDeliverableIds: ["auth"],
			}),
		).toThrow(/cannot reopen decided/);

		expect(() =>
			engine.applyTaskRepair({
				baseFingerprint: fingerprint(),
				reason: "r",
				operations: [
					{
						type: "clarifyTask",
						deliverableId: "auth",
						taskId: "done-task",
						body: "clearer",
					},
				],
				stoppedDeliverableIds: ["auth"],
			}),
		).toThrow(/already acted upon/);

		// Atomicity: the valid first operation must not land when a later one fails.
		const before = fingerprint();
		expect(() =>
			engine.applyTaskRepair({
				baseFingerprint: before,
				reason: "r",
				operations: [
					{
						type: "addCorrectiveTask",
						deliverableId: "auth",
						task: { id: "half-applied", title: "Half applied" },
					},
					{
						type: "clarifyTask",
						deliverableId: "auth",
						taskId: "no-such-task",
						body: "x",
					},
				],
				stoppedDeliverableIds: ["auth"],
			}),
		).toThrow(/unknown task/);
		expect(
			findNodeV2(engine.get(), "auth")?.tasks.some(
				(t) => t.id === "half-applied",
			),
		).toBe(false);
		expect(engine.get().repairAudit).toBeUndefined();
		expect(fingerprint()).toBe(before);

		// Degenerate inputs fail closed.
		expect(() =>
			engine.applyTaskRepair({
				baseFingerprint: fingerprint(),
				reason: "  ",
				operations: [
					{ type: "reopenTask", deliverableId: "auth", taskId: "done-task" },
				],
				stoppedDeliverableIds: ["auth"],
			}),
		).toThrow(/reason required/);
		expect(() =>
			engine.applyTaskRepair({
				baseFingerprint: fingerprint(),
				reason: "r",
				operations: [],
				stoppedDeliverableIds: [],
			}),
		).toThrow(/no operations/);
	});
});

describe("safe worker restart primitives (v2 adapter)", () => {
	const cleanups: string[] = [];
	let adapter: NodeExecutionAdapter | undefined;

	afterEach(async () => {
		await adapter?.destroy();
		adapter = undefined;
		for (const dir of cleanups.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	async function started() {
		const root = mkdtempSync(join(tmpdir(), "restart-worker-"));
		cleanups.push(root);
		const workspace = join(root, "worktree");
		mkdirSync(workspace);
		writeFileSync(join(workspace, "dirty.txt"), "keep me");

		const engine = PlanEngineV2.create(memStore(), {
			slug: "restart",
			title: "Restart",
			repoPath: root,
		});
		engine.addNode(null, {
			id: "auth",
			agent: "worker",
			persona: "coder",
			title: "Auth",
			branch: "feat/auth",
			tasks: [
				{ title: "Done task", body: "already done" },
				{ title: "Remaining task", body: "continue it" },
			],
		});
		engine.toggleTask("auth", "done-task");

		const live = new Set<string>();
		const spawns: SpawnNodeOpts[] = [];
		let sessionSeq = 0;
		let failNextSpawn = false;
		const tmux = {
			live,
			async spawn(name: string) {
				live.add(name);
			},
			async hasSession(name: string) {
				return live.has(name);
			},
			async kill(name: string) {
				live.delete(name);
			},
		};
		adapter = new NodeExecutionAdapter({
			engine,
			planDir: join(root, "plan"),
			tmux,
			token: "test-token",
			socketPath: join(root, "rpc.sock"),
			defaultBranch: "main",
			pollIntervalMs: 60_000,
			onPlanChanged: () => {},
			spawnAgent: async (opts) => {
				if (failNextSpawn) throw new Error("spawn backend down");
				spawns.push(opts);
				sessionSeq++;
				const sessionId = `sess-auth-${sessionSeq}`;
				live.add(sessionId);
				return {
					sessionId,
					sessionFile:
						opts.resumeSessionFile ?? join(root, `sess-${sessionSeq}.jsonl`),
				};
			},
			createWorktree: async () => workspace,
			shipNode: async () => "https://example/pr/1",
		});
		await adapter.start();
		await adapter.tick(); // activates auth: workspace pinned, worker spawned
		return {
			root,
			workspace,
			engine,
			tmux,
			spawns,
			setFailSpawn: (value: boolean) => {
				failNextSpawn = value;
			},
		};
	}

	it("resume replaces the process but retains the JSONL and dirty work", async () => {
		const { workspace, engine, tmux, spawns } = await started();
		const node = () => findNodeV2(engine.get(), "auth");
		const before = node()?.sessionPath;
		const oldSession = node()?.sessionName as string;
		expect(before).toBeDefined();
		expect(tmux.live.has(oldSession)).toBe(true);

		const result = await adapter!.restartWorker("auth", "resume");
		expect(result.ok, result.error).toBe(true);
		expect(result.generation).toBe(1);
		expect(node()?.sessionGeneration).toBe(1);
		// Same JSONL: the replacement resumed the persisted transcript.
		expect(spawns.at(-1)).toMatchObject({
			nodeId: "auth",
			resumeSessionFile: before,
		});
		expect(node()?.sessionPath).toBe(before);
		// The old process is gone; dirty uncommitted work is untouched.
		expect(tmux.live.has(oldSession)).toBe(false);
		expect(readFileSync(join(workspace, "dirty.txt"), "utf8")).toBe("keep me");
	});

	it("fresh spawns a new JSONL from the caller-supplied recovery seed", async () => {
		const { workspace, engine, spawns } = await started();
		const before = findNodeV2(engine.get(), "auth")?.sessionPath as string;

		const result = await adapter!.restartWorker(
			"auth",
			"fresh",
			"# Recovery seed\nWorkspace facts assembled by the caller.",
		);
		expect(result.ok, result.error).toBe(true);
		const spawn = spawns.at(-1);
		expect(spawn?.resumeSessionFile).toBeUndefined();
		expect(spawn?.freshRecovery).toBe(true);
		expect(spawn?.seed).toBe(
			"# Recovery seed\nWorkspace facts assembled by the caller.",
		);
		expect(spawn?.kickoffMessage).toContain("fresh-session recovery seed");
		expect(findNodeV2(engine.get(), "auth")?.sessionPath).not.toBe(before);
		expect(readFileSync(join(workspace, "dirty.txt"), "utf8")).toBe("keep me");
	});

	it("leaves a failed restart retryable instead of wedged", async () => {
		const { engine, setFailSpawn } = await started();
		setFailSpawn(true);
		const failed = await adapter!.restartWorker("auth", "resume");
		expect(failed.ok).toBe(false);
		expect(failed.error).toContain("spawn backend down");
		expect(failed.generation).toBe(1);

		// The wedge test: once the cause is fixed, the SAME node restarts.
		setFailSpawn(false);
		const retried = await adapter!.restartWorker("auth", "resume");
		expect(retried.ok, retried.error).toBe(true);
		expect(retried.generation).toBe(2);
		expect(adapter!.getExecutor().getRunState("auth")?.status).toBe("working");
		expect(findNodeV2(engine.get(), "auth")?.sessionGeneration).toBe(2);
	});

	it("prepareStop freezes scheduling and parks live agents /recover-able", async () => {
		const { root, tmux } = await started();
		const result = await adapter!.prepareStop("test shutdown");
		// No live RPC connection: the cooperative ask fails over to a kill.
		expect(result.stopped).toEqual([]);
		expect(result.unresponsive).toEqual(["auth"]);
		expect(tmux.live.size).toBe(0);
		const run = adapter!.getExecutor().getRunState("auth");
		expect(run?.status).toBe("pending");
		expect(run?.blocked).toContain("/recover");
		expect(readFileSync(join(root, "plan", "events.jsonl"), "utf8")).toContain(
			"prepare-stop",
		);
		// Scheduling is frozen after the barrier: ticks are no-ops.
		expect(await adapter!.tick()).toEqual([]);
	});
});

describe("restart workspace validation", () => {
	function planWithTwoClaims(alias = false): {
		plan: PlanV2;
		paths: Record<string, string>;
	} {
		const root = "/repo";
		const first = "/wt/one";
		const second = alias ? "/wt/alias" : "/wt/two";
		const now = "2026-01-01T00:00:00Z";
		const node = (id: string, path: string, branch: string): PlanNode => ({
			type: "node",
			id,
			agent: "worker",
			persona: "coder",
			title: id,
			body: "",
			status: "active",
			tasks: [
				{
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
			authoredBy: "plan",
			createdAt: now,
			updatedAt: now,
		});
		return {
			plan: {
				schemaVersion: 6,
				slug: "p",
				title: "p",
				repoPath: root,
				nodes: [
					node("one", first, "feat/one"),
					node("two", second, "feat/two"),
				],
				createdAt: now,
				updatedAt: now,
			},
			paths: { root, first, second },
		};
	}

	it("reports a missing workspace as the only reprovisionable case", () => {
		const { plan } = planWithTwoClaims();
		const result = validateRestartWorkspace(plan, plan.nodes[0], {
			pathExists: () => false,
		});
		expect(result).toMatchObject({
			ok: true,
			missing: true,
			canReprovision: true,
		});
	});

	it("rejects realpath aliases claimed by another active node", () => {
		const { plan, paths } = planWithTwoClaims(true);
		const result = validateRestartWorkspace(plan, plan.nodes[0], {
			pathExists: () => true,
			realpath: (path) => (path === paths.second ? paths.first : path),
		});
		expect(result.error).toMatch(/also claimed/);
	});

	it("rejects duplicate active branch claims before touching Git", () => {
		const { plan, paths } = planWithTwoClaims();
		plan.nodes[1].branch = "feat/one";
		const result = validateRestartWorkspace(plan, plan.nodes[0], {
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
		const scratch = plan.nodes[0];
		// v2 scratch marker: a branchless node has no repo/branch ownership proof.
		scratch.branch = undefined;
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
		const mismatch = validateRestartWorkspace(plan, plan.nodes[0], {
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
