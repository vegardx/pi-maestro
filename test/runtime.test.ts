// The maestro's session: mode, the flight handshake, and narration.
//
// The flight handshake is the case to read. Plan preflight is authored prose,
// so the executor cannot perform it — it hands it back to the maestro's own
// model, which signals completion the same way a worker does. Same shape, one
// level up: the thing asked to do work says when it is done, and nothing starts
// on the assumption that it probably has.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AskInbox } from "@vegardx/pi-ask";
import { afterEach, describe, expect, it } from "vitest";
import type { Executor } from "../packages/maestro/src/executor.js";
import { AgentLink } from "../packages/maestro/src/link.js";
import type { Plan, Task } from "../packages/maestro/src/plan.js";
import {
	MaestroRuntime,
	type Narrator,
} from "../packages/maestro/src/runtime.js";

const TOKEN = "run-token";
const closers: { close(): unknown }[] = [];
const dirs: string[] = [];
const runtimes: MaestroRuntime[] = [];
afterEach(async () => {
	for (const closer of closers.splice(0)) await closer.close();
	for (const runtime of runtimes.splice(0)) await runtime.close();
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function harness(inbox?: AskInbox) {
	const said: string[] = [];
	const asked: string[] = [];
	const narrator: Narrator = {
		say: (line) => said.push(line),
		ask: (prompt) => asked.push(prompt),
	};
	const dir = mkdtempSync(join(tmpdir(), "maestro-runtime-"));
	dirs.push(dir);
	const socketPath = join(dir, "m.sock");
	const runtime = new MaestroRuntime({
		narrator,
		socketPath,
		token: TOKEN,
		...(inbox
			? {
					inbox: () =>
						({
							deliver: (q: never, settle: never) => inbox.receive(q, settle),
							open: () => inbox.open(),
							drain: (v: string) => inbox.drain(v),
						}) as never,
				}
			: {}),
	});
	runtimes.push(runtime);
	return { runtime, said, asked, socketPath };
}

const task = (id: string): Task => ({
	id,
	title: `do ${id}`,
	body: `body ${id}`,
});

const call = (tool: ToolDefinition, params: unknown) =>
	(
		tool.execute as unknown as (
			id: string,
			p: unknown,
		) => Promise<{ content: { text: string }[] }>
	)("call-1", params);

const plan = (over: Partial<Plan> = {}): Plan => ({
	slug: "arc",
	title: "Arc",
	preflight: [],
	deliverables: [],
	postflight: [],
	repos: [{ key: "main", path: "/repo" }],
	...over,
});

describe("the seat holds a mode", () => {
	it("starts in plan, where nothing can be written", () => {
		const { runtime } = harness();
		expect(runtime.mode().name).toBe("plan");
		expect(runtime.mode().cwd).toBe("read");
	});

	it("refuses to run a plan from a mode that cannot write", async () => {
		// Every deliverable produces a worker. A read-only seat producing writers
		// is the delegation hole that would make plan mode advisory.
		const { runtime } = harness();
		await expect(
			runtime.start(plan(), () => {
				throw new Error("should never be built");
			}),
		).rejects.toThrow(/cannot write/);
	});

	it("switches", () => {
		const { runtime } = harness();
		expect(runtime.setMode("hack").safeguards).toBe("off");
		expect(runtime.setMode("auto").cwd).toBe("write");
	});
});

describe("a flight is asked for, and waited on", () => {
	it("does not resolve until the maestro says it is done", async () => {
		// "Start the deliverables once preflight has probably finished" is how
		// you get a fleet of workers all failing to find a remote.
		const { runtime, asked } = harness();
		let finished = false;
		const flight = runtime
			.runMaestroTasks([task("clone"), task("configure")], "plan preflight")
			.then(() => {
				finished = true;
			});

		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("# plan preflight");
		expect(asked[0]).toContain("## 1. do clone");
		expect(asked[0]).toContain("body configure");

		await new Promise((r) => setTimeout(r, 20));
		expect(finished).toBe(false);

		await call(runtime.flightTool(), { outcome: "done" });
		await flight;
		expect(finished).toBe(true);
	});

	it("carries the reason through when the maestro could not do it", async () => {
		const { runtime } = harness();
		const flight = runtime.runMaestroTasks([task("clone")], "plan preflight");
		await call(runtime.flightTool(), {
			outcome: "failed",
			detail: "no remote configured",
		});
		await expect(flight).rejects.toThrow(/no remote configured/);
	});

	it("asks nothing when there is nothing to ask", async () => {
		// The ordinary case: a plan whose repos already exist. Making the model
		// confirm an empty list would be ceremony.
		const { runtime, asked } = harness();
		await runtime.runMaestroTasks([], "plan preflight");
		expect(asked).toEqual([]);
	});

	it("refuses a second flight while one is outstanding", async () => {
		const { runtime } = harness();
		void runtime.runMaestroTasks([task("a")], "plan preflight").catch(() => {});
		await expect(
			runtime.runMaestroTasks([task("b")], "plan postflight"),
		).rejects.toThrow(/one flight at a time/);
	});

	it("says so when nothing was waiting", async () => {
		const { runtime } = harness();
		const result = await call(runtime.flightTool(), { outcome: "done" });
		expect(result.content[0].text).toMatch(/Nothing is waiting/);
	});

	it("unblocks a flight when the session ends, rather than hanging", async () => {
		const { runtime } = harness();
		const flight = runtime.runMaestroTasks([task("a")], "plan preflight");
		await runtime.close();
		await expect(flight).rejects.toThrow(/session ended/);
	});
});

describe("narration makes a detached fleet legible", () => {
	it("reports each deliverable as it starts and lands", async () => {
		const { runtime, said } = harness();
		runtime.setMode("auto");

		const events: ((e: unknown) => void)[] = [];
		const fakeExecutor = {
			on: (listener: (e: unknown) => void) => events.push(listener),
			async start() {},
			report: () =>
				new Map([
					["api", "shipped"],
					["ui", "stranded"],
				]),
		};
		await runtime.start(plan(), () => fakeExecutor as unknown as Executor);

		const emit = (event: unknown) => {
			for (const listener of events) listener(event);
		};
		emit({
			type: "started",
			deliverable: { id: "api", title: "The HTTP surface" },
		});
		emit({
			type: "finished",
			id: "api",
			record: { state: "done", pr: 42 },
		});
		emit({
			type: "finished",
			id: "ui",
			record: { state: "failed", failure: "could not build\nstack trace" },
		});
		emit({ type: "settled" });

		expect(said[0]).toBe("Started api — The HTTP surface");
		expect(said[1]).toBe("api shipped as #42");
		// One line, not a stack trace: the record keeps the whole thing.
		expect(said[2]).toBe("ui failed: could not build");
		// Standings, not a count — "the plan ran" stops meaning "the plan is
		// done" once independent branches are allowed to finish.
		expect(said[3]).toContain("shipped: api");
		expect(said[3]).toContain("stranded: ui");
	});

	it("says plainly when a deliverable had nothing to ship", async () => {
		const { runtime, said } = harness();
		runtime.setMode("auto");
		const events: ((e: unknown) => void)[] = [];
		await runtime.start(plan(), () => {
			return {
				on: (l: (e: unknown) => void) => events.push(l),
				async start() {},
				report: () => new Map(),
			} as unknown as Executor;
		});
		for (const listener of events)
			listener({ type: "finished", id: "notes", record: { state: "done" } });
		expect(said[0]).toBe("notes shipped (nothing to ship)");
	});

	it("runs one plan at a time", async () => {
		const { runtime } = harness();
		runtime.setMode("auto");
		const build = () =>
			({
				on: () => {},
				async start() {},
				report: () => new Map(),
			}) as unknown as Executor;
		await runtime.start(plan(), build);
		await expect(runtime.start(plan(), build)).rejects.toThrow(
			/already running/,
		);
	});
});

describe("a run ends, and the seat can start another", () => {
	function fakeExecutor(): {
		executor: Executor;
		emit: (event: unknown) => void;
		stopped: string[];
	} {
		const events: ((e: unknown) => void)[] = [];
		const stopped: string[] = [];
		const executor = {
			on: (listener: (e: unknown) => void) => events.push(listener),
			async start() {},
			async stop(reason: string) {
				stopped.push(reason);
				return { slug: "arc", startedAt: "", deliverables: {} };
			},
			report: () => new Map<string, string>(),
		} as unknown as Executor;
		return {
			executor,
			emit: (event) => {
				for (const listener of events) listener(event);
			},
			stopped,
		};
	}

	it("lets go of a settled run, so a SECOND plan can run", async () => {
		// The seat could run exactly one plan per session. `start` refuses while
		// an executor is held and nothing ever released one, so the second `/run`
		// was told "a plan is already running" — false, and unrecoverable short
		// of restarting the session. Nothing caught it because every test built a
		// fresh runtime.
		const { runtime } = harness();
		runtime.setMode("auto");
		const first = fakeExecutor();
		await runtime.start(plan(), () => first.executor);
		first.emit({ type: "settled" });
		expect(runtime.running()).toBeUndefined();

		const second = fakeExecutor();
		await expect(
			runtime.start(plan(), () => second.executor),
		).resolves.toBeDefined();
	});

	it("still refuses a second plan while the first is actually running", async () => {
		const { runtime } = harness();
		runtime.setMode("auto");
		await runtime.start(plan(), () => fakeExecutor().executor);
		await expect(
			runtime.start(plan(), () => fakeExecutor().executor),
		).rejects.toThrow(/already running/);
	});

	it("stops the running plan, says what happened, and lets go", async () => {
		const { runtime, said } = harness();
		runtime.setMode("auto");
		const first = fakeExecutor();
		await runtime.start(plan(), () => first.executor);

		await runtime.stop("changed my mind");
		expect(first.stopped).toEqual(["changed my mind"]);

		first.emit({ type: "stopped", reason: "changed my mind", halted: ["api"] });
		expect(said[said.length - 1]).toContain("changed my mind");
		expect(said[said.length - 1]).toContain("api");
		expect(runtime.running()).toBeUndefined();
	});

	it("says nothing was running rather than pretending it stopped one", async () => {
		const { runtime } = harness();
		expect(await runtime.stop("why not")).toBeNull();
	});
});

describe("asking to run a second plan does not damage the first", () => {
	// `seat.run` calls `listen()` on every `/run`, before `start` can refuse.
	// `link.listen` unlinks the socket file and replaces the server, so the
	// refusal used to arrive AFTER the live run's socket had been deleted and a
	// second server bound over it. And every call added another `asked`
	// listener, so from then on a worker's question was narrated twice,
	// answered twice, and the second `respond` reported nothing was waiting.
	it("listens once, however many times it is asked", async () => {
		const { runtime } = harness();
		await runtime.listen();
		await runtime.listen();
		await runtime.listen();
		expect(runtime.link.listenerCount("asked")).toBe(1);
	});

	it("keeps the SAME socket across repeated listens", async () => {
		const { runtime, socketPath } = harness();
		await runtime.listen();
		const first = statSync(socketPath).ino;
		await runtime.listen();
		// A second bind would have unlinked this one and created another.
		expect(statSync(socketPath).ino).toBe(first);
	});

	it("narrates a worker's question exactly once", async () => {
		// Needs an inbox: with none, the runtime answers "nobody can answer this"
		// and returns before narrating, which would pass this test for the wrong
		// reason.
		const { runtime, asked, socketPath } = harness(new AskInbox());
		await runtime.listen();
		await runtime.listen();
		const agent = new AgentLink();
		closers.push(agent);
		await agent.connect(socketPath, { agentId: "worker-api", token: TOKEN });
		void agent.ask([{ id: "q", question: "null or NaN?" }]);
		await new Promise((r) => setTimeout(r, 30));
		expect(asked).toHaveLength(1);
	});
});
