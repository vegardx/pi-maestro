import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	RunBusMessage,
	RunId,
	RunRecord,
	RunResult,
	SpawnProfile,
} from "@vegardx/pi-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentRunner,
	attachSupervisor,
	canTransition,
	createAgentRunner,
	createRunBus,
	createRunStore,
	createSemaphore,
	createSubagentTool,
	createSupervisorTool,
	currentDepth,
	DEPTH_ENV,
	discoverAgents,
	isActive,
	isTerminal,
	type LaunchRequest,
	mapProfileToInvocation,
	msgRunId,
	needDecisionMessage,
	parseAgentDefinition,
	parseFrontmatter,
	persistRunBus,
	pruneRuns,
	type RunBus,
	type RunnerController,
	type RunStore,
	resolveProfile,
	SubagentService,
} from "../packages/subagents/src/index.js";

const PROFILE: SpawnProfile = { profile: "restricted" };

function id(s: string): RunId {
	return s as RunId;
}

function record(over: Partial<RunRecord> = {}): RunRecord {
	const now = Date.now();
	return {
		id: id("r1"),
		profile: PROFILE,
		status: "queued",
		createdAt: now,
		updatedAt: now,
		...over,
	};
}

describe("run state machine", () => {
	it("allows the legal lifecycle and rejects illegal jumps", () => {
		expect(canTransition("queued", "running")).toBe(true);
		expect(canTransition("running", "succeeded")).toBe(true);
		expect(canTransition("running", "blocked")).toBe(true);
		expect(canTransition("blocked", "running")).toBe(true);
		expect(canTransition("queued", "succeeded")).toBe(false);
		expect(canTransition("succeeded", "running")).toBe(false);
	});

	it("classifies terminal vs active", () => {
		expect(isTerminal("succeeded")).toBe(true);
		expect(isTerminal("canceled")).toBe(true);
		expect(isActive("running")).toBe(true);
		expect(isActive("queued")).toBe(true);
		expect(isActive("blocked")).toBe(true);
		expect(isActive("failed")).toBe(false);
	});
});

describe("RunStore", () => {
	let root: string;
	let store: RunStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-runs-"));
		store = createRunStore(root);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("round-trips a record and enforces transitions", () => {
		store.create(record());
		expect(store.readRecord(id("r1"))?.status).toBe("queued");

		store.setStatus(id("r1"), "running");
		expect(store.readRecord(id("r1"))?.status).toBe("running");

		expect(() => store.setStatus(id("r1"), "queued")).toThrow(/illegal/);
	});

	it("appends and replays events, skipping torn lines", () => {
		const msg: RunBusMessage = {
			type: "progress",
			runId: id("r1"),
			delta: { text: "hi" },
		};
		store.appendEvent(id("r1"), msg);
		store.appendEvent(id("r1"), msg);
		// Simulate a torn trailing write.
		writeFileSync(
			join(root, "r1", "events.jsonl"),
			`${readFileSync(join(root, "r1", "events.jsonl"), "utf8")}{partial`,
		);
		expect(store.readEvents(id("r1"))).toHaveLength(2);
	});

	it("stores a result and result markdown", () => {
		store.create(record({ status: "queued" }));
		store.setStatus(id("r1"), "running");
		store.setResult(id("r1"), { status: "succeeded", summary: "done" });
		store.writeResult(id("r1"), "# done");
		expect(store.readRecord(id("r1"))?.status).toBe("succeeded");
		expect(store.readResult(id("r1"))).toBe("# done");
	});

	it("lists records and removes them", () => {
		store.create(record({ id: id("a") }));
		store.create(record({ id: id("b") }));
		expect(
			store
				.list()
				.map((r) => r.id)
				.sort(),
		).toEqual(["a", "b"]);
		store.remove(id("a"));
		expect(store.list().map((r) => r.id)).toEqual(["b"]);
	});
});

