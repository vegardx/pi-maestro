// The v2 policy table: closed trigger vocabulary validated fail-visible,
// shipped defaults always valid, user rows replace defaults by trigger and
// invalid user rows are reported while the default stands.

import { validatePolicyRow, validatePolicyRows } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_POLICY_ROWS,
	policyRowFor,
} from "../packages/modes/src/policy-table.js";

describe("policy row validation", () => {
	it("accepts the design's canonical shapes", () => {
		expect(
			validatePolicyRow({
				on: "mode:plan->auto",
				run: {
					agent: "reviewer",
					persona: "plan-review",
					models: "heavy",
					contract: "plan-gate-report",
				},
			}),
		).toEqual([]);
		expect(
			validatePolicyRow({ on: "duty:classify", run: { models: "fast" } }),
		).toEqual([]);
		expect(
			validatePolicyRow({
				on: "tool:bash",
				scope: { depth: ">=1" },
				run: { models: "fast", contract: "verdict" },
			}),
		).toEqual([]);
	});

	it("rejects unknown triggers, duties, and run keys fail-visibly", () => {
		expect(
			validatePolicyRow({ on: "cron:daily", run: { models: "fast" } })[0],
		).toMatch(/trigger must be/);
		expect(
			validatePolicyRow({ on: "duty:vibes", run: { models: "fast" } })[0],
		).toMatch(/unknown duty/);
		expect(
			validatePolicyRow({
				on: "duty:classify",
				run: { models: "fast", modle: "typo" },
			})[0],
		).toMatch(/unknown key/);
		expect(validatePolicyRow({ on: "duty:classify", run: {} })[0]).toMatch(
			/tier is required/,
		);
		expect(
			validatePolicyRow({
				on: "tool:bash",
				scope: { depth: "deep" },
				run: { models: "fast" },
			})[0],
		).toMatch(/scope.depth/);
	});

	it("drops invalid rows with per-row errors, keeps valid ones", () => {
		const { rows, errors } = validatePolicyRows([
			{ on: "duty:classify", run: { models: "fast" } },
			{ on: "duty:nope", run: { models: "fast" } },
		]);
		expect(rows).toHaveLength(1);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("row 1");
	});
});

describe("the shipped default table", () => {
	it("every default row validates (a shipped invalid row is a build error)", () => {
		const { errors } = validatePolicyRows([...DEFAULT_POLICY_ROWS]);
		expect(errors).toEqual([]);
	});

	it("covers both execution boundary edges with the heavy plan reviewer", () => {
		for (const edge of ["mode:plan->auto", "mode:plan->hack"]) {
			const row = policyRowFor({ rows: DEFAULT_POLICY_ROWS, errors: [] }, edge);
			expect(row?.run.models).toBe("heavy");
			expect(row?.run.persona).toBe("plan-review");
			expect(row?.run.contract).toBe("plan-gate-report");
		}
	});
});

describe("duty rows", () => {
	it("ships live-duty defaults with tier-allowlist-compatible tiers", () => {
		const table = { rows: DEFAULT_POLICY_ROWS, errors: [] as string[] };
		expect(policyRowFor(table, "duty:compact-summarize")?.run.models).toBe(
			"fast",
		);
		expect(policyRowFor(table, "duty:verify-delivery")?.run.models).toBe(
			"normal",
		);
		expect(policyRowFor(table, "tool:bash")?.run.models).toBe("fast");
	});
});
