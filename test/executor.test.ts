// The execution loop: what maestro does at both ends of a deliverable.
//
// The ordering case is the one to read. Maestro ships the branch and writes
// down the result BEFORE it releases the agent, so there is no moment where a
// result exists only in a process that is allowed to exit. The old model asked
// the agent to ship its own work, and an agent that wandered off took the
// deliverable with it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Persona,
	PersonaCatalogue,
} from "../packages/maestro/src/agent.js";
import {
	type AgentChannel,
	Executor,
	type ExecutorDeps,
	type ShipRequest,
	type Workspace,
} from "../packages/maestro/src/executor.js";
import type { Deliverable, Plan, Task } from "../packages/maestro/src/plan.js";
import type { Done } from "../packages/maestro/src/protocol.js";
import type { WorkerSpawn } from "../packages/maestro/src/spawn.js";
import { createPlanStore } from "../packages/maestro/src/store.js";
import { ToolRegistry } from "../packages/maestro/src/tool-registry.js";

const dirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "maestro-exec-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const tools = ToolRegistry.declare([
	{
		definition: defineTool({
			name: "commit",
			label: "commit",
			description: "Record a change.",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "" }], details: {} };
			},
		}),
		holders: ["worker"],
	},
]);

const workerPersona: Persona = {
	id: "deliverable-worker",
	kind: "worker",
	title: "Deliverable worker",
	prose: "Finish the work in front of you, and say what you produced.",
};
const personas = PersonaCatalogue.declare([workerPersona], tools);

const task = (id: string, over: Partial<Task> = {}): Task => ({
	id,
	title: `do ${id}`,
	...over,
});

const deliverable = (
	id: string,
	over: Partial<Deliverable> = {},
): Deliverable => ({
	id,
	title: `Deliverable ${id}`,
	after: [],
	reads: [],
	tasks: [task(`${id}-1`)],
	...over,
});

const plan = (over: Partial<Plan> = {}): Plan => ({
	slug: "arc",
	title: "Arc",
	preflight: [],
	deliverables: [deliverable("api")],
	postflight: [],
	repos: [{ key: "main", path: "/repo" }],
	...over,
});

/** A channel the test drives by hand, standing in for real agents. */
class FakeChannel implements AgentChannel {
	readonly released: string[] = [];
	private readonly done: ((id: string, d: Done) => void)[] = [];
	private readonly gone: ((id: string, awaiting: boolean) => void)[] = [];

	on(event: string, listener: (...args: never[]) => void): unknown {
		if (event === "done") this.done.push(listener as never);
		if (event === "disconnected") this.gone.push(listener as never);
		return this;
	}

	release(agentId: string): boolean {
		this.released.push(agentId);
		return true;
	}

	async reports(agentId: string, result: Omit<Done, "type">): Promise<void> {
		for (const listener of this.done)
			listener(agentId, { type: "done", ...result });
		await tick();
	}

	async vanishes(agentId: string, awaitingRelease = false): Promise<void> {
		for (const listener of this.gone) listener(agentId, awaitingRelease);
		await tick();
	}
}

const tick = () => new Promise((r) => setTimeout(r, 0));

interface Harness {
	readonly executor: Executor;
	readonly channel: FakeChannel;
	readonly launched: WorkerSpawn[];
	readonly killed: string[];
	readonly killedPids: number[];
	/** The worker's process exits. Nothing else makes `settled` resolve. */
	exits(agentId: string): Promise<void>;
	readonly shipped: ShipRequest[];
	readonly order: string[];
	readonly deps: ExecutorDeps;
}

