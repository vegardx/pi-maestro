import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectKey, projectPlansRoot } from "../packages/maestro/src/paths.js";
import {
	MAESTRO_SCHEMA_VERSION,
	type Plan,
} from "../packages/maestro/src/plan.js";
import {
	createPlanStore,
	InvalidStateError,
	type PlanStore,
	type StoreOptions,
	UnsupportedStateError,
} from "../packages/maestro/src/store.js";
import { fakeHost } from "./fake-host.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/**
 * A temporary agent directory. EVERY store below is built on one: a test that
 * fell through to the real `~/.pi/agent` would file its fixtures next to the
 * operator's own plans, and `list` would start reporting on them.
 */
function agentDir(): string {
	const path = join(tmpdir(), `maestro-store-${process.pid}-${roots.length}`);
	roots.push(path);
	return path;
}

/** The project a store is keyed by; never touched, only named. */
function project(name = "alpha"): string {
	return join(tmpdir(), `maestro-project-${process.pid}`, name);
}

function makeStore(
	options: Partial<StoreOptions> & { readonly agentDir: string },
): PlanStore {
	return createPlanStore({
		cwd: options.cwd ?? project(),
		sessionId: options.sessionId ?? (() => "session-1"),
		...options,
	});
}

/** Where a store's files land, computed the way nothing under test does. */
function planPath(cwd: string, dir: string, slug: string): string {
	return join(projectPlansRoot(cwd, dir), slug, "plan.json");
}

function plan(slug = "app"): Plan {
	return {
		slug,
		title: "App",
		repos: [{ key: "app", path: "." }],
		deliverables: [
			{
				id: "app",
				title: "App",
				after: [],
				reads: [],
				repo: "app",
				tasks: [{ id: "build", title: "Build" }],
			},
		],
	};
}

