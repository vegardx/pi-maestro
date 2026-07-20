// Pre-flip hardening twins (cutover PR-6b): the seams PR-6 built now WIRED
// and driven over real RPC — real-git worktree provisioning through the full
// activation path (no pre-provisioned shortcuts), stacked chains, contract
// collection onto the ledger, child folding, and spawn-time resolution
// records. This is the coverage that makes the flip re-keying, not
// first-time wiring.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MaestroMessage, MaestroRpcClient } from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import { NodeExecutionAdapter } from "../packages/modes/src/plan/node-adapter.js";
import { findNodeV2 } from "../packages/modes/src/plan/schema.js";
import { createPlanStoreV2 } from "../packages/modes/src/plan/storage.js";

const TOKEN = "e2e-token";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function stubTmux() {
	return {
		async spawn() {},
		async hasSession() {
			return true; // sessions are "alive" — the RPC clients are the agents
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

const CONTRACT_BLOCKS: Record<string, string> = {
	"summary-and-diff":
		'Work is done.\n\n```pi-contract\n{ "contract": "summary-and-diff", "v": 1, "status": "complete", "payload": { "summary": "built it", "outcome": "done", "tasks": [] } }\n```',
	findings:
		'Clean review.\n\n```pi-contract\n{ "contract": "findings", "v": 1, "status": "complete", "payload": { "findings": [], "scope": { "reviewed": "the diff" }, "summary": "checked and sound" } }\n```',
};

/**
 * Scripted agent: answers the FIRST summarize with a prose summary and any
 * summarize whose preamble carries the contract instruction with the typed
 * block — the two-request completion path (summary, then collection).
 */
function scriptedAgent(socketPath: string, nodeId: string, block?: string) {
	const client = new MaestroRpcClient({ reconnect: false });
	const received: MaestroMessage[] = [];
	let nextId = 1;
	client.on("message", (msg) => {
		received.push(msg);
		if (msg.type === "ping") client.send({ type: "pong", id: msg.id });
		if (msg.type === "summarize") {
			const wantsContract = msg.preamble?.includes("pi-contract");
			client.send({
				type: "summary",
				id: msg.id,
				content: wantsContract && block ? block : `## Summary\n${nodeId} done.`,
			});
		}
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
		working: () => client.send({ type: "status", status: "working" }),
		idle: () => client.send({ type: "status", status: "idle" }),
		toggleTask(taskId: string, summary?: string) {
			client.send({
				type: "planMutate",
				id: `m${nextId++}`,
				action: "toggleTask",
				deliverableId: nodeId,
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
const agents: { close: () => void }[] = [];

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "v2-hard-"));
	repoDir = join(tmpDir, "repo");
	planDir = join(tmpDir, "plan");
	socketPath = join(tmpDir, "maestro.sock");
	git(tmpDir, "init", "-q", "-b", "main", "repo");
	git(repoDir, "config", "user.email", "e2e@test");
	git(repoDir, "config", "user.name", "e2e");
	writeFileSync(join(repoDir, "README.md"), "seed\n");
	git(repoDir, "add", "-A");
	git(repoDir, "commit", "-q", "-m", "seed");
	engine = PlanEngineV2.create(createPlanStoreV2(join(tmpDir, "plans")), {
		slug: "hard",
		title: "Hardening",
		repoPath: repoDir,
	});
});

afterEach(async () => {
	for (const a of agents.splice(0)) a.close();
	await adapter.destroy();
	rmSync(tmpDir, { recursive: true, force: true });
});

async function boot(
	shipLog: Array<{ nodeId: string; branch: string }>,
): Promise<void> {
	adapter = new NodeExecutionAdapter({
		engine,
		planDir,
		tmux: stubTmux(),
		token: TOKEN,
		socketPath,
		defaultBranch: "main",
		onPlanChanged: () => {},
		shipNode: async (opts) => {
			shipLog.push({ nodeId: opts.nodeId, branch: opts.branch });
			return `https://example/pr/${shipLog.length}`;
		},
	});
	await adapter.start();
	await adapter.tick();
}

describe("real-git provisioning through full activation", () => {
	it("stacked chain: worktrees from cold, feat/b based on feat/a, chain-order ship", async () => {
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "A",
			branch: "feat/a",
			tasks: ["a1"],
		});
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "B",
			branch: "feat/b",
			after: ["a"],
			tasks: ["b1"],
		});
		const ships: Array<{ nodeId: string; branch: string }> = [];
		await boot(ships);

		// Activation provisioned a REAL worktree for a (no shortcuts).
		const aWorktree = adapter.getExecutor().getRunState("a")?.worktreePath;
		expect(aWorktree && existsSync(aWorktree)).toBe(true);
		expect(git(aWorktree as string, "branch", "--show-current").trim()).toBe(
			"feat/a",
		);

		// Worker a: writes, COMMITS (the dirty-hold demands it), toggles, idles.
		const a = scriptedAgent(
			socketPath,
			"a",
			CONTRACT_BLOCKS["summary-and-diff"],
		);
		agents.push(a);
		await a.ready;
		a.working();
		writeFileSync(join(aWorktree as string, "a.ts"), "export const a = 1;\n");
		git(aWorktree as string, "add", "-A");
		git(aWorktree as string, "commit", "-q", "-m", "feat: a");
		a.toggleTask("a1");
		a.toggleTask("lifecycle-postflight", "## Handoff\nA is built.");
		a.idle();
		await until(() => findNodeV2(engine.get(), "a")?.status === "shipped");
		expect(ships).toEqual([{ nodeId: "a", branch: "feat/a" }]);

		// b activates on the satisfied dep, STACKED: its worktree is based on
		// feat/a — the seed commit AND a's commit are both in its history.
		await adapter.tick();
		await until(
			() => adapter.getExecutor().getRunState("b")?.worktreePath !== undefined,
		);
		const bWorktree = adapter.getExecutor().getRunState("b")?.worktreePath;
		expect(git(bWorktree as string, "branch", "--show-current").trim()).toBe(
			"feat/b",
		);
		expect(git(bWorktree as string, "log", "--oneline")).toContain("feat: a");

		const b = scriptedAgent(
			socketPath,
			"b",
			CONTRACT_BLOCKS["summary-and-diff"],
		);
		agents.push(b);
		await b.ready;
		b.working();
		writeFileSync(join(bWorktree as string, "b.ts"), "export const b = 1;\n");
		git(bWorktree as string, "add", "-A");
		git(bWorktree as string, "commit", "-q", "-m", "feat: b");
		b.toggleTask("b1");
		b.toggleTask("lifecycle-preflight");
		b.toggleTask("lifecycle-postflight", "## Handoff\nB is built.");
		b.idle();
		await until(() => findNodeV2(engine.get(), "b")?.status === "shipped");
		expect(ships.map((s) => s.nodeId)).toEqual(["a", "b"]);

		// The contract result landed on the LEDGER at extraction tier "block".
		const aNode = findNodeV2(engine.get(), "a");
		expect(aNode?.result).toMatchObject({ contract: "summary-and-diff" });
		expect(aNode?.result?.payload).toMatchObject({ outcome: "done" });
	});

	it("a candidate child gets a real cand/ worktree based on the parent's branch", async () => {
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "P",
			branch: "feat/p",
			tasks: ["p1"],
		});
		await boot([]);
		const pWorktree = adapter.getExecutor().getRunState("p")?.worktreePath;
		// Parent commits something candidates must be based on.
		writeFileSync(
			join(pWorktree as string, "base.ts"),
			"export const p = 1;\n",
		);
		git(pWorktree as string, "add", "-A");
		git(pWorktree as string, "commit", "-q", "-m", "feat: parent base");

		engine.appendChild(
			"p",
			{ agent: "worker", persona: "coder", title: "Cand" },
			"p",
		);
		await adapter.tick();
		const candWorktree = adapter
			.getExecutor()
			.getRunState("cand")?.worktreePath;
		expect(candWorktree).toContain("_candidates");
		expect(git(candWorktree as string, "branch", "--show-current").trim()).toBe(
			"cand/p/cand",
		);
		// Based on the PARENT'S branch point, parent's commit included.
		expect(git(candWorktree as string, "log", "--oneline")).toContain(
			"feat: parent base",
		);
	});
});

