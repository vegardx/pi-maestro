import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAESTRO_SCHEMA_VERSION,
	type Plan,
} from "../packages/maestro/src/plan.js";
import {
	createPlanStore,
	InvalidStateError,
	UnsupportedStateError,
} from "../packages/maestro/src/store.js";
import { fakeHost } from "./fake-host.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const path = join(tmpdir(), `maestro-store-${process.pid}-${roots.length}`);
	roots.push(path);
	return path;
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
		const store = createPlanStore(root(), {
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
		const state = root();
		const store = createPlanStore(state);
		store.savePlan(plan());
		const written = JSON.parse(
			readFileSync(join(state, "app", "plan.json"), "utf8"),
		) as { schemaVersion: number };
		expect(written.schemaVersion).toBe(5);
		expect(MAESTRO_SCHEMA_VERSION).toBe(5);
		expect(store.loadPlan("app")).toEqual(plan());
	});

	// The version 3 document. It is refused, not migrated, and the refusal
	// names both versions and what changed between them — "unsupported" alone
	// leaves a human with a file and no idea what to do with it.
	it("refuses a version 4 envelope by naming both versions", () => {
		const state = root();
		mkdirSync(join(state, "app"), { recursive: true });
		const path = join(state, "app", "plan.json");
		writeFileSync(
			path,
			JSON.stringify({
				schemaVersion: 4,
				savedAt: "2026-08-08T00:00:00Z",
				body: plan(),
			}),
		);
		const store = createPlanStore(state);
		expect(() => store.loadPlan("app")).toThrow(
			`${path} was written by schema 4, and this build speaks 5. Schema 5 moved review routing from \`tasks[].review\` to \`deliverables[].reviews\` and dropped \`stages\`, and there is no migration. Archive or remove the plan and write it again at schemaVersion 5.`,
		);
		// Refused, never rewritten: a store that quietly re-stamped the version
		// would be a migration nobody wrote.
		expect(readFileSync(path, "utf8")).toContain('"schemaVersion":4');
	});

	// A task carrying an earlier version's review field inside a version 5 body.
	// The envelope cannot catch this one — the document says 5 — so validation
	// does, and it names both the field and where the thing went.
	it("refuses a task that still carries `by`", () => {
		const store = createPlanStore(root());
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
		const store = createPlanStore(root(), {
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
		const store = createPlanStore(root());
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
		const store = createPlanStore(root());
		expect(() => store.savePlan({ ...plan(), slug: "../escape" })).toThrow(
			InvalidStateError,
		);
		expect(store.list()).toEqual([]);
	});

	it("fails closed on corrupt or incompatible stored state", () => {
		const state = root();
		mkdirSync(join(state, "app"), { recursive: true });
		const path = join(state, "app", "plan.json");
		writeFileSync(path, "not json\n");
		const store = createPlanStore(state);
		expect(() => store.loadPlan("app")).toThrow(/not readable JSON/);
		writeFileSync(path, JSON.stringify({ schemaVersion: 1, body: plan() }));
		expect(() => store.loadPlan("app")).toThrow(UnsupportedStateError);
		expect(readFileSync(path, "utf8")).toContain('"schemaVersion":1');
	});
});
