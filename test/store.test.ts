// Persistence: what may reach disk, and what must not.
//
// The store is the last place an invalid plan can be stopped cheaply. Past it,
// an authoring bug stops being an error message and becomes a run-time mystery
// several days later — a deliverable with no tasks rendering an empty brief to
// a live agent, a run naming ids that resolve to nothing.

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
import type { Deliverable, Plan, Task } from "../packages/maestro/src/plan.js";
import { beginRun, type Run } from "../packages/maestro/src/run.js";
import {
	createPlanStore,
	InvalidStateError,
	MAESTRO_SCHEMA_VERSION,
	StoreError,
	UnsupportedStateError,
} from "../packages/maestro/src/store.js";

const roots: string[] = [];
function root(): string {
	const dir = mkdtempSync(join(tmpdir(), "maestro-store-"));
	roots.push(dir);
	return dir;
}
afterEach(() => {
	while (roots.length > 0)
		rmSync(roots.pop() as string, { recursive: true, force: true });
});

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
	deliverables: [deliverable("api")],
	postflight: [],
	repos: [{ key: "main", path: "/repo" }],
	...over,
});

const T0 = "2026-07-29T10:00:00.000Z";
const T1 = "2026-07-29T11:00:00.000Z";

const store = (dir: string, at = T0) => createPlanStore(dir, { now: () => at });

describe("nothing invalid reaches disk", () => {
	it("refuses a plan the model rejects, and says everything wrong with it", () => {
		const s = store(root());
		try {
			s.savePlan(plan({ deliverables: [deliverable("a", { tasks: [] })] }));
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidStateError);
			expect((error as InvalidStateError).errors).toContainEqual(
				expect.stringContaining("no tasks"),
			);
		}
		expect(s.exists("arc")).toBe(false);
	});

	it("refuses a run that does not check out against the stored plan", () => {
		const s = store(root());
		s.savePlan(plan());
		const rogue: Run = {
			...beginRun("arc", T0),
			deliverables: { ghost: { state: "done", startedAt: T0, endedAt: T1 } },
		};
		expect(() => s.saveRun(rogue)).toThrow(InvalidStateError);
		expect(s.loadRun("arc")).toBeNull();
	});

	it("refuses a run with no plan to measure it against", () => {
		const s = store(root());
		expect(() => s.saveRun(beginRun("arc", T0))).toThrow(/save the plan first/);
	});
});

describe("a plan and its run round-trip", () => {
	it("comes back as it went in", () => {
		const s = store(root());
		const p = plan({
			deliverables: [
				deliverable("api"),
				deliverable("ui", { after: ["api"], reads: ["api"] }),
			],
		});
		s.savePlan(p);
		expect(s.loadPlan("arc")).toEqual(p);

		const r: Run = {
			...beginRun("arc", T0),
			preflight: { state: "done", startedAt: T0, endedAt: T1 },
			deliverables: {
				api: {
					state: "done",
					startedAt: T0,
					endedAt: T1,
					worktree: "/w/api",
					branch: "feat/api",
					pr: 7,
					handoff: "the endpoint is at /v1/things",
				},
			},
		};
		s.saveRun(r);
		expect(s.loadRun("arc")).toEqual(r);
	});

	it("keeps the run in its own file, so writing it cannot damage the plan", () => {
		const dir = root();
		const s = store(dir);
		s.savePlan(plan());
		s.saveRun(beginRun("arc", T0));
		expect(readFileSync(join(dir, "arc", "plan.json"), "utf8")).toContain(
			'"title": "Arc"',
		);
		expect(readFileSync(join(dir, "arc", "run.json"), "utf8")).not.toContain(
			'"title"',
		);
	});

	it("answers null for a plan that was never written", () => {
		const s = store(root());
		expect(s.loadPlan("arc")).toBeNull();
		expect(s.loadRun("arc")).toBeNull();
	});

	it("keeps persistence metadata out of the plan itself", () => {
		// `Plan` has no schemaVersion or savedAt field, and gains none by being
		// stored — the envelope carries them.
		const dir = root();
		store(dir).savePlan(plan());
		const raw = JSON.parse(readFileSync(join(dir, "arc", "plan.json"), "utf8"));
		expect(raw.schemaVersion).toBe(MAESTRO_SCHEMA_VERSION);
		expect(raw.savedAt).toBe(T0);
		expect(raw.body.schemaVersion).toBeUndefined();
		expect(raw.body.savedAt).toBeUndefined();
	});
});

