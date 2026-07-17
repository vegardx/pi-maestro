// Cache-hit verification: the prompt-cache contract from the knowledge
// session + seeding design. Layer 1 pins the static prefix invariants —
// one identical agent system prompt per tool class, byte-identical
// knowledge-fork prefixes, exactly TWO tool classes, and byte-stable seed
// framing. Layer 2 drives the runtime surfacing — first-turn cache ratio in
// snapshot(), cache-miss events, and the dashboard suffix — over a real RPC
// socket with a stub tmux (the observability harness pattern).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MaestroRpcClient, type TokenSnapshot } from "@vegardx/pi-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanEngine } from "../packages/modes/src/engine.js";
import {
	ExecutionAdapter,
	type TmuxApi,
} from "../packages/modes/src/exec/execution-adapter.js";
import type {
	ExecutionAgentSnapshot,
	ExecutionDeliverableSnapshot,
	ExecutionHandle,
} from "../packages/modes/src/exec/index.js";
import {
	buildKnowledgeSession,
	KNOWLEDGE_FRAME,
} from "../packages/modes/src/exec/knowledge.js";
import { buildAgentSessionFile } from "../packages/modes/src/exec/provisioner.js";
import {
	FINDINGS_FRAME,
	FINDINGS_HEADER,
	FOCUS_FRAME,
	FOCUS_HEADER,
	PRIOR_WORK_FRAME,
	PRIOR_WORK_HEADER,
	RESEARCH_REFS_FRAME,
	RESEARCH_REFS_HEADER,
	TASKS_FRAME,
	TASKS_HEADER,
	TRUNCATION_MARKER,
} from "../packages/modes/src/exec/seeds.js";
import { renderAgentsOverview } from "../packages/modes/src/runtime/dashboard.js";
import {
	computeAgentSessionTools,
	FULL_MODE_ENSURED_TOOLS,
	READ_ONLY_ENSURED_TOOLS,
	READ_ONLY_STRIPPED_TOOLS,
} from "../packages/modes/src/runtime/hooks.js";
import { buildAgentWorkerPreamble } from "../packages/modes/src/runtime/preambles.js";
import type { Plan } from "../packages/modes/src/schema.js";
import type { PlanStore } from "../packages/modes/src/storage.js";

/** Patterns that would make a cache-prefix constant vary between runs. */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
	const prev = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(vars)) {
		prev.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of prev) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

// ─── 1. System-prompt invariance ─────────────────────────────────────────────

describe("agent system prompt invariance", () => {
	it("takes no per-agent parameters", () => {
		expect(buildAgentWorkerPreamble.length).toBe(0);
	});

	it("is byte-identical for different agents of the full class", () => {
		const a = withEnv(
			{ PI_MAESTRO_AGENT_MODE: "full", PI_MAESTRO_AGENT_ID: "g1/worker" },
			() => buildAgentWorkerPreamble(),
		);
		const b = withEnv(
			{ PI_MAESTRO_AGENT_MODE: "full", PI_MAESTRO_AGENT_ID: "g2/worker" },
			() => buildAgentWorkerPreamble(),
		);
		// Unset mode falls into the same (full) class — same bytes.
		const c = withEnv(
			{ PI_MAESTRO_AGENT_MODE: undefined, PI_MAESTRO_AGENT_ID: "g3/worker" },
			() => buildAgentWorkerPreamble(),
		);
		expect(a).toBe(b);
		expect(a).toBe(c);
	});

	it("is byte-identical for different agents of the read-only class", () => {
		const a = withEnv(
			{
				PI_MAESTRO_AGENT_MODE: "read-only",
				PI_MAESTRO_AGENT_ID: "g1/reviewer",
			},
			() => buildAgentWorkerPreamble(),
		);
		const b = withEnv(
			{
				PI_MAESTRO_AGENT_MODE: "read-only",
				PI_MAESTRO_AGENT_ID: "g2/security",
			},
			() => buildAgentWorkerPreamble(),
		);
		expect(a).toBe(b);
	});

	it("yields exactly two distinct preambles across all agents (one per class)", () => {
		const outputs = [
			["full", "g1/worker"],
			["full", "g2/worker"],
			[undefined, "g3/worker"],
			["read-only", "g1/reviewer"],
			["read-only", "g2/security"],
		].map(([mode, id]) =>
			withEnv({ PI_MAESTRO_AGENT_MODE: mode, PI_MAESTRO_AGENT_ID: id }, () =>
				buildAgentWorkerPreamble(),
			),
		);
		expect(new Set(outputs).size).toBe(2);
	});

	it("contains no dynamic content (timestamps, uuids, interpolation)", () => {
		for (const mode of ["full", "read-only"]) {
			const out = withEnv({ PI_MAESTRO_AGENT_MODE: mode }, () =>
				buildAgentWorkerPreamble(),
			);
			expect(out.length).toBeGreaterThan(0);
			expect(out).not.toMatch(ISO_TIMESTAMP);
			expect(out).not.toMatch(UUID);
			expect(out).not.toContain("${");
		}
	});
});

