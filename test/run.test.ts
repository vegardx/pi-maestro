// The run record: what happened, measured against what was authored.
//
// The rules here are the ones that stop a run from lying about a plan. A run
// naming a deliverable the plan never declared, a failure with no reason, a
// postflight that runs a release over a half-failed arc, a final report that
// shows "never ran because something upstream broke" and "never ran yet" as the
// same thing — each of those is a way for the record to read as more complete
// than the work actually was.

import { describe, expect, it } from "vitest";
import type { Deliverable, Plan, Task } from "../packages/maestro/src/plan.js";
import {
	beginRun,
	type DeliverableRun,
	nextDeliverables,
	type Run,
	readyForPostflight,
	runSettled,
	standings,
	validateRun,
} from "../packages/maestro/src/run.js";

const task = (id: string): Task => ({ id, title: `do ${id}` });

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
	deliverables: [],
	postflight: [],
	repos: [{ key: "main", path: "/repo" }],
	...over,
});

const T0 = "2026-07-29T10:00:00.000Z";
const T1 = "2026-07-29T11:00:00.000Z";

const running = (over: Partial<DeliverableRun> = {}): DeliverableRun => ({
	state: "running",
	startedAt: T0,
	...over,
});
const done = (over: Partial<DeliverableRun> = {}): DeliverableRun => ({
	state: "done",
	startedAt: T0,
	endedAt: T1,
	...over,
});
const failed = (reason = "tests never passed"): DeliverableRun => ({
	state: "failed",
	failure: reason,
	startedAt: T0,
	endedAt: T1,
});

const flown = { state: "done", startedAt: T0, endedAt: T1 } as const;

const run = (over: Partial<Run> = {}): Run => ({
	...beginRun("arc", T0),
	...over,
});

describe("a run cannot claim more than the plan declares", () => {
	const p = plan({ deliverables: [deliverable("api")] });

	it("rejects a record for a deliverable the plan does not have", () => {
		// Drift, exactly like a tool granted by name with nothing behind it: the
		// id resolves to nothing, and without this check nothing ever says so.
		const errors = validateRun(
			p,
			run({ deliverables: { api: done(), ghost: done() } }),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("`ghost`, which the plan does not declare"),
		);
	});

	it("rejects a run for a different plan entirely", () => {
		expect(validateRun(p, run({ slug: "other" }))).toContainEqual(
			expect.stringContaining("run is for `other`, plan is `arc`"),
		);
	});

	it("insists a failure says why", () => {
		const errors = validateRun(
			p,
			run({
				deliverables: {
					api: { state: "failed", startedAt: T0, endedAt: T1 },
				},
			}),
		);
		expect(errors).toContainEqual(
			expect.stringContaining("failed with no reason recorded"),
		);
	});

	it("catches a record whose state and timestamps disagree", () => {
		expect(
			validateRun(p, run({ deliverables: { api: running({ endedAt: T1 }) } })),
		).toContainEqual(expect.stringContaining("still running, but has an end"));
		expect(
			validateRun(
				p,
				run({
					deliverables: { api: { state: "done", startedAt: T0 } },
				}),
			),
		).toContainEqual(expect.stringContaining("done, but never ended"));
	});

	it("accepts a run that matches", () => {
		expect(
			validateRun(p, run({ preflight: flown, deliverables: { api: done() } })),
		).toEqual([]);
	});
});

describe("plan preflight is a barrier", () => {
	const p = plan({
		preflight: [task("clone")],
		deliverables: [deliverable("api"), deliverable("ui")],
	});

	it("starts nothing before it has succeeded", () => {
		// The DAG cannot say "everything waits for this" without one edge per
		// deliverable, which is one edge per chance to forget. So the gate is here.
		expect(nextDeliverables(p, run())).toEqual([]);
		expect(
			nextDeliverables(
				p,
				run({ preflight: { state: "running", startedAt: T0 } }),
			),
		).toEqual([]);
	});

	it("starts nothing when it failed", () => {
		expect(
			nextDeliverables(
				p,
				run({
					preflight: {
						state: "failed",
						failure: "no remote",
						startedAt: T0,
						endedAt: T1,
					},
				}),
			),
		).toEqual([]);
	});

	it("releases the roots once it is done", () => {
		expect(
			nextDeliverables(p, run({ preflight: flown })).map((d) => d.id),
		).toEqual(["api", "ui"]);
	});
});

