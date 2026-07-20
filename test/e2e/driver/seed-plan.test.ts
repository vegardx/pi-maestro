// The seeded sandbox-features plan: written with the real engine + store, so
// this pins that (a) the file lands where the SUT's plan store looks, (b) the
// structure matches the scenario (parallel pair, review child, stacked
// dependent), and (c) the store loads it back — i.e. `/plan sandbox-features`
// will reopen it ready to execute.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveBase } from "../../../packages/modes/src/plan/schema.js";
import { createPlanStoreV2 } from "../../../packages/modes/src/plan/storage.js";
import { planPhaseV2 } from "../../../packages/modes/src/planning-preamble.js";
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

		const store = createPlanStoreV2(seededPlansRoot(piHome));
		const plan = store.load(slug);
		expect(plan).not.toBeNull();
		expect(plan?.repoPath).toBe("/tmp/sandbox-repo");
		// Has nodes → hydrates as structuring (ready to execute, not exploring).
		expect(planPhaseV2(plan as never)).toBe("structuring");
	});

	it("matches the scenario: parallel pair, review child, stacked dependent", () => {
		seedScenarioPlan(piHome, "/tmp/sandbox-repo");
		const plan = createPlanStoreV2(seededPlansRoot(piHome)).load(
			SANDBOX_FEATURES.name,
		);
		const byId = new Map(plan?.nodes.map((node) => [node.id, node]) ?? []);

		const stats = byId.get("add-statistics-module");
		const validate = byId.get("add-validation-utilities");
		const advanced = byId.get("add-advanced-math");
		expect(stats?.after ?? []).toEqual([]);
		expect(validate?.children?.map((child) => child.id)).toEqual([
			"security-audit",
		]);
		expect(validate?.children?.[0]?.agent).toBe("reviewer");
		expect(validate?.children?.[0]?.after).toEqual(["parent"]);
		expect(advanced?.after).toEqual([
			"add-statistics-module",
			"add-validation-utilities",
		]);
		// Stacked: no base override → deriveBase picks the first after dep's
		// branch once that sibling is in a stackable status.
		expect(advanced?.base).toBeUndefined();
		expect(
			advanced &&
				deriveBase(
					advanced,
					(plan?.nodes ?? []).map((node) => ({
						...node,
						status: "complete" as const,
					})),
					"main",
				),
		).toBe("feat/add-statistics-module");

		// Every worker node starts planned with its authored tasks (lifecycle
		// tasks are injected at activation, not seeded).
		for (const node of plan?.nodes ?? []) {
			expect(node.status).toBe("planned");
			expect(node.agent).toBe("worker");
			expect(node.tasks.length).toBeGreaterThanOrEqual(2);
			expect(node.tasks.every((t) => (t.kind ?? "task") === "task")).toBe(true);
			expect(node.branch).toBe(`feat/${node.id}`);
		}

		// The scenario's expected files are covered by the node bodies.
		for (const expected of SANDBOX_FEATURES.expected) {
			const match = plan?.nodes.some((node) =>
				(node.title ?? "").includes(expected.titleMatch),
			);
			expect(match).toBe(true);
		}
	});
});