describe("RunBus + persistence", () => {
	let root: string;
	let store: RunStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-bus-"));
		store = createRunStore(root);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("delivers to subscribers and replays the ring", () => {
		const bus = createRunBus();
		const seen: string[] = [];
		const off = bus.subscribe((m) => seen.push(m.type));
		bus.publish({ type: "status", runId: id("r1"), status: "running", at: 1 });
		off();
		bus.publish({ type: "stop", runId: id("r1") });
		expect(seen).toEqual(["status"]);
		expect(bus.replay(id("r1"))).toHaveLength(2);
	});

	it("msgRunId extracts the run for spawn and run-scoped messages", () => {
		expect(
			msgRunId({
				type: "spawn",
				run: { id: id("r1"), prompt: "x", profile: PROFILE },
			}),
		).toBe("r1");
		expect(msgRunId({ type: "stop", runId: id("r2") })).toBe("r2");
	});

	it("mirrors spawn/status/result into the store", () => {
		const bus = createRunBus();
		const off = persistRunBus(bus, store);
		bus.publish({
			type: "spawn",
			run: { id: id("r1"), prompt: "go", profile: PROFILE },
		});
		bus.publish({ type: "status", runId: id("r1"), status: "running", at: 2 });
		bus.publish({
			type: "result",
			runId: id("r1"),
			result: { status: "succeeded", summary: "ok" },
		});
		off();
		expect(store.readRecord(id("r1"))?.status).toBe("succeeded");
		expect(store.readResult(id("r1"))).toBe("ok");
		expect(store.readEvents(id("r1"))).toHaveLength(3);
	});
});

describe("retention", () => {
	let root: string;
	let store: RunStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-gc-"));
		store = createRunStore(root);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const day = 24 * 60 * 60 * 1000;

	it("never prunes active runs", () => {
		store.create(record({ id: id("live"), status: "running", updatedAt: 0 }));
		const { pruned } = pruneRuns(
			store,
			{ maxRuns: 0, maxAgeDays: 0, eventLogCapBytes: 1e9 },
			10 * day,
		);
		expect(pruned).toEqual([]);
		expect(store.readRecord(id("live"))).toBeDefined();
	});

	it("drops over-cap and too-old terminal runs", () => {
		const now = 100 * day;
		store.create(
			record({ id: id("old"), status: "succeeded", updatedAt: now - 30 * day }),
		);
		store.create(
			record({
				id: id("recent1"),
				status: "succeeded",
				updatedAt: now - 1 * day,
			}),
		);
		store.create(
			record({ id: id("recent2"), status: "failed", updatedAt: now - 2 * day }),
		);
		const { pruned } = pruneRuns(
			store,
			{ maxRuns: 1, maxAgeDays: 14, eventLogCapBytes: 1e9 },
			now,
		);
		// old is too old; of the two recent, only the newest survives the cap.
		expect(pruned.sort()).toEqual(["old", "recent2"]);
		expect(store.readRecord(id("recent1"))).toBeDefined();
	});

	it("truncates an oversized event log head/tail", () => {
		store.create(record({ id: id("big"), status: "succeeded" }));
		const line = `{"type":"progress","runId":"big","delta":{"text":"${"x".repeat(200)}"}}\n`;
		writeFileSync(join(root, "big", "events.jsonl"), line.repeat(2000));
		const before = statSync(join(root, "big", "events.jsonl")).size;
		const { truncated } = pruneRuns(
			store,
			{ maxRuns: 50, maxAgeDays: 14, eventLogCapBytes: 50 * 1024 },
			Date.now(),
		);
		const after = statSync(join(root, "big", "events.jsonl")).size;
		expect(truncated).toEqual(["big"]);
		expect(after).toBeLessThan(before);
		expect(readFileSync(join(root, "big", "events.jsonl"), "utf8")).toContain(
			"_truncated",
		);
	});
});

