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
	type PlanNode,
	type PlanV2,
	validatePlanShapeV2,
} from "../packages/modes/src/plan/schema.js";
import { createPlanStoreV2 } from "../packages/modes/src/plan/storage.js";

const NOW = "2026-01-01T00:00:00.000Z";

function node(overrides: Partial<PlanNode> = {}): PlanNode {
	return {
		type: "node",
		id: "delivery",
		agent: "worker",
		persona: "coder",
		title: "Delivery",
		body: "body",
		status: "planned",
		tasks: [],
		authoredBy: "plan",
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function plan(nodes: PlanNode[]): PlanV2 {
	return {
		schemaVersion: 6,
		slug: "plan",
		title: "Plan",
		repoPath: "/repo",
		nodes,
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
				focus: "",
				rationale: "",
				inputContracts: "bad",
				outputContracts: [],
				provenance: {},
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

	// v1's validatePlanShape also cross-checked per-deliverable gate rulings
	// against finding ids ("unknown finding `missing`"). That referential check
	// died with v1: validatePlanShapeV2 validates the node TREE (ids, agents,
	// personas, depth, after-scoping, branch ownership, cycles); gate payloads
	// are validated at the contract layer (validateTransitionGate above).
	it("fails unsupported node statuses", () => {
		const problems = validatePlanShapeV2(
			plan([
				node({
					status: "unknown" as PlanNode["status"],
					findings: [
						{
							id: "sec.1",
							severity: "major",
							category: "security",
							actual: "token leak",
						},
					],
				}),
			]),
		).join("\n");
		expect(problems).toContain("unknown status");
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
			// schemaVersion 5 was the last v1 plan schema; the v2 store speaks 6.
			JSON.stringify({ slug: "legacy", schemaVersion: 5 }),
		);
		expect(() => createPlanStoreV2(root).load("legacy")).toThrow(
			/archive or reset the old Maestro state/,
		);
	});
});