function harness(
	p: Plan,
	over: Partial<ExecutorDeps> & { readonly failShip?: boolean } = {},
): Harness {
	const channel = new FakeChannel();
	const launched: WorkerSpawn[] = [];
	const killed: string[] = [];
	const killedPids: number[] = [];
	const shipped: ShipRequest[] = [];
	// A process that has not exited yet. The fake used to resolve `settled`
	// IMMEDIATELY, which is not what a running worker does — and that fiction
	// hid the gap this harness change exists to expose: nothing watched the
	// process at all, only the socket. One promise per agent, because both
	// `watchProcess` and `recordSilentDeath` await it.
	const exits = new Map<string, { promise: Promise<void>; exit: () => void }>();
	const exitOf = (agentId: string) => {
		let entry = exits.get(agentId);
		if (!entry) {
			let exit!: () => void;
			const promise = new Promise<void>((resolve) => {
				exit = resolve;
			});
			entry = { promise, exit };
			exits.set(agentId, entry);
		}
		return entry;
	};
	const order: string[] = [];
	const store = createPlanStore(scratch(), {
		now: () => "2026-07-29T10:00:00.000Z",
	});
	store.savePlan(p);

	const workspace: Workspace = {
		async create(d) {
			return { path: `/worktrees/${d.id}`, branch: `feat/${d.id}` };
		},
	};

	const deps: ExecutorDeps = {
		store: {
			...store,
			saveRun(run) {
				order.push(`save:${JSON.stringify(Object.keys(run.deliverables))}`);
				store.saveRun(run);
			},
		},
		link: {
			on: (...args: never[]) =>
				(channel.on as (...a: never[]) => unknown)(...args),
			release: (id: string) => {
				order.push(`release:${id}`);
				return channel.release(id);
			},
		} as AgentChannel,
		launcher: {
			launch: (spawn) => {
				launched.push(spawn);
				return 10_000 + launched.length;
			},
			kill: (agentId: string) => {
				killed.push(agentId);
			},
			settled: (agentId: string) => exitOf(agentId).promise,
			capture: () => "TypeError: cannot read property of undefined",
		},
		workspace,
		shipping: {
			async ship(request) {
				order.push(`ship:${request.deliverable.id}`);
				if (over.failShip) throw new Error("remote rejected the push");
				shipped.push(request);
				return 42;
			},
		},
		tools,
		personas,
		workerPersona: "deliverable-worker",
		socketPath: "/tmp/m.sock",
		token: "run-token",
		extensions: ["/repo/packages/maestro"],
		async runMaestroTasks() {},
		now: () => "2026-07-29T10:00:00.000Z",
		sessionFileFor: (id) => `/sessions/${id}.jsonl`,
		// No pid is alive unless a test says so — the harness never launches a
		// real process, so anything else would be inventing one.
		isAlive: () => false,
		killPid: (pid: number) => {
			killedPids.push(pid);
		},
		...over,
	};

	return {
		executor: new Executor(p, deps),
		channel,
		launched,
		killed,
		killedPids,
		exits: async (agentId: string) => {
			exitOf(agentId).exit();
			await tick();
		},
		shipped,
		order,
		deps,
	};
}

describe("plan preflight gates everything", () => {
	it("launches nothing until it has succeeded", async () => {
		const h = harness(plan({ preflight: [task("clone")] }), {
			async runMaestroTasks() {
				throw new Error("no remote configured");
			},
		});
		await h.executor.start();
		expect(h.launched).toEqual([]);
		expect(h.executor.state().preflight?.state).toBe("failed");
		expect(h.executor.state().preflight?.failure).toBe("no remote configured");
	});

	it("releases the roots once it has", async () => {
		const h = harness(
			plan({ deliverables: [deliverable("api"), deliverable("ui")] }),
		);
		await h.executor.start();
		expect(h.launched.map((s) => s.agentId)).toEqual([
			"worker-api",
			"worker-ui",
		]);
	});
});