describe("profiles + invocation mapping", () => {
	it("resolves a built-in and applies overrides", () => {
		const r = resolveProfile({ profile: "restricted" });
		expect(r.mode).toBe("plan");
		expect(r.session).toBe(false);
		expect(r.disableExtensions).toContain("modes");
		expect(r.disableExtensions).toContain("subagents");

		const o = resolveProfile({
			profile: "deliverable-worker",
			model: "anthropic/claude",
			mode: "hack",
		});
		expect(o.model).toBe("anthropic/claude");
		expect(o.mode).toBe("hack"); // override beats the default "auto"
		expect(o.disableExtensions).toEqual(["commit"]);
	});

	it("throws on an unknown profile", () => {
		expect(() => resolveProfile({ profile: "nope" })).toThrow(/unknown/);
	});

	it("maps pi-native config to args and enablement to env", () => {
		const inv = mapProfileToInvocation(
			{ profile: "restricted", appendSystemPrompt: "be terse" },
			{ repoRoot: "/repo", parentDepth: 0 },
		);
		expect(inv.args).toContain("--no-session");
		expect(inv.args).toContain("--mode");
		expect(inv.args).toContain("plan");
		expect(inv.args).toContain("--tools");
		expect(inv.args).toContain("--append-system-prompt");
		// read-only extensions disabled via env, not args.
		expect(inv.env.PI_EXT_MODES).toBe("off");
		expect(inv.env.PI_EXT_SUBAGENTS).toBe("off");
	});

	it("resolves cwd as profile → spawner → repoRoot and bumps depth", () => {
		expect(
			mapProfileToInvocation(
				{ profile: "deliverable-worker", cwd: "/wt" },
				{ spawnerCwd: "/spawn", repoRoot: "/repo", parentDepth: 1 },
			).cwd,
		).toBe("/wt");
		expect(
			mapProfileToInvocation(
				{ profile: "deliverable-worker" },
				{ spawnerCwd: "/spawn", repoRoot: "/repo", parentDepth: 1 },
			).cwd,
		).toBe("/spawn");
		const inv = mapProfileToInvocation(
			{ profile: "deliverable-worker" },
			{ repoRoot: "/repo", parentDepth: 1 },
		);
		expect(inv.cwd).toBe("/repo");
		expect(inv.depth).toBe(2);
		expect(inv.env[DEPTH_ENV]).toBe("2");
	});

	it("computes kill-switch env explicitly, never leaking the parent's", () => {
		const inv = mapProfileToInvocation(
			{
				profile: "deliverable-worker",
				featureFlags: { disable: ["modes.fanout"], enable: ["modes.x"] },
			},
			{ repoRoot: "/repo", parentDepth: 0 },
		);
		// Always set, so a parent's PI_DISABLE cannot bleed through.
		expect(inv.env.PI_DISABLE).toBe("modes.fanout");
		expect(inv.env.PI_ENABLE).toBe("modes.x");

		const plain = mapProfileToInvocation(
			{ profile: "deliverable-worker" },
			{ repoRoot: "/repo", parentDepth: 0 },
		);
		expect(plain.env.PI_DISABLE).toBe("");
		expect(plain.env.PI_ENABLE).toBe("");
	});

	it("reads its own depth from the environment", () => {
		expect(currentDepth({ [DEPTH_ENV]: "2" })).toBe(2);
		expect(currentDepth({})).toBe(0);
		expect(currentDepth({ [DEPTH_ENV]: "bad" })).toBe(0);
	});
});

