import {
	existsSync,
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
	type SubagentServiceOptions,
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

	it("the ring keeps the newest messages in order past capacity", () => {
		const bus = createRunBus(4);
		for (let i = 0; i < 10; i++) {
			bus.publish({
				type: "status",
				runId: id(`r${i}`),
				status: "queued",
				at: i,
			});
		}
		const replayed = bus.replay();
		expect(replayed).toHaveLength(4);
		expect(replayed.map((m) => (m.type === "status" ? m.at : -1))).toEqual([
			6, 7, 8, 9,
		]);
	});

	it("throttles lastEventAt persistence — no status.json rewrite per event", () => {
		// Every agentEvent/progress used to rewrite status.json (temp+rename):
		// two sync fs ops per tool start across every parallel run.
		const bus = createRunBus();
		const off = persistRunBus(bus, store);
		bus.publish({
			type: "spawn",
			run: { id: id("r1"), prompt: "go", profile: PROFILE },
		});
		bus.publish({ type: "progress", runId: id("r1"), delta: { text: "grep" } });
		const first = store.readRecord(id("r1"))?.lastEventAt;
		expect(first).toBeDefined();
		bus.publish({ type: "progress", runId: id("r1"), delta: { text: "read" } });
		bus.publish({ type: "agentEvent", runId: id("r1"), event: { type: "x" } });
		// Within the floor window the record is untouched.
		expect(store.readRecord(id("r1"))?.lastEventAt).toBe(first);
		off();
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
			profile: "deliverable-agent",
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

	it("an explicit sessionFile becomes --session and suppresses --no-session", () => {
		const inv = mapProfileToInvocation(
			{
				profile: "restricted",
				sessionFile: "/plan/research-sessions/01.jsonl",
			},
			{ repoRoot: "/repo", parentDepth: 0 },
		);
		const sIdx = inv.args.indexOf("--session");
		expect(sIdx).toBeGreaterThanOrEqual(0);
		expect(inv.args[sIdx + 1]).toBe("/plan/research-sessions/01.jsonl");
		expect(inv.args).not.toContain("--no-session");
	});

	it("resolves cwd as profile → spawner → repoRoot and bumps depth", () => {
		expect(
			mapProfileToInvocation(
				{ profile: "deliverable-agent", cwd: "/wt" },
				{ spawnerCwd: "/spawn", repoRoot: "/repo", parentDepth: 1 },
			).cwd,
		).toBe("/wt");
		expect(
			mapProfileToInvocation(
				{ profile: "deliverable-agent" },
				{ spawnerCwd: "/spawn", repoRoot: "/repo", parentDepth: 1 },
			).cwd,
		).toBe("/spawn");
		const inv = mapProfileToInvocation(
			{ profile: "deliverable-agent" },
			{ repoRoot: "/repo", parentDepth: 1 },
		);
		expect(inv.cwd).toBe("/repo");
		expect(inv.depth).toBe(2);
		expect(inv.env[DEPTH_ENV]).toBe("2");
	});

	it("research profile isolates extensions and loads extras via -e", () => {
		const r = resolveProfile({
			profile: "research",
			extraExtensions: ["/maestro/packages/research-tools/src/index.ts"],
		});
		expect(r.isolateExtensions).toBe(true);
		expect(r.session).toBe(false);
		expect(r.tools?.allow).toContain("websearch");
		expect(r.tools?.allow).toContain("context7");

		const inv = mapProfileToInvocation(
			{
				profile: "research",
				extraExtensions: ["/maestro/packages/research-tools/src/index.ts"],
			},
			{ repoRoot: "/repo", parentDepth: 0 },
		);
		// -ne drops global extensions; -e loads exactly the research tools —
		// the child's tool namespace is deterministic.
		expect(inv.args).toContain("-ne");
		const eIdx = inv.args.indexOf("-e");
		expect(eIdx).toBeGreaterThan(-1);
		expect(inv.args[eIdx + 1]).toBe(
			"/maestro/packages/research-tools/src/index.ts",
		);
	});

	it("profiles without isolation gain no extension args", () => {
		const inv = mapProfileToInvocation(
			{ profile: "restricted" },
			{ repoRoot: "/repo", parentDepth: 0 },
		);
		expect(inv.args).not.toContain("-ne");
		expect(inv.args).not.toContain("-e");
	});

	it("computes kill-switch env explicitly, never leaking the parent's", () => {
		const inv = mapProfileToInvocation(
			{
				profile: "deliverable-agent",
				featureFlags: { disable: ["modes.fanout"], enable: ["modes.x"] },
			},
			{ repoRoot: "/repo", parentDepth: 0 },
		);
		// Always set, so a parent's PI_DISABLE cannot bleed through.
		expect(inv.env.PI_DISABLE).toBe("modes.fanout");
		expect(inv.env.PI_ENABLE).toBe("modes.x");

		const plain = mapProfileToInvocation(
			{ profile: "deliverable-agent" },
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

	it("transport defaults to tmux (required); headless is an explicit choice", async () => {
		// pi-maestro requires tmux — inspectable runs are the day-one default.
		// Headless never happens silently: per profile, per service, or the
		// PI_MAESTRO_TRANSPORT=headless escape hatch only.
		const captured: LaunchRequest[] = [];
		let n = 0;
		const make = (defaultTransport?: "headless" | "tmux") =>
			new SubagentService({
				bus,
				store,
				runner: fakeRunner(captured),
				repoRoot: "/repo",
				mintId: () => `run-${++n}` as RunId,
				ownDepth: 0,
				...(defaultTransport ? { defaultTransport } : {}),
			});

		make().spawn("a", { profile: "restricted" });
		expect(captured[0].profile.transport).toBe("tmux");

		make("headless").spawn("b", { profile: "restricted" });
		expect(captured[1].profile.transport).toBe("headless");

		// An explicit profile choice beats the service default, both ways.
		make("tmux").spawn("c", { profile: "restricted", transport: "headless" });
		expect(captured[2].profile.transport).toBe("headless");
		make("headless").spawn("d", { profile: "restricted", transport: "tmux" });
		expect(captured[3].profile.transport).toBe("tmux");
	});

	it("stop on a settled run never throws (timer-callback safety)", async () => {
		// A stale timeout firing stop() after completion once escaped a timer
		// callback as an uncaught exception and killed pi (post-/handoff crash):
		// the RPC client throws synchronously once its transport is gone.
		const svc = new SubagentService({
			bus,
			store,
			runner: {
				launch(request, b): RunnerController {
					const result = { status: "succeeded" as const, summary: "ok" };
					b.publish({
						type: "status",
						runId: request.runId,
						status: "running",
						at: 1,
					});
					b.publish({ type: "result", runId: request.runId, result });
					return {
						steer: () => {},
						stop: () => {
							throw new Error("Client not started");
						},
						result: () => Promise.resolve(result),
					};
				},
			},
			repoRoot: "/repo",
			mintId: () => "run-1" as RunId,
			ownDepth: 0,
		});

		const handle = svc.spawn("do it", { profile: "restricted" });
		await handle.result();
		expect(() => handle.stop("timeout")).not.toThrow();
	});

	it("merges the childExtensions passthrough into every spawn (deduped)", () => {
		// The single seam: research, named agents, and general delegates all get
		// configured infra extensions (e.g. custom model providers) under -ne.
		const captured: LaunchRequest[] = [];
		const svc = new SubagentService({
			bus,
			store,
			runner: fakeRunner(captured),
			repoRoot: "/repo",
			mintId: () => "run-1" as RunId,
			ownDepth: 0,
			extraExtensions: () => ["/ext/provider", "/ext/tools"],
		});
		svc.spawn("go", {
			profile: "research",
			extraExtensions: ["/ext/tools", "/ext/research"],
		});
		expect(captured[0].profile.extraExtensions).toEqual([
			"/ext/tools",
			"/ext/research",
			"/ext/provider",
		]);
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
		svc.spawn("go", { profile: "deliverable-agent" });
		svc.steer("run-2" as RunId, "refocus");
		svc.stop("run-2" as RunId, "done");
		expect(steered).toEqual(["refocus"]);
		expect(stopped).toEqual(["done"]);
		expect(seen).toContain("steer");
		expect(seen).toContain("stop");
	});
});

describe("SubagentService transport fallbacks (cross-process run authority)", () => {
	// Runs owned by ANOTHER process have a store record but no in-process
	// controller here. steer/interrupt must still reach them via the persisted
	// process facts; the in-process paths above stay untouched.
	let root: string;
	let store: RunStore;
	let bus: RunBus;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-authority-"));
		store = createRunStore(root);
		bus = createRunBus();
		persistRunBus(bus, store);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const neverLaunch: AgentRunner = {
		launch() {
			throw new Error("these tests never spawn");
		},
	};

	function seed(runId: string, over: Partial<RunRecord> = {}): void {
		store.create(record({ id: id(runId), status: "running", ...over }));
	}

	function service(over: Partial<SubagentServiceOptions> = {}) {
		return new SubagentService({
			bus,
			store,
			runner: neverLaunch,
			repoRoot: "/repo",
			ownDepth: 0,
			...over,
		});
	}

	it("steer without a controller appends a well-formed line to the file bridge", () => {
		seed("run-x", {
			metadata: { transport: "tmux", tmuxSession: "maestro-run-run-x" },
		});
		const seen: string[] = [];
		bus.subscribe((m) => seen.push(m.type));

		service().steer(id("run-x"), "focus on the tests");

		const raw = readFileSync(join(root, "run-x", "rpc-input.jsonl"), "utf8");
		const lines = raw.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.type).toBe("steer");
		expect(parsed.message).toBe("focus on the tests");
		expect(typeof parsed.id).toBe("string");
		expect(parsed.id.length).toBeGreaterThan(0);
		expect(seen).toContain("steer");
	});

	it("steer fallback is a no-op for terminal and unknown runs", () => {
		seed("run-done", {
			status: "succeeded",
			metadata: { transport: "tmux", tmuxSession: "maestro-run-run-done" },
		});
		const svc = service();
		svc.steer(id("run-done"), "too late");
		expect(() => svc.steer(id("run-nope"), "nobody home")).not.toThrow();
		expect(existsSync(join(root, "run-done", "rpc-input.jsonl"))).toBe(false);
	});

	it("steer fallback engages only for the tmux transport", () => {
		seed("run-h", { metadata: { transport: "headless" } });
		service().steer(id("run-h"), "guidance");
		expect(existsSync(join(root, "run-h", "rpc-input.jsonl"))).toBe(false);
	});

	it("interrupt without a controller SIGTERMs the recorded process group", async () => {
		seed("run-y", { metadata: { transport: "tmux", processGroup: 4242 } });
		const kills: [number, string][] = [];
		const statuses: string[] = [];
		bus.subscribe((m) => {
			if (m.type === "status") statuses.push(m.status);
		});

		const result = await service({
			killProcessGroup: (pgid: number, signal: string) =>
				kills.push([pgid, signal]),
		}).interrupt(id("run-y"), "wrap up");

		expect(kills).toEqual([[4242, "SIGTERM"]]);
		expect(result.outcome).toBe("accepted");
		expect(result.targetId).toBe("run:run-y");
		expect(result.detail).toContain("no in-process controller");
		expect(statuses).toContain("interrupting");
		expect(store.readRecord(id("run-y"))?.status).toBe("interrupting");
	});

	it("interrupt fallback survives ESRCH/EPERM from the signal (already gone / not ours)", async () => {
		seed("run-y", { metadata: { transport: "tmux", processGroup: 4242 } });
		const result = await service({
			killProcessGroup: () => {
				const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
				err.code = "ESRCH";
				throw err;
			},
		}).interrupt(id("run-y"));
		expect(result.outcome).toBe("accepted");
	});

	it("interrupt without a process group sends C-c into the tmux session", async () => {
		seed("run-z", {
			metadata: { transport: "tmux", tmuxSession: "maestro-run-run-z" },
		});
		const sent: [string, string][] = [];

		const result = await service({
			killProcessGroup: () => {
				throw new Error("no process group recorded — must not be called");
			},
			tmuxSendKeys: (session: string, keys: string) =>
				sent.push([session, keys]),
		}).interrupt(id("run-z"));

		expect(sent).toEqual([["maestro-run-run-z", "C-c"]]);
		expect(result.outcome).toBe("accepted");
	});

	it("interrupt stays disconnected with no process facts at all", async () => {
		seed("run-bare");
		const svc = service({
			killProcessGroup: () => {
				throw new Error("must not signal");
			},
			tmuxSendKeys: () => {
				throw new Error("must not send keys");
			},
		});
		expect((await svc.interrupt(id("run-bare"))).outcome).toBe("disconnected");
		expect((await svc.interrupt(id("run-unknown"))).outcome).toBe(
			"disconnected",
		);
	});

	it("interrupt fallback never signals a terminal run (stale pids recycle)", async () => {
		seed("run-done", {
			status: "succeeded",
			metadata: {
				transport: "tmux",
				processGroup: 4242,
				tmuxSession: "maestro-run-run-done",
			},
		});
		const result = await service({
			killProcessGroup: () => {
				throw new Error("must not signal a settled run");
			},
			tmuxSendKeys: () => {
				throw new Error("must not send keys to a settled run");
			},
		}).interrupt(id("run-done"));
		expect(result.outcome).toBe("already-idle");
		expect(store.readRecord(id("run-done"))?.status).toBe("succeeded");
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
		emit?: { type: string; toolName?: string; message?: unknown }[];
		startError?: string;
		hang?: boolean;
		/** start() never resolves — a child wedged during transport startup. */
		startHang?: boolean;
		/** prompt() never acks — a wedged RPC request. */
		promptHang?: boolean;
		/** Simulate the child process dying (RpcClient sets exitError on exit). */
		exitError?: Error;
		captureEnv?: (env: Record<string, string> | undefined) => void;
		captureArgs?: (args: string[] | undefined) => void;
	}) {
		const listeners = new Set<(e: any) => void>();
		const emit = (e: any) => {
			for (const l of [...listeners]) l(e);
		};
		let aborted = false;
		const steers: string[] = [];
		const client = {
			exitError: opts.exitError ?? null,
			steers,
			abort: async () => {
				aborted = true;
			},
			get aborted() {
				return aborted;
			},
			start: async () => {
				if (opts.startHang) return new Promise<void>(() => {});
				if (opts.startError) throw new Error(opts.startError);
			},
			// The runner owns the idle wait now (agent_end event); the fake emits
			// its scripted events on prompt and ends the run unless told to hang.
			prompt: async () => {
				if (opts.promptHang) return new Promise<void>(() => {});
				queueMicrotask(() => {
					for (const e of opts.emit ?? []) emit(e);
					if (!opts.hang && !opts.exitError) emit({ type: "agent_end" });
				});
			},
			steer: async (m: string) => {
				steers.push(m);
			},
			stop: async () => {},
			onEvent: (l: (e: any) => void) => {
				listeners.add(l);
				return () => {
					listeners.delete(l);
				};
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

	function launch(
		factory: any,
		extra: Record<string, unknown> = {},
		profileExtra: Record<string, unknown> = {},
	) {
		const runner = createAgentRunner({
			factory,
			semaphore: createSemaphore(2),
			baseEnv: { PATH: "/usr/bin" },
			...extra,
		});
		const req = {
			runId: "run-1" as RunId,
			prompt: "go",
			profile: { profile: "deliverable-agent" as const, ...profileExtra },
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

	it("publishes the full per-turn usage delta on turn_end", async () => {
		const deltas: unknown[] = [];
		bus.subscribe((m) => {
			if (m.type === "progress" && m.delta.tokensOut !== undefined)
				deltas.push(m.delta);
		});
		const { factory } = fakeClient({
			text: "done",
			emit: [
				{
					type: "turn_end",
					message: {
						usage: {
							input: 100,
							output: 40,
							cacheRead: 900,
							cacheWrite: 50,
							cost: { total: 0.02 },
						},
					},
				},
			],
		});
		await launch(factory).result();
		expect(deltas).toEqual([
			{
				tokensIn: 100,
				tokensOut: 40,
				cacheRead: 900,
				cacheWrite: 50,
				cost: 0.02,
			},
		]);
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

	it("fails fast when the child process dies mid-run (exitError probe)", async () => {
		// RpcClient rejects pending sends on exit but never notifies onEvent
		// subscribers — the idle wait must catch a dead child via exitError
		// instead of hanging forever (or inheriting waitForIdle's 60s default).
		const { factory } = fakeClient({
			exitError: new Error("Agent process exited (code=1 signal=null)"),
		});
		const result = await launch(factory).result();
		expect(result.status).toBe("failed");
		expect(result.error).toContain("exited (code=1");
	});

	it("applies the runner timeout as the single owner when configured", async () => {
		const { factory } = fakeClient({ hang: true });
		const result = await launch(factory, { timeoutMs: 15 }).result();
		// A deadline kill settles timed-out — terminal, distinct from failed,
		// and never retried by any layer.
		expect(result.status).toBe("timed-out");
		expect(result.error).toContain("run deadline exceeded");
	});

	it("watchdog: stalls (event silence) time out the run and salvage partial text", async () => {
		// hang emits no events, so activity stays at spawn time → stall fires.
		const { factory } = fakeClient({ hang: true, text: "half an answer" });
		const result = await launch(
			factory,
			{},
			{ watchdog: { stallMs: 20 } },
		).result();
		expect(result.status).toBe("timed-out");
		expect(result.error).toContain("stalled");
		expect(result.summary).toBe("half an answer");
	});

	it("watchdog: steers at the soft deadline, hard cap times out with salvage", async () => {
		const { client, factory } = fakeClient({ hang: true, text: "loops" });
		const result = await launch(
			factory,
			{},
			{
				watchdog: {
					softMs: 15,
					hardMs: 80,
					wrapUpSteer: "wrap it up",
				},
			},
		).result();
		expect(client.steers).toEqual(["wrap it up"]);
		expect(result.status).toBe("timed-out");
		expect(result.error).toContain("hard cap");
		expect(result.summary).toBe("loops");
	});

	it("watchdog: an active run finishing on time is untouched", async () => {
		const { client, factory } = fakeClient({ text: "done fine" });
		const result = await launch(
			factory,
			{},
			{ watchdog: { stallMs: 5_000, softMs: 5_000, hardMs: 10_000 } },
		).result();
		expect(result.status).toBe("succeeded");
		expect(result.summary).toBe("done fine");
		expect(client.steers).toEqual([]);
	});

	it("interrupt salvages text, is idempotent, and settles stopped", async () => {
		const { client, factory } = fakeClient({
			hang: true,
			text: "partial work",
		});
		const ctrl = launch(factory);
		await new Promise((r) => setTimeout(r, 5));
		const first = await ctrl.interrupt?.("user interrupt");
		const second = await ctrl.interrupt?.("user interrupt");
		const result = await ctrl.result();
		expect(first?.outcome).toBe("accepted");
		expect(second?.outcome).toBe("already-interrupting");
		expect(result).toMatchObject({
			status: "stopped",
			error: "user interrupt",
			summary: "partial work",
		});
		expect(client.aborted).toBe(true);
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

	it("a wedged transport startup times out — protection exists before start()", async () => {
		const { factory } = fakeClient({ startHang: true });
		const result = await launch(factory, { startupTimeoutMs: 15 }).result();
		expect(result.status).toBe("timed-out");
		expect(result.error).toContain("startup deadline exceeded");
	});

	it("a prompt that never acks times out — protection exists before the first prompt", async () => {
		const { factory } = fakeClient({ promptHang: true });
		const result = await launch(factory, { rpcTimeoutMs: 15 }).result();
		expect(result.status).toBe("timed-out");
		expect(result.error).toContain("prompt request deadline exceeded");
	});

	it("the watchdog is armed before startup and the initial prompt", async () => {
		// No runner-level timeout at all: the per-run watchdog alone must bound
		// a child that wedges before ever answering the prompt. Before the fix,
		// start()/prompt() were awaited outside the watchdog race and this hung
		// forever.
		const { factory } = fakeClient({ promptHang: true, text: "partial" });
		const result = await launch(
			factory,
			{ rpcTimeoutMs: 60_000 }, // RPC deadline slack — the watchdog must win
			{ watchdog: { stallMs: 20 } },
		).result();
		expect(result.status).toBe("timed-out");
		expect(result.error).toContain("stalled");
	});

	it("drops the streaming delta firehose — only lifecycle events reach the bus", async () => {
		// Children emit token-by-token deltas at hundreds/sec/run; forwarding
		// them meant sync disk writes per token across every parallel run
		// (221MB of delta logs, laggy maestro — 2026-07-15 dogfood).
		const fatMessage = {
			role: "assistant",
			content: [{ type: "text", text: "x".repeat(10_000) }],
			usage: { input: 10, output: 20 },
		};
		const { factory } = fakeClient({
			text: "done",
			emit: [
				{ type: "message_start" },
				{ type: "message_update", message: fatMessage },
				{ type: "thinking_delta" },
				{ type: "text_delta" },
				{ type: "tool_execution_start", toolName: "grep" },
				{ type: "turn_end", message: fatMessage },
			],
		});
		const forwarded: string[] = [];
		let turnEndBytes = 0;
		bus.subscribe((m) => {
			if (m.type !== "agentEvent") return;
			const type = (m.event as { type?: string }).type ?? "?";
			forwarded.push(type);
			if (type === "turn_end") turnEndBytes = JSON.stringify(m.event).length;
		});
		const result = await launch(factory).result();
		expect(result.status).toBe("succeeded");
		expect(forwarded).toEqual([
			"tool_execution_start",
			"turn_end",
			"agent_end",
		]);
		// turn_end travels slimmed to usage — the 10KB body stays in the
		// child's session file, not the bus/journal.
		expect(turnEndBytes).toBeLessThan(200);
		const persisted = readFileSync(join(root, "run-1", "events.jsonl"), "utf8");
		expect(persisted).not.toContain("text_delta");
		expect(persisted).not.toContain("message_update");
		expect(persisted).not.toContain("x".repeat(100));
	});

	it("publishes the monotonic status lifecycle: starting → running → terminal", async () => {
		const statuses: string[] = [];
		bus.subscribe((m) => {
			if (m.type === "status") statuses.push(m.status);
		});
		const { factory } = fakeClient({ text: "ok" });
		const result = await launch(factory).result();
		expect(result.status).toBe("succeeded");
		expect(statuses).toEqual(["starting", "running", "succeeded"]);
		expect(store.readRecord("run-1" as RunId)?.status).toBe("succeeded");
	});

	it("interrupt publishes interrupting once and settles once; stop after settle is a no-op", async () => {
		const statuses: string[] = [];
		bus.subscribe((m) => {
			if (m.type === "status") statuses.push(m.status);
		});
		const { factory } = fakeClient({ hang: true });
		const ctrl = launch(factory);
		await new Promise((r) => setTimeout(r, 5));
		ctrl.stop();
		ctrl.stop(); // double interrupt — must not publish twice
		const result = await ctrl.result();
		expect(result.status).toBe("stopped");
		expect(statuses.filter((s) => s === "interrupting")).toHaveLength(1);
		const settledStatuses = statuses.length;
		ctrl.stop(); // after settlement — no status traffic, no throw
		expect(statuses.length).toBe(settledStatuses);
		expect(store.readRecord("run-1" as RunId)?.status).toBe("stopped");
	});

	it("a status arriving after settlement never corrupts the terminal record", async () => {
		const { factory } = fakeClient({ text: "ok" });
		await launch(factory).result();
		// e.g. an interrupt racing a natural finish — persisted store must hold.
		bus.publish({
			type: "status",
			runId: "run-1" as RunId,
			status: "interrupting",
			at: Date.now(),
		});
		expect(store.readRecord("run-1" as RunId)?.status).toBe("succeeded");
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
			join(dir, "builder.md"),
			"---\nname: builder\nprofile: deliverable-agent\n---\nCustom builder.",
		);
		const agents = discoverAgents(dir);
		expect(agents.scout?.profile).toBe("restricted");
		expect(agents.builder?.appendSystemPrompt).toBe("Custom builder.");
		// Built-ins still present.
		expect(agents.explore?.profile).toBe("restricted");
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns just the built-ins for a missing directory", () => {
		const agents = discoverAgents("/no/such/dir/.pi/agents");
		expect(Object.keys(agents).sort()).toEqual([
			"agent",
			"explore",
			"general",
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
			resolveDelegate: async (choice) => ({
				model: choice?.model ?? "anthropic/default",
				effort: choice?.effort ?? "low",
				allowedEfforts: ["low", "high"],
				models: [
					{
						id: "anthropic/default",
						facts: "200k ctx · fixed thinking",
						efforts: ["low", "high"],
						default: true,
						available: true,
					},
				],
			}),
		});
	}

	it("spawns a named agent foreground and returns its result", async () => {
		const { cap, calls } = fakeCapability();
		const res: any = await exec(tool(cap), {
			action: "spawn",
			agent: "agent",
			prompt: "do it",
		});
		expect(calls).toContain("spawn:deliverable-agent");
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
