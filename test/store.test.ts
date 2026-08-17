import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Plan } from "../packages/maestro/src/plan.js";
import {
	createPlanStore,
	InvalidStateError,
	UnsupportedStateError,
} from "../packages/maestro/src/store.js";

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
		preflight: [],
		postflight: [],
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