describe("plan store", () => {
	it("round-trips, lists, replaces, and removes plans", () => {
		const store = makeStore({
			agentDir: agentDir(),
			now: () => "2026-08-08T00:00:00Z",
		});
		store.savePlan(plan());
		expect(store.loadPlan("app")).toEqual(plan());
		expect(store.list()).toEqual([
			{
				slug: "app",
				title: "App",
				deliverables: 1,
				savedAt: "2026-08-08T00:00:00Z",
			},
		]);
		store.savePlan({ ...plan(), title: "Updated" });
		expect(store.loadPlan("app")?.title).toBe("Updated");
		store.remove("app");
		expect(store.loadPlan("app")).toBeNull();
	});

	it("writes the version this build speaks, and reads it back", () => {
		const dir = agentDir();
		const cwd = project();
		const store = makeStore({ agentDir: dir, cwd });
		store.savePlan(plan());
		const written = JSON.parse(
			readFileSync(planPath(cwd, dir, "app"), "utf8"),
		) as { schemaVersion: number };
		expect(written.schemaVersion).toBe(6);
		expect(MAESTRO_SCHEMA_VERSION).toBe(6);
		expect(store.loadPlan("app")).toEqual(plan());
	});

	// The version 3 document. It is refused, not migrated, and the refusal
	// names both versions and what changed between them — "unsupported" alone
	// leaves a human with a file and no idea what to do with it.
	it("refuses a version 5 envelope by naming both versions", () => {
		const dir = agentDir();
		const cwd = project();
		const path = planPath(cwd, dir, "app");
		mkdirSync(join(path, ".."), { recursive: true });
		// The version 5 envelope exactly: a schema 5 plan document, and no
		// `authoredBy`, because that is the field version 6 added.
		writeFileSync(
			path,
			JSON.stringify({
				schemaVersion: 5,
				savedAt: "2026-08-08T00:00:00Z",
				body: plan(),
			}),
		);
		const store = makeStore({ agentDir: dir, cwd });
		expect(() => store.loadPlan("app")).toThrow(
			`${path} was written by schema 5, and this build speaks 6. Schema 6 adds a required envelope field, \`authoredBy\` — the session id and the cwd of whoever wrote the plan — which a schema 5 envelope does not carry and nothing can infer, and there is no migration. Archive or remove the plan and write it again at schemaVersion 6.`,
		);
		// Refused, never rewritten: a store that quietly re-stamped the version
		// would be a migration nobody wrote.
		expect(readFileSync(path, "utf8")).toContain('"schemaVersion":5');
		// And it is absent from the list rather than fatal to it.
		expect(store.list()).toEqual([]);
	});

	// A task carrying an earlier version's review field inside a version 5 body.
	// The envelope cannot catch this one — the document says 5 — so validation
	// does, and it names both the field and where the thing went.
	it("refuses a task that still carries `by`", () => {
		const store = makeStore({ agentDir: agentDir() });
		const withBy = {
			...plan(),
			deliverables: [
				{
					...plan().deliverables[0],
					tasks: [
						{ id: "build", title: "Build" },
						{ id: "review", title: "Review", by: { lens: "contracts" } },
					],
				},
			],
		} as unknown as Plan;
		expect(() => store.savePlan(withBy)).toThrow(
			/carries `by`, which plan schema v5 moved to `deliverables\[\]\.reviews`/,
		);
		expect(store.list()).toEqual([]);
	});

	// The store runs the SAME validation the plan tool ran, host included, so a
	// plan the tool refused cannot reach disk through the store instead.
	it("refuses a pinned review model the host does not have", () => {
		const pinned = (model: string): Plan =>
			({
				...plan(),
				deliverables: [
					{
						...plan().deliverables[0],
						tasks: [{ id: "build", title: "Build" }],
						reviews: [{ lens: "c", model }],
					},
				],
			}) as Plan;
		const store = makeStore({
			agentDir: agentDir(),
			host: () => fakeHost({ models: ["anthropic/opus-5"] }),
		});
		expect(() => store.savePlan(pinned("anthropic/opus-9"))).toThrow(
			/is not a model this host has/,
		);
		store.savePlan(pinned("anthropic/opus-5"));
		expect(store.loadPlan("app")?.deliverables[0]?.reviews).toEqual([
			{ lens: "c", model: "anthropic/opus-5" },
		]);
	});

	// FAIL CLOSED. A store with no host cannot check a pin, so it refuses one
	// rather than persisting what nothing verified.
	it("refuses a pinned review model when it has no host to ask", () => {
		const store = makeStore({ agentDir: agentDir() });
		expect(() =>
			store.savePlan({
				...plan(),
				deliverables: [
					{
						...plan().deliverables[0],
						tasks: [{ id: "build", title: "Build" }],
						reviews: [{ lens: "c", model: "anthropic/opus-5" }],
					},
				],
			}),
		).toThrow(/there is no model catalogue here to check it against/);
		expect(store.list()).toEqual([]);
	});

	it("refuses invalid plans before writing", () => {
		const store = makeStore({ agentDir: agentDir() });
		expect(() => store.savePlan({ ...plan(), slug: "../escape" })).toThrow(
			InvalidStateError,
		);
		expect(store.list()).toEqual([]);
	});

	it("fails closed on corrupt or incompatible stored state", () => {
		const dir = agentDir();
		const cwd = project();
		const path = planPath(cwd, dir, "app");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "not json\n");
		const store = makeStore({ agentDir: dir, cwd });
		expect(() => store.loadPlan("app")).toThrow(/not readable JSON/);
		writeFileSync(path, JSON.stringify({ schemaVersion: 1, body: plan() }));
		expect(() => store.loadPlan("app")).toThrow(UnsupportedStateError);
		expect(readFileSync(path, "utf8")).toContain('"schemaVersion":1');
	});

	// A file that claims the current version and omits what the current version
	// requires was not written here. Reading it as "authored by nobody" is the
	// soft downgrade the whole envelope check exists to refuse.
	it("refuses an envelope that claims 6 and carries no `authoredBy`", () => {
		const dir = agentDir();
		const cwd = project();
		const path = planPath(cwd, dir, "app");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({ schemaVersion: 6, savedAt: "x", body: plan() }),
		);
		expect(() => makeStore({ agentDir: dir, cwd }).loadPlan("app")).toThrow(
			/carries no `authoredBy` session and cwd/,
		);
	});
});