describe("SubagentService", () => {
	let root: string;
	let store: RunStore;
	let bus: RunBus;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-svc-"));
		store = createRunStore(root);
		bus = createRunBus();
		persistRunBus(bus, store);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	// A runner that records launches and drives the run to success.
	function fakeRunner(captured: LaunchRequest[]): AgentRunner {
		return {
			launch(request, b): RunnerController {
				captured.push(request);
				b.publish({
					type: "status",
					runId: request.runId,
					status: "running",
					at: 1,
				});
				const result = { status: "succeeded" as const, summary: "ok" };
				b.publish({ type: "result", runId: request.runId, result });
				return {
					steer: () => {},
					stop: () => {},
					result: () => Promise.resolve(result),
				};
			},
		};
	}

	it("spawns: records the run, maps the invocation, returns a handle", async () => {
		const captured: LaunchRequest[] = [];
		const svc = new SubagentService({
			bus,
			store,
			runner: fakeRunner(captured),
			repoRoot: "/repo",
			mintId: () => "run-1" as RunId,
			ownDepth: 0,
		});

		const handle = svc.spawn("do it", { profile: "restricted" });
		expect(handle.id).toBe("run-1");
		expect(captured).toHaveLength(1);
		expect(captured[0].invocation.env.PI_EXT_MODES).toBe("off");
		expect((await handle.result()).status).toBe("succeeded");
		expect(svc.get("run-1" as RunId)?.status).toBe("succeeded");
		expect(svc.list().map((r) => r.id)).toEqual(["run-1"]);
	});

	it("enforces the depth cap", () => {
		const svc = new SubagentService({
			bus,
			store,
			runner: fakeRunner([]),
			repoRoot: "/repo",
			ownDepth: 3,
			maxDepth: 3,
		});
		expect(() => svc.spawn("x", { profile: "restricted" })).toThrow(
			/depth cap/,
		);
	});

	it("steer and stop reach the controller and the bus", () => {
		const steered: string[] = [];
		const stopped: string[] = [];
		const runner: AgentRunner = {
			launch(_request): RunnerController {
				return {
					steer: (g) => steered.push(g),
					stop: (r) => stopped.push(r ?? ""),
					result: () => Promise.resolve({ status: "stopped" as const }),
				};
			},
		};
		const seen: string[] = [];
		bus.subscribe((m) => seen.push(m.type));
		const svc = new SubagentService({
			bus,
			store,
			runner,
			repoRoot: "/repo",
			mintId: () => "run-2" as RunId,
			ownDepth: 0,
		});
		svc.spawn("go", { profile: "deliverable-worker" });
		svc.steer("run-2" as RunId, "refocus");
		svc.stop("run-2" as RunId, "done");
		expect(steered).toEqual(["refocus"]);
		expect(stopped).toEqual(["done"]);
		expect(seen).toContain("steer");
		expect(seen).toContain("stop");
	});
});

describe("concurrency semaphore", () => {
	it("caps active acquisitions and serves waiters FIFO", async () => {
		const sem = createSemaphore(2);
		const r1 = await sem.acquire();
		const r2 = await sem.acquire();
		expect(sem.active).toBe(2);

		const order: number[] = [];
		const p3 = sem.acquire().then((r) => {
			order.push(3);
			return r;
		});
		const p4 = sem.acquire().then((r) => {
			order.push(4);
			return r;
		});
		expect(sem.waiting).toBe(2);

		r1(); // wakes the first waiter (3)
		const r3 = await p3;
		expect(order).toEqual([3]);
		r2(); // wakes the second waiter (4)
		const r4 = await p4;
		expect(order).toEqual([3, 4]);

		r3();
		r4();
		expect(sem.active).toBe(0);
	});

	it("a release is idempotent", async () => {
		const sem = createSemaphore(1);
		const r = await sem.acquire();
		r();
		r();
		expect(sem.active).toBe(0);
		await sem.acquire(); // a slot is genuinely free, not double-freed
		expect(sem.active).toBe(1);
	});

	it("rejects a waiter whose signal aborts, leaving the slot intact", async () => {
		const sem = createSemaphore(1);
		const held = await sem.acquire();
		const ac = new AbortController();
		const pending = sem.acquire(ac.signal);
		expect(sem.waiting).toBe(1);
		ac.abort();
		await expect(pending).rejects.toThrow(/aborted/);
		expect(sem.waiting).toBe(0);
		held();
		// The slot was never consumed by the aborted waiter.
		const next = await sem.acquire();
		expect(sem.active).toBe(1);
		next();
	});

	it("rejects immediately if already aborted", async () => {
		const sem = createSemaphore(1);
		const ac = new AbortController();
		ac.abort();
		await expect(sem.acquire(ac.signal)).rejects.toThrow(/aborted/);
	});
});