describe("plan postflight is success-path only", () => {
	const p = plan({
		deliverables: [deliverable("api"), deliverable("ui")],
	});

	it("waits until every deliverable shipped", () => {
		expect(
			readyForPostflight(
				p,
				run({ preflight: flown, deliverables: { api: done() } }),
			),
		).toBe(false);
	});

	it("runs when they all did", () => {
		expect(
			readyForPostflight(
				p,
				run({ preflight: flown, deliverables: { api: done(), ui: done() } }),
			),
		).toBe(true);
	});

	it("does NOT run when one failed", () => {
		// A release, or a summary claiming the arc landed, over a plan that half
		// failed is the confidently-wrong artifact this system has produced before.
		expect(
			readyForPostflight(
				p,
				run({ preflight: flown, deliverables: { api: done(), ui: failed() } }),
			),
		).toBe(false);
	});

	it("does not run twice", () => {
		expect(
			readyForPostflight(
				p,
				run({
					preflight: flown,
					postflight: flown,
					deliverables: { api: done(), ui: done() },
				}),
			),
		).toBe(false);
	});
});

describe("the standings distinguish stranded from not-yet", () => {
	const p = plan({
		deliverables: [
			deliverable("api"),
			deliverable("ui", { after: ["api"], reads: ["api"] }),
			deliverable("docs", { after: ["ui"] }),
			deliverable("unrelated"),
		],
	});

	it("names each deliverable's fate", () => {
		const where = standings(
			p,
			run({
				preflight: flown,
				deliverables: { api: failed(), unrelated: running() },
			}),
		);
		expect(where.get("api")).toBe("failed");
		// Never ran, and never can — through `ui`, which it does not even name.
		expect(where.get("ui")).toBe("stranded");
		expect(where.get("docs")).toBe("stranded");
		expect(where.get("unrelated")).toBe("running");
	});

	it("calls not-yet-started work waiting, not stranded", () => {
		const where = standings(p, run({ preflight: flown }));
		expect([...new Set(where.values())]).toEqual(["waiting"]);
	});

	it("stores nothing about stranding — it is derived", () => {
		// The run record has no `stranded` state to set, so a stranded deliverable
		// and the failure that stranded it cannot drift apart.
		const record: DeliverableRun = failed();
		expect(record.state).not.toBe("stranded");
	});
});

describe("a run is settled when it can make no more progress", () => {
	const p = plan({
		deliverables: [
			deliverable("api"),
			deliverable("ui", { after: ["api"] }),
			deliverable("unrelated"),
		],
	});

	it("is not settled before preflight has even run", () => {
		expect(runSettled(p, run())).toBe(false);
	});

	it("is not settled while work is startable", () => {
		expect(runSettled(p, run({ preflight: flown }))).toBe(false);
	});

	it("is not settled while a deliverable is running", () => {
		expect(
			runSettled(
				p,
				run({
					preflight: flown,
					deliverables: {
						api: running(),
						unrelated: running(),
					},
				}),
			),
		).toBe(false);
	});

	it("is settled once a failure has stranded the rest", () => {
		// Independent work finished, the dependent chain never can, and there is
		// no postflight because this was not the success path.
		expect(
			runSettled(
				p,
				run({
					preflight: flown,
					deliverables: { api: failed(), unrelated: done() },
				}),
			),
		).toBe(true);
	});

	it("is not settled while postflight is still owed", () => {
		const everything = run({
			preflight: flown,
			deliverables: { api: done(), ui: done(), unrelated: done() },
		});
		expect(runSettled(p, everything)).toBe(false);
		expect(runSettled(p, { ...everything, postflight: flown })).toBe(true);
	});

	it("is settled the moment preflight fails", () => {
		expect(
			runSettled(
				p,
				run({
					preflight: {
						state: "failed",
						failure: "no remote",
						startedAt: T0,
						endedAt: T1,
					},
				}),
			),
		).toBe(true);
	});
});