describe("plans are per project", () => {
	// THE PIN. Pi encodes a cwd into its sessions directory name in
	// `core/session-manager.js`; it does not export the function, so this is the
	// only thing holding the two spellings together. If Pi's changes, this fails
	// and someone has to look — which is the point.
	it("keys a project exactly the way Pi keys its sessions directory", () => {
		expect(projectKey("/Users/x/src/proj")).toBe("--Users-x-src-proj--");
		// The formula, applied as Pi applies it: leading separator dropped, every
		// remaining separator and colon becomes `-`, wrapped in `--`.
		expect(projectKey("/a/b")).toBe("--a-b--");
		// Relative paths are resolved first, exactly as Pi's `resolvePath` does.
		expect(projectKey(".")).toBe(projectKey(process.cwd()));
	});

	it("puts a project's plans under its own key", () => {
		const dir = agentDir();
		const cwd = project("alpha");
		const store = makeStore({ agentDir: dir, cwd });
		expect(store.root).toBe(join(dir, "maestro", "plans", projectKey(cwd)));
		expect(store.cwd).toBe(cwd);
		store.savePlan(plan());
		expect(store.planFile("app")).toBe(planPath(cwd, dir, "app"));
		expect(readFileSync(store.planFile("app"), "utf8")).toContain('"app"');
	});

	// The defect this replaced: one directory of plans from unrelated
	// repositories, listed everywhere.
	it("shows one project nothing of another's, in one agent directory", () => {
		const dir = agentDir();
		const alpha = makeStore({ agentDir: dir, cwd: project("alpha") });
		const beta = makeStore({ agentDir: dir, cwd: project("beta") });
		alpha.savePlan({ ...plan("shared"), title: "Alpha's" });
		beta.savePlan({ ...plan("shared"), title: "Beta's" });
		beta.savePlan(plan("beta-only"));

		expect(alpha.list().map((s) => s.slug)).toEqual(["shared"]);
		expect(
			beta
				.list()
				.map((s) => s.slug)
				.sort(),
		).toEqual(["beta-only", "shared"]);
		// The same slug in two projects is two plans, not one overwritten.
		expect(alpha.loadPlan("shared")?.title).toBe("Alpha's");
		expect(beta.loadPlan("shared")?.title).toBe("Beta's");
		expect(alpha.loadPlan("beta-only")).toBeNull();
		expect(alpha.planFile("shared")).not.toBe(beta.planFile("shared"));
	});

	// A project nobody has stored a plan for is the normal first case, and an
	// empty list is the honest answer to it.
	it("lists nothing, and does not throw, where no plans folder exists", () => {
		const store = makeStore({ agentDir: agentDir(), cwd: project("fresh") });
		expect(store.list()).toEqual([]);
		expect(store.loadPlan("app")).toBeNull();
		expect(store.exists("app")).toBe(false);
	});

	// Plans written before the key existed live directly under `plans/<slug>`.
	// They are not read, not listed and not migrated.
	it("ignores plans left directly under the plans root", () => {
		const dir = agentDir();
		const cwd = project("alpha");
		const legacy = join(dir, "maestro", "plans", "app");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(
			join(legacy, "plan.json"),
			JSON.stringify({
				schemaVersion: 6,
				savedAt: "2026-08-08T00:00:00Z",
				authoredBy: { sessionId: "old", cwd: "/elsewhere" },
				body: plan(),
			}),
		);
		const store = makeStore({ agentDir: dir, cwd });
		expect(store.list()).toEqual([]);
		expect(store.loadPlan("app")).toBeNull();
	});
});

describe("a plan records who wrote it", () => {
	it("writes the authoring session and cwd onto the envelope", () => {
		const dir = agentDir();
		const cwd = project("alpha");
		const store = makeStore({
			agentDir: dir,
			cwd,
			sessionId: () => "sess-42",
			now: () => "2026-08-08T00:00:00Z",
		});
		store.savePlan(plan());
		expect(
			JSON.parse(readFileSync(planPath(cwd, dir, "app"), "utf8")),
		).toMatchObject({
			schemaVersion: 6,
			authoredBy: { sessionId: "sess-42", cwd },
		});
		expect(store.loadRecord("app")).toEqual({
			plan: plan(),
			authoredBy: { sessionId: "sess-42", cwd },
			savedAt: "2026-08-08T00:00:00Z",
		});
	});

	// FAIL CLOSED, the same way a pin with no host to check it fails closed: an
	// invented author is worth less than no field at all.
	it("refuses to save when it cannot name the session", () => {
		const store = makeStore({
			agentDir: agentDir(),
			sessionId: () => undefined,
		});
		expect(() => store.savePlan(plan())).toThrow(
			/schema 6 records who wrote a plan \(`authoredBy.sessionId`\)/,
		);
		expect(store.list()).toEqual([]);
	});
});