describe("RpcClient-backed runner", () => {
	let root: string;
	let store: RunStore;
	let bus: RunBus;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-runner-"));
		store = createRunStore(root);
		bus = createRunBus();
		persistRunBus(bus, store);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	// A scriptable RpcClient stand-in.
	function fakeClient(opts: {
		text?: string;
		emit?: { type: string; toolName?: string }[];
		startError?: string;
		hang?: boolean;
		captureEnv?: (env: Record<string, string> | undefined) => void;
		captureArgs?: (args: string[] | undefined) => void;
	}) {
		let listener: ((e: any) => void) | undefined;
		let aborted = false;
		const client = {
			listener: () => listener,
			abort: async () => {
				aborted = true;
			},
			get aborted() {
				return aborted;
			},
			start: async () => {
				if (opts.startError) throw new Error(opts.startError);
			},
			prompt: async () => {},
			steer: async () => {},
			stop: async () => {},
			onEvent: (l: (e: any) => void) => {
				listener = l;
				return () => {
					listener = undefined;
				};
			},
			waitForIdle: async () => {
				for (const e of opts.emit ?? []) listener?.(e);
				if (opts.hang) await new Promise(() => {});
			},
			getLastAssistantText: async () => opts.text ?? null,
		};
		const factory = (options: { env?: any; args?: any }) => {
			opts.captureEnv?.(options.env);
			opts.captureArgs?.(options.args);
			return client as any;
		};
		return { client, factory };
	}

	function launch(factory: any, extra: Record<string, unknown> = {}) {
		const runner = createAgentRunner({
			factory,
			semaphore: createSemaphore(2),
			baseEnv: { PATH: "/usr/bin" },
			...extra,
		});
		const req = {
			runId: "run-1" as RunId,
			prompt: "go",
			profile: { profile: "deliverable-worker" as const },
			invocation: {
				cwd: "/wt",
				args: ["--mode", "auto"],
				env: { PI_MAESTRO_DEPTH: "1", PI_DISABLE: "", PI_ENABLE: "" },
				depth: 1,
			},
		};
		// The service announces the run (creating the store record) before the
		// runner launches; mirror that here so persistence has a record to update.
		bus.publish({
			type: "spawn",
			run: { id: req.runId, prompt: req.prompt, profile: req.profile },
		});
		return runner.launch(req as any, bus);
	}

	it("runs to success, captures text, and maps tool progress", async () => {
		const seen: string[] = [];
		bus.subscribe((m) => {
			if (m.type === "progress") seen.push(m.delta.text ?? "");
		});
		const { factory } = fakeClient({
			text: "all done",
			emit: [{ type: "tool_execution_start", toolName: "read" }],
		});
		const ctrl = launch(factory);
		const result = await ctrl.result();
		expect(result.status).toBe("succeeded");
		expect(result.summary).toBe("all done");
		expect(seen).toContain("read");
		expect(store.readRecord("run-1" as RunId)?.status).toBe("succeeded");
	});

	it("merges baseEnv under the invocation's explicit maestro env", async () => {
		let captured: Record<string, string> | undefined;
		const { factory } = fakeClient({
			text: "x",
			captureEnv: (env) => {
				captured = env;
			},
		});
		await launch(factory).result();
		expect(captured?.PATH).toBe("/usr/bin");
		expect(captured?.PI_MAESTRO_DEPTH).toBe("1");
	});

	it("caps an oversized result", async () => {
		const { factory } = fakeClient({ text: "x".repeat(5000) });
		const result = await launch(factory, { resultCapBytes: 100 }).result();
		expect(result.summary?.length).toBeLessThan(200);
		expect(result.summary).toContain("truncated");
	});

	it("reports a launch failure as failed", async () => {
		const { factory } = fakeClient({ startError: "spawn EACCES" });
		const result = await launch(factory).result();
		expect(result.status).toBe("failed");
		expect(result.error).toContain("EACCES");
	});

	it("stop aborts the client and settles stopped", async () => {
		const { client, factory } = fakeClient({ hang: true });
		const ctrl = launch(factory);
		await new Promise((r) => setTimeout(r, 5));
		ctrl.stop();
		const result = await ctrl.result();
		expect(result.status).toBe("stopped");
		expect(client.aborted).toBe(true);
	});

	it("fires onSettled for background completion notification", async () => {
		const settled: RunResult[] = [];
		const { factory } = fakeClient({ text: "ok" });
		await launch(factory, {
			onSettled: (_id: RunId, r: RunResult) => settled.push(r),
		}).result();
		expect(settled).toHaveLength(1);
		expect(settled[0].status).toBe("succeeded");
	});
});