// ─── 2. Knowledge-fork prefix identity ───────────────────────────────────────

const KNOWLEDGE_DOC = [
	KNOWLEDGE_FRAME,
	"",
	"## Project Structure",
	"packages/modes holds the plan engine; packages/rpc the socket transport.",
	"",
	"## Key Patterns",
	"Pure state machines with injected deps; adapters own the side effects.",
	"",
	"## Conventions",
	"Tabs, biome, sparse comments.",
	"",
	"## Key Interfaces",
	"Plan/Deliverable/AgentSpec in schema.ts; DeliverableExecutor drives execution.",
].join("\n");

describe("knowledge-fork prefix identity", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cache-invariants-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("two agents forked from one knowledge session share a byte-identical prefix", () => {
		const knowledge = buildKnowledgeSession({
			content: KNOWLEDGE_DOC,
			repoPath: dir,
			outPath: join(dir, "base-knowledge.jsonl"),
		});
		const knowledgeLines = readFileSync(knowledge.path, "utf-8")
			.trim()
			.split("\n");
		expect(knowledgeLines).toHaveLength(2); // header + base-knowledge entry

		const worker = buildAgentSessionFile({
			agentKey: "g1/worker",
			agentMode: "full",
			seed: "# Your Tasks\n\nImplement the adapter.\n",
			cwd: dir,
			outDir: join(dir, "sessions"),
			knowledgeSessionPath: knowledge.path,
		});
		const reviewer = buildAgentSessionFile({
			agentKey: "g1/reviewer",
			agentMode: "read-only",
			seed: "# Your Focus\n\nReview the adapter.\n",
			cwd: dir,
			outDir: join(dir, "sessions"),
			knowledgeSessionPath: knowledge.path,
		});

		const a = readFileSync(worker.path, "utf-8").trim().split("\n");
		const b = readFileSync(reviewer.path, "utf-8").trim().split("\n");
		// header + knowledge entry + modes-state + agent-context + seed
		expect(a).toHaveLength(5);
		expect(b).toHaveLength(5);

		// Session headers differ ONLY in their fresh session id: everything
		// else — version, cwd, parentSession lineage — is identical.
		const headerA = JSON.parse(a[0]) as Record<string, unknown>;
		const headerB = JSON.parse(b[0]) as Record<string, unknown>;
		expect(headerA.id).not.toBe(headerB.id);
		expect(headerA.parentSession).toBe(knowledge.path);
		expect({ ...headerA, id: null, timestamp: null }).toEqual({
			...headerB,
			id: null,
			timestamp: null,
		});

		// The knowledge content line is byte-identical between the two agent
		// files AND byte-identical to the frozen knowledge session's own line —
		// the fork's parse→stringify round-trip is deterministic for files the
		// SDK itself serialized.
		expect(a[1]).toBe(b[1]);
		expect(a[1]).toBe(knowledgeLines[1]);
		expect(a[1]).toContain("maestro.base-knowledge");

		// Divergence starts exactly at the appended modes-state entry: every
		// knowledge-derived line before it matches; the appended entries carry
		// fresh ids per agent.
		const body = a.slice(1);
		const other = b.slice(1);
		let divergence = body.length;
		for (let i = 0; i < body.length; i++) {
			if (body[i] !== other[i]) {
				divergence = i;
				break;
			}
		}
		expect(divergence).toBe(1); // index 0 = knowledge entry, 1 = modes-state
		expect(a[4]).toContain("Implement the adapter.");
		expect(b[4]).toContain("Review the adapter.");
	});
});

// ─── 3. Exactly two tool classes ─────────────────────────────────────────────