describe("what a worker is told", () => {
	it("gets its persona, its generated tools, and its work in order", async () => {
		const h = harness(
			plan({
				deliverables: [
					deliverable("api", {
						body: "The HTTP surface.",
						tasks: [task("design"), task("build")],
					}),
				],
			}),
		);
		await h.executor.start();
		const kickoff = h.launched[0].kickoff;
		expect(kickoff).toContain("Finish the work in front of you");
		expect(kickoff).toContain("## Your tools");
		expect(kickoff).toContain("- commit —");
		expect(kickoff).toContain("The HTTP surface.");
		expect(kickoff).toContain("### 1. do design");
		expect(kickoff).toContain("### 2. do build");
	});

	it("names the kind and persona for subagent work, never a tool", async () => {
		const h = harness(
			plan({
				deliverables: [
					deliverable("api", {
						tasks: [
							task("review", {
								by: {
									agent: "reviewer",
									persona: "security-review",
									fanOut: true,
								},
							}),
						],
					}),
				],
			}),
		);
		await h.executor.start();
		const kickoff = h.launched[0].kickoff;
		expect(kickoff).toContain("Hand this to a reviewer subagent");
		expect(kickoff).toContain("`security-review`");
		expect(kickoff).toContain("across several model families");
	});

	it("inherits only what it declared it reads", async () => {
		// `after` is ordering. A deliverable that merely waited for something
		// should not pay for its predecessor's whole hand-off in context.
		const p = plan({
			deliverables: [
				deliverable("api"),
				deliverable("infra"),
				deliverable("ui", { after: ["api", "infra"], reads: ["api"] }),
			],
		});
		const h = harness(p);
		await h.executor.start();
		await h.channel.reports("worker-api", {
			outcome: "succeeded",
			handoff: "POST /v1/things",
		});
		await h.channel.reports("worker-infra", {
			outcome: "succeeded",
			handoff: "the cluster is at 10.0.0.1",
		});

		const ui = h.launched.find((s) => s.agentId === "worker-ui");
		expect(ui?.kickoff).toContain("POST /v1/things");
		expect(ui?.kickoff).not.toContain("10.0.0.1");
	});
});

describe("maestro collects, ships, records, and only then releases", () => {
	it("does all four, in that order", async () => {
		// The ordering IS the guarantee. Released any earlier and the result
		// exists only inside a process that is allowed to exit.
		const h = harness(plan());
		await h.executor.start();
		await h.channel.reports("worker-api", {
			outcome: "succeeded",
			handoff: "it is done",
		});

		const shipAt = h.order.indexOf("ship:api");
		const releaseAt = h.order.indexOf("release:worker-api");
		const saveAfterShip = h.order.findIndex(
			(step, i) => i > shipAt && step.startsWith("save:"),
		);
		expect(shipAt).toBeGreaterThanOrEqual(0);
		expect(saveAfterShip).toBeGreaterThan(shipAt);
		expect(releaseAt).toBeGreaterThan(saveAfterShip);

		const record = h.executor.state().deliverables.api;
		expect(record.state).toBe("done");
		expect(record.handoff).toBe("it is done");
		expect(record.pr).toBe(42);
		expect(h.shipped[0].branch).toBe("feat/api");
	});

	it("fails the deliverable when the push fails, and still lets the agent go", async () => {
		const h = harness(plan(), { failShip: true });
		await h.executor.start();
		await h.channel.reports("worker-api", { outcome: "succeeded" });

		const record = h.executor.state().deliverables.api;
		expect(record.state).toBe("failed");
		expect(record.failure).toMatch(/shipping: remote rejected the push/);
		// Otherwise it sits waiting for a release that is never coming.
		expect(h.channel.released).toEqual(["worker-api"]);
	});

	it("records a worker's own failure with its reason", async () => {
		const h = harness(plan());
		await h.executor.start();
		await h.channel.reports("worker-api", {
			outcome: "failed",
			failure: "the tests never passed",
		});
		expect(h.executor.state().deliverables.api.failure).toBe(
			"the tests never passed",
		);
		expect(h.shipped).toEqual([]);
	});

	it("keeps what a worker that died mid-body printed", async () => {
		const h = harness(plan());
		await h.executor.start();
		await h.channel.vanishes("worker-api");
		// A socket closes the instant a process starts dying; its stderr and exit
		// status arrive with the exit that follows. Reading at socket-close got an
		// empty buffer and reported a death with no cause, which a live drive then
		// made us diagnose by hand. So nothing is recorded until the process is
		// actually reaped — which the harness now models rather than pretending
		// every worker exits the moment it starts.
		await h.exits("worker-api");
		const record = h.executor.state().deliverables.api;
		expect(record.state).toBe("failed");
		expect(record.failure).toContain("stopped without reporting");
		// Without the capture the failure reads as "the agent did nothing".
		expect(record.failure).toContain("TypeError");
	});

	it("does not lose a result when the worker dies while maestro is pushing", async () => {
		// The window the `awaitingRelease` flag exists for: maestro has the whole
		// result and is mid-push when the worker's process goes. That is a crash
		// AFTER reporting, and treating it like one during the work would throw
		// away a deliverable that actually succeeded.
		let releaseShip: () => void = () => {};
		const pushing = new Promise<void>((r) => {
			releaseShip = r;
		});
		const h = harness(plan(), {
			shipping: {
				async ship() {
					await pushing;
					return 42;
				},
			},
		});
		await h.executor.start();

		const collected = new Promise<void>((resolve) =>
			h.executor.on((event) => {
				if (event.type === "finished") resolve();
			}),
		);
		await h.channel.reports("worker-api", {
			outcome: "succeeded",
			handoff: "it is done",
		});
		// The record still says "running": the push is in flight, and this is the
		// moment the worker's process goes.
		expect(h.executor.state().deliverables.api.state).toBe("running");
		await h.channel.vanishes("worker-api", true);
		releaseShip();
		await collected;

		const record = h.executor.state().deliverables.api;
		expect(record.state).toBe("done");
		expect(record.handoff).toBe("it is done");
	});
});