describe("state written by another version is refused, never guessed at", () => {
	it("throws on a schema it does not speak", () => {
		const dir = root();
		const s = store(dir);
		s.savePlan(plan());
		writeFileSync(
			join(dir, "arc", "plan.json"),
			JSON.stringify({ schemaVersion: 99, savedAt: T0, body: plan() }),
		);
		expect(() => s.loadPlan("arc")).toThrow(UnsupportedStateError);
	});

	it("throws on a file with no envelope at all", () => {
		const dir = root();
		const s = store(dir);
		s.savePlan(plan());
		// An old-model plan: the body where the envelope should be.
		writeFileSync(join(dir, "arc", "plan.json"), JSON.stringify(plan()));
		expect(() => s.loadPlan("arc")).toThrow(/missing/);
	});

	it("distinguishes corrupt from absent", () => {
		// Answering `null` to a truncated file would read as "nothing here yet"
		// and quietly start the work over.
		const dir = root();
		const s = store(dir);
		s.savePlan(plan());
		writeFileSync(join(dir, "arc", "plan.json"), "{ not json");
		expect(() => s.loadPlan("arc")).toThrow(/not readable JSON/);
	});
});

describe("a slug is a directory name, and only that", () => {
	it("refuses anything that could walk out of the root", () => {
		const s = store(root());
		for (const slug of ["../escape", "/etc/passwd", "a/b", "Arc", ""])
			expect(() => s.savePlan(plan({ slug }))).toThrow(StoreError);
	});

	it("treats a malformed slug as absent rather than throwing on a read", () => {
		const s = store(root());
		expect(s.exists("../escape")).toBe(false);
		expect(s.loadPlan("../escape")).toBeNull();
	});
});

describe("listing", () => {
	it("puts the most recently saved first", () => {
		const dir = root();
		store(dir, "2026-07-01T00:00:00.000Z").savePlan(
			plan({ slug: "old", title: "Old" }),
		);
		store(dir, "2026-07-29T00:00:00.000Z").savePlan(
			plan({ slug: "new", title: "New" }),
		);
		expect(
			store(dir)
				.list()
				.map((p) => p.slug),
		).toEqual(["new", "old"]);
	});

	it("summarises without loading the whole thing into the caller", () => {
		const dir = root();
		store(dir).savePlan(
			plan({ deliverables: [deliverable("a"), deliverable("b")] }),
		);
		expect(store(dir).list()).toEqual([
			{ slug: "arc", title: "Arc", deliverables: 2, savedAt: T0 },
		]);
	});

	it("survives one broken plan rather than refusing to start", () => {
		// "One plan is broken" and "maestro will not start" are very different
		// failures, and the store should never turn the first into the second.
		const dir = root();
		const s = store(dir);
		s.savePlan(plan({ slug: "good" }));
		mkdirSync(join(dir, "bad"));
		writeFileSync(join(dir, "bad", "plan.json"), "{ not json");
		expect(s.list().map((p) => p.slug)).toEqual(["good"]);
	});

	it("skips harness-internal directories", () => {
		const dir = root();
		const s = store(dir);
		s.savePlan(plan());
		mkdirSync(join(dir, "_legacy", "arc"), { recursive: true });
		expect(s.list().map((p) => p.slug)).toEqual(["arc"]);
	});

	it("is empty before anything has ever been saved", () => {
		expect(createPlanStore(join(root(), "nothing-here")).list()).toEqual([]);
	});
});

describe("removal takes the run with the plan", () => {
	it("leaves nothing behind to be half-loaded later", () => {
		const dir = root();
		const s = store(dir);
		s.savePlan(plan());
		s.saveRun(beginRun("arc", T0));
		s.remove("arc");
		expect(s.exists("arc")).toBe(false);
		expect(s.loadRun("arc")).toBeNull();
		expect(s.list()).toEqual([]);
	});
});