// The host tool execute signature takes (id, params, signal?, _, ctx).
function exec(
	tool: { execute: (...a: any[]) => Promise<any> },
	params: unknown,
) {
	return tool.execute("t", params, undefined, undefined, {} as any);
}

describe("agent definitions", () => {
	it("parses frontmatter and body", () => {
		const def = parseAgentDefinition(
			'---\nname: scout\ndescription: "look around"\nprofile: restricted\nmodel: fast\n---\nYou are a scout.\nBe terse.',
			"file-name",
		);
		expect(def).toEqual({
			name: "scout",
			description: "look around",
			profile: "restricted",
			model: "fast",
			appendSystemPrompt: "You are a scout.\nBe terse.",
		});
	});

	it("falls back to the file name and a default profile", () => {
		const def = parseAgentDefinition("just a body, no frontmatter", "helper");
		expect(def.name).toBe("helper");
		expect(def.profile).toBe("restricted");
		expect(def.appendSystemPrompt).toBe("just a body, no frontmatter");
	});

	it("parseFrontmatter handles a missing block", () => {
		const fm = parseFrontmatter("no frontmatter here");
		expect(fm.fields).toEqual({});
		expect(fm.body).toBe("no frontmatter here");
	});

	it("discovers project agents over the built-ins", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-agents-"));
		writeFileSync(
			join(dir, "scout.md"),
			"---\nname: scout\nprofile: restricted\n---\nScout.",
		);
		// Override a built-in name.
		writeFileSync(
			join(dir, "worker.md"),
			"---\nname: worker\nprofile: deliverable-worker\n---\nCustom worker.",
		);
		const agents = discoverAgents(dir);
		expect(agents.scout?.profile).toBe("restricted");
		expect(agents.worker?.appendSystemPrompt).toBe("Custom worker.");
		// Built-ins still present.
		expect(agents.explore?.profile).toBe("restricted");
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns just the built-ins for a missing directory", () => {
		const agents = discoverAgents("/no/such/dir/.pi/agents");
		expect(Object.keys(agents).sort()).toEqual([
			"agent",
			"explore",
			"plan",
			"review",
		]);
	});
});