describe("a failure stops its dependents and nothing else", () => {
	const p = plan({
		deliverables: [
			deliverable("api"),
			deliverable("ui", { after: ["api"], reads: ["api"] }),
			deliverable("unrelated"),
		],
	});

	it("lets independent work finish", async () => {
		const h = harness(p);
		await h.executor.start();
		expect(h.launched.map((s) => s.agentId).sort()).toEqual([
			"worker-api",
			"worker-unrelated",
		]);

		await h.channel.reports("worker-api", {
			outcome: "failed",
			failure: "could not build",
		});
		// `ui` is stranded and never starts; `unrelated` was already running.
		expect(h.launched.map((s) => s.agentId)).not.toContain("worker-ui");
		expect(h.executor.report().get("ui")).toBe("stranded");
		expect(h.executor.report().get("unrelated")).toBe("running");
	});
});

describe("plan postflight is success-path only", () => {
	const p = plan({
		deliverables: [deliverable("api"), deliverable("ui")],
		postflight: [task("release")],
	});

	it("runs once everything shipped", async () => {
		const ran: string[] = [];
		const h = harness(p, {
			async runMaestroTasks(_tasks, where) {
				ran.push(where);
			},
		});
		await h.executor.start();
		await h.channel.reports("worker-api", { outcome: "succeeded" });
		await h.channel.reports("worker-ui", { outcome: "succeeded" });
		expect(ran).toEqual(["plan preflight", "plan postflight"]);
		expect(h.executor.state().postflight?.state).toBe("done");
	});

	it("does not run when one failed", async () => {
		// A release, or a summary claiming the arc landed, over a plan that half
		// failed is the confidently-wrong artifact this system has produced.
		const ran: string[] = [];
		const h = harness(p, {
			async runMaestroTasks(_tasks, where) {
				ran.push(where);
			},
		});
		await h.executor.start();
		await h.channel.reports("worker-api", { outcome: "succeeded" });
		await h.channel.reports("worker-ui", {
			outcome: "failed",
			failure: "nope",
		});
		expect(ran).toEqual(["plan preflight"]);
		expect(h.executor.state().postflight).toBeUndefined();
	});
});

describe("the run survives the maestro", () => {
	it("picks up a run already on disk rather than starting over", async () => {
		const p = plan({ deliverables: [deliverable("api"), deliverable("ui")] });
		const first = harness(p);
		await first.executor.start();
		await first.channel.reports("worker-api", {
			outcome: "succeeded",
			handoff: "done",
		});

		// A second executor over the same store: `api` already shipped, so it is
		// never relaunched.
		const second = new Executor(p, first.deps);
		await second.start();
		expect(second.state().deliverables.api.state).toBe("done");
		expect(
			first.launched.filter((s) => s.agentId === "worker-api"),
		).toHaveLength(1);
	});
});