describe("children + contracts + resolution over RPC", () => {
	it("a parent-gated reviewer folds in with its findings on the ledger", async () => {
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Build",
			branch: "feat/build",
			tasks: ["t1"],
		});
		const ships: Array<{ nodeId: string; branch: string }> = [];
		await boot(ships);
		engine.appendChild(
			"build",
			{
				agent: "reviewer",
				persona: "reviewer",
				title: "Rev",
				after: ["parent"],
			},
			"build",
		);

		const buildWorktree = adapter.getExecutor().getRunState("build")
			?.worktreePath as string;
		const worker = scriptedAgent(
			socketPath,
			"build",
			CONTRACT_BLOCKS["summary-and-diff"],
		);
		agents.push(worker);
		await worker.ready;
		worker.working();
		writeFileSync(join(buildWorktree, "x.ts"), "export const x = 1;\n");
		git(buildWorktree, "add", "-A");
		git(buildWorktree, "commit", "-q", "-m", "feat: x");
		worker.toggleTask("t1");
		worker.toggleTask("lifecycle-postflight", "handoff");
		// Toggles are async RPC mutations — wait for the ledger before ticking.
		await until(
			() =>
				findNodeV2(engine.get(), "build")?.tasks.every((t) => t.done) === true,
		);
		await adapter.tick(); // parent gating done → reviewer spawns

		await until(() => adapter.getExecutor().getRunState("rev") !== undefined);
		const reviewer = scriptedAgent(socketPath, "rev", CONTRACT_BLOCKS.findings);
		agents.push(reviewer);
		await reviewer.ready;
		reviewer.working();
		reviewer.idle();
		reviewer.idle(); // sustained idle completes a read agent
		await until(() => findNodeV2(engine.get(), "rev")?.status === "complete");

		// The reviewer's neutral findings landed on the ledger.
		const rev = findNodeV2(engine.get(), "rev");
		expect(rev?.result).toMatchObject({ contract: "findings" });
		expect(rev?.result?.payload).toMatchObject({
			summary: "checked and sound",
		});

		// Worker completes; the child summary folds into the parent's rollup.
		worker.idle();
		await until(() => findNodeV2(engine.get(), "build")?.status === "shipped");
		expect(findNodeV2(engine.get(), "build")?.summary).toContain("rev done");
	});

	it("spawn-time resolution lands on the ledger and reaches the spawn", async () => {
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "R",
			branch: "feat/r",
		});
		const spawnedModels: Array<string | undefined> = [];
		adapter = new NodeExecutionAdapter({
			engine,
			planDir,
			tmux: stubTmux(),
			token: TOKEN,
			socketPath,
			defaultBranch: "main",
			onPlanChanged: () => {},
			resolveModel: async (node) => ({
				resolution: {
					model: "sit-openai/gpt-5.6-sol",
					family: "openai",
					tier: "normal",
					source: "persona-tier",
					effort: "high",
					resolvedAt: "t",
					generation: node.sessionGeneration ?? 0,
				},
			}),
			spawnAgent: async (spawn) => {
				spawnedModels.push(spawn.model);
				return {
					sessionId: `sess-${spawn.nodeId}`,
					sessionFile: `/tmp/${spawn.nodeId}.jsonl`,
				};
			},
		});
		await adapter.start();
		await adapter.tick();

		expect(spawnedModels).toEqual(["sit-openai/gpt-5.6-sol"]);
		const node = findNodeV2(engine.get(), "r");
		expect(node?.resolutions).toHaveLength(1);
		expect(node?.resolutions?.[0]).toMatchObject({
			model: "sit-openai/gpt-5.6-sol",
			family: "openai",
			tier: "normal",
			source: "persona-tier",
		});
	});
});