describe("supervisor protocol", () => {
	it("needDecisionMessage builds a tagged message", () => {
		const msg = needDecisionMessage(id("r1"), { question: "ship?" });
		expect(msg).toEqual({
			type: "needDecision",
			runId: "r1",
			request: { question: "ship?" },
		});
	});

	it("the child tool publishes a needDecision and reports delivery", async () => {
		const bus = createRunBus();
		const seen: RunBusMessage[] = [];
		bus.subscribe((m) => seen.push(m));
		const tool = createSupervisorTool({
			runId: () => id("r1"),
			publish: (m) => bus.publish(m),
		});
		const res: any = await exec(tool, {
			question: "merge now?",
			options: ["yes", "no"],
		});
		expect(res.details.delivered).toBe(true);
		expect(seen.find((m) => m.type === "needDecision")).toBeTruthy();
	});

	it("the child tool no-ops without a run id", async () => {
		const tool = createSupervisorTool({
			runId: () => undefined,
			publish: () => {
				throw new Error("must not publish");
			},
		});
		const res: any = await exec(tool, { question: "?" });
		expect(res.details.delivered).toBe(false);
	});

	it("the projector decides and steers the answer back to the child", async () => {
		const bus = createRunBus();
		const steered: { runId: RunId; guidance: string }[] = [];
		const dispose = attachSupervisor({
			bus,
			decide: async (_runId, req) => ({ answer: `picked:${req.question}` }),
			steer: (runId, guidance) => steered.push({ runId, guidance }),
		});
		bus.publish(needDecisionMessage(id("r1"), { question: "ship?" }));
		await new Promise((r) => setTimeout(r, 5));
		expect(steered).toEqual([{ runId: "r1", guidance: "picked:ship?" }]);
		dispose();
	});
});

describe("subagent delegate tool", () => {
	function fakeCapability() {
		const calls: string[] = [];
		const result: RunResult = { status: "succeeded", summary: "done" };
		const handle = {
			id: id("run-x"),
			status: () => "succeeded" as const,
			steer: () => {},
			stop: () => {},
			result: async () => result,
		};
		const cap = {
			spawn: (_p: string, profile: SpawnProfile) => {
				calls.push(`spawn:${profile.profile}`);
				return handle;
			},
			get: (runId: RunId) =>
				runId === "run-x" ? record({ id: id("run-x") }) : undefined,
			list: () => [record({ id: id("run-x") })],
			steer: (runId: RunId, g: string) => calls.push(`steer:${runId}:${g}`),
			stop: (runId: RunId) => calls.push(`stop:${runId}`),
		};
		return { cap, calls };
	}

	function tool(cap: any) {
		return createSubagentTool({
			capability: () => cap,
			agents: () => discoverAgents("/no/such/dir"),
		});
	}

	it("spawns a named agent foreground and returns its result", async () => {
		const { cap, calls } = fakeCapability();
		const res: any = await exec(tool(cap), {
			action: "spawn",
			agent: "agent",
			prompt: "do it",
		});
		expect(calls).toContain("spawn:deliverable-worker");
		expect(res.details.result.status).toBe("succeeded");
		expect(res.content[0].text).toContain("done");
	});

	it("spawns in background and returns the run id immediately", async () => {
		const { cap } = fakeCapability();
		const res: any = await exec(tool(cap), {
			action: "spawn",
			agent: "explore",
			prompt: "scan",
			background: true,
		});
		expect(res.details).toEqual({ runId: "run-x", background: true });
	});

	it("rejects an unknown agent", async () => {
		const { cap } = fakeCapability();
		const res: any = await exec(tool(cap), {
			action: "spawn",
			agent: "nope",
			prompt: "x",
		});
		expect(res.content[0].text).toContain("Unknown agent");
	});

	it("lists, steers, and stops", async () => {
		const { cap, calls } = fakeCapability();
		const list: any = await exec(tool(cap), { action: "status" });
		expect(list.details.runs).toHaveLength(1);
		await exec(tool(cap), {
			action: "steer",
			runId: "run-x",
			guidance: "go left",
		});
		await exec(tool(cap), { action: "stop", runId: "run-x" });
		expect(calls).toContain("steer:run-x:go left");
		expect(calls).toContain("stop:run-x");
	});

	it("reports when the capability is unavailable", async () => {
		const res: any = await exec(tool(undefined), { action: "status" });
		expect(res.content[0].text).toContain("not available");
	});
});