describe("stopping a run", () => {
	// The verb the rebuilt system had no code for at all. `MaestroLink.shutdown`
	// existed and nothing called it; there was no way to halt a plan short of
	// killing the maestro process.
	it("kills what is in flight and launches nothing more", async () => {
		const h = harness(
			plan({
				deliverables: [
					deliverable("api"),
					deliverable("ui", { after: ["api"], reads: ["api"] }),
				],
			}),
		);
		await h.executor.start();
		expect(h.launched.map((s) => s.agentId)).toEqual(["worker-api"]);

		await h.executor.stop("changed my mind");
		expect(h.killed).toEqual(["worker-api"]);

		// `ui` was never released by `api` succeeding, and advancing again must
		// not quietly resume the plan.
		await h.executor.advance();
		expect(h.launched.map((s) => s.agentId)).toEqual(["worker-api"]);
	});

	it("leaves a halted deliverable UNSTARTED, not failed", async () => {
		// Both alternatives are wrong in a way that only shows up later. Marking
		// it `failed` strands every dependent for a reason that never happened;
		// leaving it `running` puts it in `startedIds` forever, so the next run
		// skips it and the plan can never complete. Absent means unstarted, and
		// unstarted is what it now is.
		const h = harness(plan({ deliverables: [deliverable("api")] }));
		await h.executor.start();
		expect(h.executor.state().deliverables.api?.state).toBe("running");

		await h.executor.stop("enough for today");
		expect(h.executor.state().deliverables.api).toBeUndefined();
	});

	it("resumes into the same worktree instead of starting the work over", async () => {
		const p = plan({ deliverables: [deliverable("api")] });
		const first = harness(p);
		await first.executor.start();
		await first.executor.stop("enough for today");

		// A fresh executor over the same store relaunches `api` — and the
		// workspace answers with the checkout that already exists, so whatever
		// the worker committed before the stop is still under it.
		const second = new Executor(p, first.deps);
		await second.start();
		expect(first.launched.map((s) => s.agentId)).toEqual([
			"worker-api",
			"worker-api",
		]);
		expect(first.launched[1].cwd).toBe(first.launched[0].cwd);
	});

	it("reports what it halted, so the seat can say so", async () => {
		const h = harness(plan({ deliverables: [deliverable("api")] }));
		const seen: string[] = [];
		h.executor.on((event) => {
			if (event.type === "stopped") seen.push(event.halted.join(","));
		});
		await h.executor.start();
		await h.executor.stop("why not");
		expect(seen).toEqual(["api"]);
	});

	it("stops a run that never launched anything without inventing a casualty", async () => {
		const h = harness(plan({ deliverables: [deliverable("api")] }));
		const seen: string[][] = [];
		h.executor.on((event) => {
			if (event.type === "stopped") seen.push([...event.halted]);
		});
		await h.executor.stop("before it began");
		expect(seen).toEqual([[]]);
		expect(h.killed).toEqual([]);
	});
});

describe("taking over a run its maestro did not survive", () => {
	// A live drive found this: the maestro was SIGKILLed with a worker in
	// flight, a new one was started over the same store, and `/run` launched
	// nothing and SAID nothing. A `running` record sits in `startedIds`
	// forever, so the deliverable is never picked up again and the plan can
	// never complete — while the seat looks merely idle.
	it("relaunches a deliverable left in flight instead of wedging", async () => {
		const p = plan({ deliverables: [deliverable("api")] });
		const first = harness(p);
		await first.executor.start();
		expect(first.executor.state().deliverables.api?.state).toBe("running");

		// The maestro dies here. A new executor over the same store:
		const second = new Executor(p, first.deps);
		await second.start();
		expect(first.launched.map((s) => s.agentId)).toEqual([
			"worker-api",
			"worker-api",
		]);
		expect(second.state().deliverables.api?.state).toBe("running");
	});

	it("ends an orphan still running before relaunching beside it", async () => {
		// Its socket died with its maestro, so it can never report and never be
		// released — but it can still commit. Two workers on one branch is the
		// thing to avoid, and the recorded pid is the only way to know.
		const p = plan({ deliverables: [deliverable("api")] });
		const first = harness(p, { isAlive: () => true });
		await first.executor.start();
		const pid = first.executor.state().deliverables.api?.pid;
		expect(pid).toBe(10_001);

		const second = new Executor(p, first.deps);
		await second.start();
		expect(first.killedPids).toEqual([pid]);
	});

	it("does not kill a pid that is already gone", async () => {
		const p = plan({ deliverables: [deliverable("api")] });
		const first = harness(p); // isAlive: () => false
		await first.executor.start();
		await new Executor(p, first.deps).start();
		expect(first.killedPids).toEqual([]);
	});

	it("says what it picked up, so a restart is never silent", async () => {
		const p = plan({ deliverables: [deliverable("api")] });
		const first = harness(p, { isAlive: () => true });
		await first.executor.start();

		const second = new Executor(p, first.deps);
		const seen: { relaunched: readonly string[]; killed: readonly string[] }[] =
			[];
		second.on((event) => {
			if (event.type === "reclaimed")
				seen.push({ relaunched: event.relaunched, killed: event.killed });
		});
		await second.start();
		expect(seen).toEqual([{ relaunched: ["api"], killed: ["api"] }]);
	});

	it("leaves a finished run alone", async () => {
		// Reclaiming is for `running` records only. A run that completed must not
		// be re-entered because a second executor happened to be built over it.
		const p = plan({ deliverables: [deliverable("api")] });
		const first = harness(p);
		await first.executor.start();
		await first.channel.reports("worker-api", {
			outcome: "succeeded",
			handoff: "built",
		});

		const second = new Executor(p, first.deps);
		const seen: string[] = [];
		second.on((event) => {
			if (event.type === "reclaimed") seen.push("reclaimed");
		});
		await second.start();
		expect(seen).toEqual([]);
		expect(second.state().deliverables.api?.state).toBe("done");
		expect(
			first.launched.filter((s) => s.agentId === "worker-api"),
		).toHaveLength(1);
	});
});

