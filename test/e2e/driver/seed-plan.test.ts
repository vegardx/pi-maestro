// The seeded sandbox-features plan: written with the real engine + store, so
// this pins that (a) the file lands where the SUT's plan store looks, (b) the
// structure matches the scenario (parallel pair, review agent, stacked
// dependent), and (c) the store loads it back — i.e. `/plan sandbox-features`
// will reopen it ready to execute.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planPhase } from "../../../packages/modes/src/schema.js";
import { createPlanStore } from "../../../packages/modes/src/storage.js";
import { SANDBOX_FEATURES } from "./scenario.js";
import { seededPlansRoot, seedScenarioPlan } from "./seed-plan.js";

let piHome: string;

beforeEach(() => {
	piHome = mkdtempSync(join(tmpdir(), "seed-plan-"));
});

afterEach(() => {
	rmSync(piHome, { recursive: true, force: true });
});

describe("seedScenarioPlan", () => {
	it("writes a loadable plan into the isolated store", () => {
		const slug = seedScenarioPlan(piHome, "/tmp/sandbox-repo");
		expect(slug).toBe(SANDBOX_FEATURES.name);
		expect(existsSync(join(seededPlansRoot(piHome), slug, "plan.json"))).toBe(
			true,
		);

		const store = createPlanStore(seededPlansRoot(piHome));
		const plan = store.load(slug);
		expect(plan).not.toBeNull();
		expect(plan?.repoPath).toBe("/tmp/sandbox-repo");
		// Has deliverables → hydrates as structuring (ready to execute, not
		// exploring).
		expect(planPhase(plan as never)).toBe("structuring");
	});

	it("matches the scenario: parallel pair, review agent, stacked dependent", () => {
		seedScenarioPlan(piHome, "/tmp/sandbox-repo");
		const plan = createPlanStore(seededPlansRoot(piHome)).load(
			SANDBOX_FEATURES.name,
		);
		const byId = new Map(plan?.deliverables.map((g) => [g.id, g]) ?? []);

		const stats = byId.get("add-statistics-module");
		const validate = byId.get("add-validation-utilities");
		const advanced = byId.get("add-advanced-math");
		expect(stats?.dependsOn ?? []).toEqual([]);
		expect(validate?.agents.map((a) => a.name)).toEqual(["security-audit"]);
		expect(advanced?.dependsOn).toEqual([
			"add-statistics-module",
			"add-validation-utilities",
		]);
		expect(advanced?.stacked).toBe(true);

		// Every deliverable starts planned with its authored tasks (lifecycle
		// tasks are injected by the engine at activation, not seeded).
		for (const g of plan?.deliverables ?? []) {
			expect(g.status).toBe("planned");
			expect(g.tasks.length).toBeGreaterThanOrEqual(2);
			expect(g.tasks.every((t) => (t.kind ?? "task") === "task")).toBe(true);
		}

		// The scenario's expected files are covered by the deliverable bodies.
		for (const expected of SANDBOX_FEATURES.expected) {
			const match = plan?.deliverables.some((g) =>
				g.title.includes(expected.titleMatch),
			);
			expect(match).toBe(true);
		}
	});
});
