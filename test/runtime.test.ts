// The maestro's session: mode, the flight handshake, and narration.
//
// The flight handshake is the case to read. Plan preflight is authored prose,
// so the executor cannot perform it — it hands it back to the maestro's own
// model, which signals completion the same way a worker does. Same shape, one
// level up: the thing asked to do work says when it is done, and nothing starts
// on the assumption that it probably has.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { Executor } from "../packages/maestro/src/executor.js";
import type { Plan, Task } from "../packages/maestro/src/plan.js";
import {
	MaestroRuntime,
	type Narrator,
} from "../packages/maestro/src/runtime.js";

const dirs: string[] = [];
const runtimes: MaestroRuntime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function harness() {
	const said: string[] = [];
	const asked: string[] = [];
	const narrator: Narrator = {
		say: (line) => said.push(line),
		ask: (prompt) => asked.push(prompt),
	};
	const dir = mkdtempSync(join(tmpdir(), "maestro-runtime-"));
	dirs.push(dir);
	const runtime = new MaestroRuntime({
		narrator,
		socketPath: join(dir, "m.sock"),
		token: "run-token",
	});
	runtimes.push(runtime);
	return { runtime, said, asked };
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