describe("a run that cannot move says so", () => {
	// The failure this closes was SILENCE. A maestro killed during plan
	// preflight leaves `preflight: {state:"running"}`; on restart `start()`
	// skips it (no longer undefined), `nextDeliverables` returns nothing (it
	// gates on preflight being done), nothing settles, and NO EVENT is emitted.
	// `/run` launched nothing and narrated nothing, forever.
	it("reports a plan preflight left running by a maestro that is gone", async () => {
		const p = plan({ deliverables: [deliverable("api")] });
		const first = harness(p, {
			async runMaestroTasks() {
				// Never returns: the maestro dies mid-preflight.
				await new Promise(() => {});
			},
			preflight: [task("clone")],
		} as never);
		void first.executor.start();
		await tick();
		expect(first.executor.state().preflight?.state).toBe("running");

		const second = new Executor(p, first.deps);
		const seen: string[] = [];
		second.on((event) => {
			if (event.type === "stuck") seen.push(event.reason);
		});
		await second.start();
		expect(first.launched).toEqual([]);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("plan preflight was left running");
	});

	it("says nothing while the run is simply working", async () => {
		const h = harness(plan({ deliverables: [deliverable("api")] }));
		const seen: string[] = [];
		h.executor.on((event) => {
			if (event.type === "stuck") seen.push(event.reason);
		});
		await h.executor.start();
		// `api` is running — busy is not stuck.
		expect(seen).toEqual([]);
	});

	it("says nothing when the run simply finished", async () => {
		const h = harness(plan({ deliverables: [deliverable("api")] }));
		const seen: string[] = [];
		h.executor.on((event) => {
			if (event.type === "stuck") seen.push(event.reason);
		});
		await h.executor.start();
		await h.channel.reports("worker-api", {
			outcome: "succeeded",
			handoff: "done",
		});
		expect(seen).toEqual([]);
	});

	it("says nothing when a failure stranded the rest — that is settled", async () => {
		// A stranded plan HAS finished; it just finished badly. Reporting it as
		// stuck would turn every ordinary failure into an alarm.
		const h = harness(
			plan({
				deliverables: [
					deliverable("api"),
					deliverable("ui", { after: ["api"], reads: ["api"] }),
				],
			}),
		);
		const seen: string[] = [];
		h.executor.on((event) => {
			if (event.type === "stuck") seen.push(event.reason);
		});
		await h.executor.start();
		await h.channel.reports("worker-api", {
			outcome: "failed",
			failure: "could not build",
		});
		expect(seen).toEqual([]);
	});
});

describe("the launcher's contract says what the caller needs", () => {
	it("records the pid the launcher returned", async () => {
		// `WorkerHandle.launch` was typed `void` while the executor wrote its
		// return value into the record as the pid. Void-return bivariance made
		// both that and a conforming no-return implementation typecheck clean —
		// and the latter would record `pid: undefined` on every deliverable,
		// disabling the orphan kill in `reclaim()`.
		const h = harness(plan({ deliverables: [deliverable("api")] }));
		await h.executor.start();
		expect(h.executor.state().deliverables.api?.pid).toBe(10_001);
	});
});