describe("agent tool classes", () => {
	const AVAILABLE = [
		"read",
		"grep",
		"find",
		"ls",
		"bash",
		"edit",
		"write",
		"commit",
		"ship",
		"ask",
		"task",
		"plan",
		"review",
		"websearch",
		"dig",
	];
	// Baseline active set as pi hands it to an agent session (task stripped).
	const ACTIVE = AVAILABLE.filter((t) => t !== "task");

	const normalize = (tools: string[]) => [...tools].sort();

	it("agents of the same mode always compute identical tool sets", () => {
		const full1 = computeAgentSessionTools("full", AVAILABLE, ACTIVE);
		const full2 = computeAgentSessionTools("full", AVAILABLE, ACTIVE);
		// Unset mode is the full class; baseline order must not leak either.
		const full3 = computeAgentSessionTools(
			undefined,
			AVAILABLE,
			[...ACTIVE].reverse(),
		);
		expect(normalize(full1)).toEqual(normalize(full2));
		expect(normalize(full1)).toEqual(normalize(full3));

		const ro1 = computeAgentSessionTools("read-only", AVAILABLE, ACTIVE);
		const ro2 = computeAgentSessionTools(
			"read-only",
			AVAILABLE,
			[...ACTIVE].reverse(),
		);
		expect(normalize(ro1)).toEqual(normalize(ro2));
	});

	it("exactly two distinct tool sets exist across modes", () => {
		const sets = new Set(
			["full", undefined, "read-only", "read-only", "full"].map((mode) =>
				JSON.stringify(
					normalize(computeAgentSessionTools(mode, AVAILABLE, ACTIVE)),
				),
			),
		);
		expect(sets.size).toBe(2);
	});

	it("read-only strips the write surface and ensures reporting tools", () => {
		const ro = computeAgentSessionTools("read-only", AVAILABLE, ACTIVE);
		for (const tool of READ_ONLY_STRIPPED_TOOLS) {
			expect(ro).not.toContain(tool);
		}
		for (const tool of READ_ONLY_ENSURED_TOOLS) {
			expect(ro).toContain(tool);
		}
	});

	it("full mode ensures the decision-loop tools", () => {
		const full = computeAgentSessionTools("full", AVAILABLE, ACTIVE);
		for (const tool of FULL_MODE_ENSURED_TOOLS) {
			expect(full).toContain(tool);
		}
	});

	it("dig is ensured in BOTH classes (research pull is not a write privilege)", () => {
		const full = computeAgentSessionTools("full", AVAILABLE, ACTIVE);
		const ro = computeAgentSessionTools("read-only", AVAILABLE, ACTIVE);
		expect(full).toContain("dig");
		expect(ro).toContain("dig");
	});

	it("the strip and ensure lists define disjoint class behavior", () => {
		// The two classes must actually differ — otherwise there is one cache
		// class, and the read-only/full distinction is dead code.
		const full = normalize(computeAgentSessionTools("full", AVAILABLE, ACTIVE));
		const ro = normalize(
			computeAgentSessionTools("read-only", AVAILABLE, ACTIVE),
		);
		expect(full).not.toEqual(ro);
	});
});

// ─── 4. Seed framing constants are byte-stable ───────────────────────────────

describe("seed framing constants", () => {
	const FRAMING = {
		PRIOR_WORK_HEADER,
		PRIOR_WORK_FRAME,
		FINDINGS_HEADER,
		FINDINGS_FRAME,
		RESEARCH_REFS_HEADER,
		RESEARCH_REFS_FRAME,
		TASKS_HEADER,
		TASKS_FRAME,
		FOCUS_HEADER,
		FOCUS_FRAME,
		TRUNCATION_MARKER,
		KNOWLEDGE_FRAME,
	};

	it("contain no dynamic content (dates, uuids, interpolation)", () => {
		for (const [name, value] of Object.entries(FRAMING)) {
			expect(typeof value, name).toBe("string");
			expect(value.length, name).toBeGreaterThan(0);
			expect(value, name).not.toMatch(ISO_TIMESTAMP);
			expect(value, name).not.toMatch(UUID);
			expect(value, name).not.toContain("${");
		}
	});
});

// ─── Layer 2: first-turn cache ratio + cache-miss events ─────────────────────

const TOKEN = "cache-test-token";

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

function snapshotOf(over: Partial<TokenSnapshot>): TokenSnapshot {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		promptTokens: 0,
		totalTokens: 0,
		cost: 0,
		turns: 1,
		...over,
	};
}

