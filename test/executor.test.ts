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
	const shipped: ShipRequest[] = [];
	const order: string[] = [];
	const store = createPlanStore(scratch(), {
		now: () => "2026-07-29T10:00:00.000Z",
	});
	store.savePlan(p);

	const workspace: Workspace = {
		async create(d) {
			return { path: `/worktrees/${d.id}`, branch: `feat/${d.id}` };
		},
		async remove() {},
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
			},
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
		...over,
	};

	return {
		executor: new Executor(p, deps),
		channel,
		launched,
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

	it("names the kind and persona for delegated work, never a tool", async () => {
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
		expect(kickoff).toContain("Delegate this to a reviewer");
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
