import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateResolvedAgentAssignment } from "../packages/contracts/src/agents.js";
import {
	validateStructuredFinding,
	validateTransitionGate,
} from "../packages/contracts/src/plan.js";
import {
	type Deliverable,
	type Plan,
	validatePlanShape,
} from "../packages/modes/src/schema.js";
import { createPlanStore } from "../packages/modes/src/storage.js";

const NOW = "2026-01-01T00:00:00.000Z";

function delivery(overrides: Partial<Deliverable> = {}): Deliverable {
	return {
		type: "deliverable",
		id: "delivery",
		title: "Delivery",
		body: "body",
		status: "planned",
		worker: { mode: "full" },
		agents: [],
		tasks: [],
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function plan(deliverables: Deliverable[]): Plan {
	return {
		schemaVersion: 5,
		slug: "plan",
		title: "Plan",
		repoPath: "/repo",
		deliverables,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

describe("full-cutover contract validation", () => {
	it("fails malformed findings and gates closed", () => {
		expect(
			validateStructuredFinding({
				id: "",
				severity: "urgent",
				category: "",
				actual: "",
				line: 0,
			}),
		).toEqual(expect.arrayContaining([expect.stringContaining("severity")]));
		expect(
			validateTransitionGate({
				id: "review",
				kind: "findings",
				status: "waived",
				from: "reviewing",
				to: "shipping",
				checkedAt: "not-a-date",
				findingIds: [],
			}),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining("checkedAt"),
				expect.stringContaining("waivedAt"),
				expect.stringContaining("findingIds"),
			]),
		);
	});

	it("rejects unresolved assignments", () => {
		expect(
			validateResolvedAgentAssignment({
				agentId: "worker",
				kind: "worker",
				presetId: "",
				modelSetId: "workers",
				optionId: "",
				modelId: "",
				runtime: {},
				resolvedAt: "bad",
				source: "fallback",
			}),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining("presetId"),
				expect.stringContaining("optionId"),
				expect.stringContaining("modelId"),
				expect.stringContaining("resolvedAt"),
				expect.stringContaining("source"),
			]),
		);
	});

	it("fails unsupported delivery status and malformed gate references", () => {
		const problems = validatePlanShape(
			plan([
				delivery({
					status: "unknown" as Deliverable["status"],
					findings: [
						{
							id: "sec.1",
							severity: "major",
							category: "security",
							actual: "token leak",
						},
					],
					gates: [
						{
							id: "review",
							kind: "findings",
							status: "blocked",
							from: "reviewing",
							to: "shipping",
							checkedAt: NOW,
							reason: "open finding",
							findingIds: ["missing"],
						},
					],
				}),
			]),
		).join("\n");
		expect(problems).toContain("unsupported status");
		expect(problems).toContain("unknown finding `missing`");
	});
});

describe("plan store schema cutover", () => {
	let root = "";
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("rejects legacy plans with explicit archive/reset guidance", () => {
		root = mkdtempSync(join(tmpdir(), "maestro-plan-schema-"));
		const dir = join(root, "legacy");
		mkdirSync(dir);
		writeFileSync(
			join(dir, "plan.json"),
			JSON.stringify({ slug: "legacy", schemaVersion: 4 }),
		);
		expect(() => createPlanStore(root).load("legacy")).toThrow(
			/archive or reset the old Maestro state/,
		);
	});
});