describe("first-turn cache ratio surfacing", () => {
	let tmpDir: string;
	let planDir: string;
	let adapter: ExecutionAdapter;
	let engine: PlanEngine;
	const clients: MaestroRpcClient[] = [];
	const tokenReports: string[] = [];
	let prevSessionDir: string | undefined;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "cache-ratio-test-"));
		planDir = join(tmpDir, "plan");
		prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpDir, "sessions");
		tokenReports.length = 0;

		engine = PlanEngine.create(memStore(), {
			slug: "cache",
			title: "Cache Plan",
			repoPath: tmpDir,
		});
		// Two full-class workers in separate deliverables: same tool class, so the
		// second one's first turn is expected to hit the first one's warm cache.
		for (const title of ["Deliverable One", "Deliverable Two"]) {
			const deliverable = engine.addDeliverable({ title, workerMode: "full" });
			engine.addWorkItem(deliverable.id, {
				title: "do the thing",
				kind: "task",
			});
			engine.setDeliverableStatus(deliverable.id, "active");
			engine.updateDeliverable(deliverable.id, { worktreePath: tmpDir });
		}

		adapter = new ExecutionAdapter({
			engine,
			ctx: { cwd: tmpDir } as ExtensionContext,
			extensionPath: "/nonexistent/ext",
			defaultBranch: "main",
			planDir,
			tmux: stubTmux(),
			token: TOKEN,
			socketPath: join(tmpDir, "maestro.sock"),
			resolveWorkerModel: async (choice) => ({
				modelId: choice.model ?? "test/worker",
				effort: choice.effort ?? "low",
			}),
			onPlanChanged: () => {},
			onAgentStateChanged: (id) => {
				tokenReports.push(id);
			},
		});
		await adapter.start();
		adapter.getExecutor().unblockDeliverable("deliverable-one");
		adapter.getExecutor().unblockDeliverable("deliverable-two");
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
		ready: Promise<void>;
	} {
		const client = new MaestroRpcClient({ reconnect: false });
		clients.push(client);
		let acked = false;
		client.on("message", (msg) => {
			if (msg.type === "helloAck" && msg.ok) acked = true;
		});
		client.connect(join(tmpDir, "maestro.sock"), {
			agentId,
			role: "agent",
			token: TOKEN,
			pid: process.pid,
		});
		return { client, ready: until(() => acked) };
	}

	function cacheMissEvents(): Record<string, unknown>[] {
		let raw: string;
		try {
			raw = readFileSync(join(planDir, "events.jsonl"), "utf-8");
		} catch {
			return [];
		}
		return raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((e) => e.event === "cache-miss");
	}

	/**
	 * Wait for the NEXT onAgentStateChanged report for an agent (the callback
	 * also fires once at spawn, so absolute counts would race).
	 */
	function nextReport(id: string): () => Promise<void> {
		const baseline = tokenReports.filter((r) => r === id).length;
		return () =>
			until(() => tokenReports.filter((r) => r === id).length > baseline);
	}

	it("sets prefixCacheHitRate from the FIRST tokens message and never re-computes it", async () => {
		const { client, ready } = connect("deliverable-one/worker");
		await ready;

		client.send({
			type: "tokens",
			revision: 1,
			snapshot: snapshotOf({ input: 2000, cacheRead: 8000 }),
		});
		await until(
			() =>
				adapter.snapshot().agents.get("deliverable-one/worker")
					?.prefixCacheHitRate === 0.8,
		);

		// A later, colder tokens message must not move the first-turn ratio.
		client.send({
			type: "tokens",
			revision: 2,
			snapshot: snapshotOf({ input: 9000, cacheRead: 1000, turns: 2 }),
		});
		await until(
			() =>
				adapter.snapshot().agents.get("deliverable-one/worker")?.tokens
					.input === 9000,
		);
		expect(
			adapter.snapshot().agents.get("deliverable-one/worker")
				?.prefixCacheHitRate,
		).toBe(0.8);
	});

	it("guards division by zero: no ratio, no event, no crash", async () => {
		const { client, ready } = connect("deliverable-one/worker");
		await ready;

		const reported = nextReport("deliverable-one/worker");
		client.send({
			type: "tokens",
			revision: 1,
			snapshot: snapshotOf({ input: 0, cacheRead: 0 }),
		});
		await reported();

		const worker = adapter.snapshot().agents.get("deliverable-one/worker");
		expect(worker).toBeDefined();
		expect(worker?.prefixCacheHitRate).toBeUndefined();
		expect(cacheMissEvents()).toHaveLength(0);
	});

	it("logs cache-miss when a cold first turn follows a same-class agent", async () => {
		const one = connect("deliverable-one/worker");
		const two = connect("deliverable-two/worker");
		await one.ready;
		await two.ready;

		// First agent of the class: cold ratio, but no warm prefix was expected
		// yet — must NOT produce an event.
		const oneReported = nextReport("deliverable-one/worker");
		one.client.send({
			type: "tokens",
			revision: 1,
			snapshot: snapshotOf({ input: 10_000, cacheRead: 0 }),
		});
		await oneReported();
		expect(cacheMissEvents()).toHaveLength(0);

		// Second same-class agent, cold within the warm window → cache-miss.
		two.client.send({
			type: "tokens",
			revision: 1,
			snapshot: snapshotOf({ input: 1000, cacheRead: 100 }),
		});
		await until(() => cacheMissEvents().length === 1);

		const event = cacheMissEvents()[0];
		expect(event).toMatchObject({
			event: "cache-miss",
			agentKey: "deliverable-two/worker",
			class: "full",
			input: 1000,
			cacheRead: 100,
		});
		expect(event.ratio).toBeCloseTo(100 / 1100);
		expect(String(event.expectedWarmBecause)).toContain(
			"deliverable-one/worker",
		);
		expect(typeof event.ts).toBe("string");
	});

	it("does not log cache-miss for a warm first turn", async () => {
		const one = connect("deliverable-one/worker");
		const two = connect("deliverable-two/worker");
		await one.ready;
		await two.ready;

		const oneReported = nextReport("deliverable-one/worker");
		one.client.send({
			type: "tokens",
			revision: 1,
			snapshot: snapshotOf({ input: 10_000, cacheRead: 0 }),
		});
		await oneReported();

		two.client.send({
			type: "tokens",
			revision: 1,
			snapshot: snapshotOf({ input: 500, cacheRead: 9500 }),
		});
		await until(
			() =>
				adapter.snapshot().agents.get("deliverable-two/worker")
					?.prefixCacheHitRate === 0.95,
		);
		expect(cacheMissEvents()).toHaveLength(0);
	});

	it("does not treat an agent of the OTHER tool class as a warm peer", async () => {
		const worker = connect("deliverable-one/worker");
		// Not in the plan's agent specs → derives to the read-only class.
		const reviewer = connect("deliverable-one/reviewer-x");
		await worker.ready;
		await reviewer.ready;

		const workerReported = nextReport("deliverable-one/worker");
		worker.client.send({
			type: "tokens",
			revision: 1,
			snapshot: snapshotOf({ input: 10_000, cacheRead: 0 }),
		});
		await workerReported();

		const reviewerReported = nextReport("deliverable-one/reviewer-x");
		reviewer.client.send({
			type: "tokens",
			revision: 1,
			snapshot: snapshotOf({ input: 1000, cacheRead: 0 }),
		});
		await reviewerReported();
		expect(cacheMissEvents()).toHaveLength(0);
	});
});

