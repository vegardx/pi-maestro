// Plan naming, and the driver's tolerance of it.
//
// The mechanical name slugs the FIRST MESSAGE, so
//   'Create a plan called "sandbox-features" for this repo'
// became `create-a-plan-called-sandbox-features-for` — prose, not a name. Every
// e2e assertion then looked for `sandbox-features`, found nothing, and reported
// planFound:false on a perfectly healthy drive. Seeded drives masked it by
// writing the expected slug directly.
//
// Two layers, tested here: the session model names the plan from what it
// contains (root cause), and the driver finds the plan regardless (safety net —
// a harness must not depend on a model emitting an exact string).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { derivePlanName, slugify } from "../packages/modes/src/plan/schema.js";
import { readPlan } from "./e2e/driver/assertions.js";

let piHome: string;

function plansRoot(): string {
	return join(piHome, ".pi", "agent", "maestro", "plans");
}

function writePlan(slug: string, title: string): void {
	const dir = join(plansRoot(), slug);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "plan.json"),
		JSON.stringify({
			schemaVersion: 6,
			slug,
			title,
			status: "active",
			nodes: [{ id: "a", title: "Add statistics module", status: "planned" }],
		}),
	);
}

beforeEach(() => {
	piHome = mkdtempSync(join(tmpdir(), "plan-naming-"));
});

afterEach(() => rmSync(piHome, { recursive: true, force: true }));

describe("what the mechanical name produces", () => {
	it("slugs the request rather than the work — the bug being fixed", () => {
		const { slug } = derivePlanName(
			'Create a plan called "sandbox-features" for this repo.\n\nDeliverables:',
			"repo",
		);
		// Prose, not a name. Retained as the FALLBACK, which is why the driver
		// still needs to discover the plan.
		expect(slug).toBe("create-a-plan-called-sandbox-features-for");
	});

	it("uses an explicit name when one is set — the hook naming writes to", () => {
		// nameDraftFromModel sets draftExplicitName, which derivePlanName seeds
		// from ahead of the first message.
		const { slug } = derivePlanName("sandbox-features", "repo");
		expect(slug).toBe("sandbox-features");
	});

	it("slugify rejects what a stray model answer would produce", () => {
		// The guard on the model's reply: junk in, mechanical name out.
		expect(slugify("Sure! Here's a name: **My Plan**")).not.toContain("*");
		expect(slugify("  ")).toBe("");
	});
});

describe("the driver finds the plan regardless of its slug", () => {
	it("prefers an exact slug match", () => {
		writePlan("sandbox-features", "Sandbox features");
		writePlan("something-else", "Other");
		expect(readPlan(piHome, "sandbox-features")?.title).toBe(
			"Sandbox features",
		);
	});

	it("falls back to the only plan when the slug does not match", () => {
		writePlan("create-a-plan-called-sandbox-features-for", "Sandbox features");
		// This returned null before, and every assertion reported planFound:false.
		expect(readPlan(piHome, "sandbox-features")?.title).toBe(
			"Sandbox features",
		);
	});

	it("ignores the _session directory, which is not a plan", () => {
		mkdirSync(join(plansRoot(), "_session"), { recursive: true });
		writePlan("whatever-it-got-called", "Sandbox features");
		expect(readPlan(piHome, "sandbox-features")?.title).toBe(
			"Sandbox features",
		);
	});

	it("refuses to guess between several plans", () => {
		writePlan("one-plan", "One");
		writePlan("two-plan", "Two");
		expect(readPlan(piHome, "sandbox-features")).toBeNull();
	});

	it("returns null when there is no plan at all", () => {
		expect(readPlan(piHome, "sandbox-features")).toBeNull();
	});
});