describe("a worker that dies before it ever connects", () => {
	// The gap with NO sensor. `disconnected` only fires for a worker that
	// completed its handshake — the link does not know a socket exists until
	// then. So pi failing to start, a bad extension path, or a crash during
	// load produced no wire event at all: the deliverable stayed `running`
	// forever, the run never settled, and nothing was narrated. The launcher
	// held the exit status and the stderr the whole time and nothing read them.
	it("records the failure, with what the process printed", async () => {
		const h = harness(plan({ deliverables: [deliverable("api")] }));
		await h.executor.start();
		expect(h.executor.state().deliverables.api?.state).toBe("running");

		// It never connects. It just dies.
		await h.exits("worker-api");

		const record = h.executor.state().deliverables.api;
		expect(record?.state).toBe("failed");
		expect(record?.failure).toContain("stopped without reporting");
		// The evidence that was being thrown away.
		expect(record?.failure).toContain("TypeError");
	});

	it("lets the plan carry on past it rather than hanging", async () => {
		// The cost of the silence was not one lost deliverable — it was that
		// nothing after it could ever run, and nothing said why.
		const h = harness(
			plan({ deliverables: [deliverable("api"), deliverable("ui")] }),
		);
		await h.executor.start();
		await h.exits("worker-api");
		await h.channel.reports("worker-ui", {
			outcome: "succeeded",
			handoff: "built",
		});
		expect(h.executor.state().deliverables.api?.state).toBe("failed");
		expect(h.executor.state().deliverables.ui?.state).toBe("done");
	});

	it("does not record a SECOND failure when the socket closes too", async () => {
		// A worker that dies mid-body trips both sensors. Whichever arrives
		// second must not write over the first — the failure text and the
		// endedAt of the real cause are what a person reads.
		const h = harness(plan({ deliverables: [deliverable("api")] }));
		await h.executor.start();
		await h.channel.vanishes("worker-api");
		await h.exits("worker-api");
		await tick();
		const finished = h.order.filter((entry) => entry.startsWith("release:"));
		expect(finished).toEqual(["release:worker-api"]);
	});

	it("says nothing about a worker that exited AFTER reporting", async () => {
		const h = harness(plan({ deliverables: [deliverable("api")] }));
		await h.executor.start();
		await h.channel.reports("worker-api", {
			outcome: "succeeded",
			handoff: "built",
		});
		// The ordinary exit, once released.
		await h.exits("worker-api");
		expect(h.executor.state().deliverables.api?.state).toBe("done");
	});
});

describe("two workers finishing at once", () => {
	// `collect` runs as `void this.collect(...)` and awaits a push and a `gh`
	// call — seconds. Two workers finishing in that window gave two overlapping
	// `advance` calls. Both read the same run state, both saw the same successor
	// ready, and both called `workspace.create` on one worktree; whichever lost
	// wrote `failed` over the `running` record the winner had just written —
	// stranding dependents while a live worker was still building it, and its
	// eventual `done` was dropped because the record no longer agreed.
	it("launches the shared successor exactly once", async () => {
		let release!: () => void;
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness(
			plan({
				deliverables: [
					deliverable("a"),
					deliverable("b"),
					// Ready as soon as `a` lands — so `b` finishing moments later
					// finds it ready again if nothing serialises the two.
					deliverable("c", { after: ["a"], reads: ["a"] }),
				],
			}),
			{
				workspace: {
					async create(d) {
						// The window. Real `git worktree add` takes long enough.
						if (d.id === "c") await slow;
						return { path: `/worktrees/${d.id}`, branch: `feat/${d.id}` };
					},
				},
			},
		);
		await h.executor.start();

		// Both roots report while `c`'s worktree is still being created.
		const first = h.channel.reports("worker-a", {
			outcome: "succeeded",
			handoff: "a done",
		});
		const second = h.channel.reports("worker-b", {
			outcome: "succeeded",
			handoff: "b done",
		});
		await tick();
		release();
		await Promise.all([first, second]);
		await tick();

		expect(h.launched.filter((s) => s.agentId === "worker-c")).toHaveLength(1);
		expect(h.executor.state().deliverables.c?.state).toBe("running");
		expect(h.executor.state().deliverables.c?.failure).toBeUndefined();
	});
});