// ─── Dashboard rendering ─────────────────────────────────────────────────────

describe("renderAgentsOverview cache suffix", () => {
	function makeHandle(
		agents: Map<string, ExecutionAgentSnapshot>,
	): ExecutionHandle {
		return {
			questionQueue: { all: () => [], saveDraft: () => {}, answer: () => {} },
			failingRequiredReviewers: () => [],
			reviewerFindings: () => [],
			overrideReviewerVerdict: () => {},
			sendBackToWorker: async () => false,
			start: async () => {},
			tick: async () => 0,
			steer: () => true,
			snapshot: () => ({
				agents,
				deliverables: new Map<string, ExecutionDeliverableSnapshot>(),
			}),
			resolveSessionName: () => undefined,
			getExecutor: () => {
				throw new Error("not wired in this test");
			},
			markAgentDone: async () => {},
			isWorkerDone: () => false,
			getWorkerSessions: () => [],
			destroy: async () => {},
		};
	}

	function planWithDeliverable(): PlanEngine {
		const engine = PlanEngine.create(memStore(), {
			slug: "t",
			title: "T",
			repoPath: "/tmp/repo",
		});
		engine.addDeliverable({ title: "Auth", workerMode: "full" });
		return engine;
	}

	it("appends cache NN% when the ratio is known", () => {
		const engine = planWithDeliverable();
		const handle = makeHandle(
			new Map([
				[
					"auth/worker",
					{
						status: "working",
						startedAt: Date.now(),
						tokens: { input: 5000, output: 120, turns: 9 },
						prefixCacheHitRate: 0.874,
					},
				],
			]),
		);
		const out = renderAgentsOverview(engine.get(), handle);
		expect(out).toContain(
			"worker (full) — working · 5000in/120out · 9 turns · prefix 87%",
		);
	});

	it("omits the cache suffix when the ratio is unknown", () => {
		const engine = planWithDeliverable();
		const handle = makeHandle(
			new Map([
				[
					"auth/worker",
					{
						status: "working",
						startedAt: Date.now(),
						tokens: { input: 5000, output: 120, turns: 9 },
					},
				],
			]),
		);
		const out = renderAgentsOverview(engine.get(), handle);
		expect(out).toContain("worker (full) — working · 5000in/120out · 9 turns");
		expect(out).not.toContain("cache");
	});
});
