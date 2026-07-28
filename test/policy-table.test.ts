// The v2 policy table: closed trigger vocabulary validated fail-visible,
// shipped defaults always valid, user rows replace defaults by trigger and
// invalid user rows are reported while the default stands.

import { validatePolicyRow, validatePolicyRows } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_POLICY_ROWS,
	policyRowFor,
} from "../packages/maestro/src/policy-table.js";

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
			validatePolicyRow({ on: "duty:classify", run: { models: "light" } }),
		).toEqual([]);
		expect(
			validatePolicyRow({
				on: "tool:bash",
				scope: { depth: ">=1" },
				run: { models: "light", contract: "verdict" },
			}),
		).toEqual([]);
	});

	it("rejects unknown triggers, duties, and run keys fail-visibly", () => {
		expect(
			validatePolicyRow({ on: "cron:daily", run: { models: "light" } })[0],
		).toMatch(/trigger must be/);
		expect(
			validatePolicyRow({ on: "duty:vibes", run: { models: "light" } })[0],
		).toMatch(/unknown duty/);
		expect(
			validatePolicyRow({
				on: "duty:classify",
				run: { models: "light", modle: "typo" },
			})[0],
		).toMatch(/unknown key/);
		expect(validatePolicyRow({ on: "duty:classify", run: {} })[0]).toMatch(
			/tier is required/,
		);
		expect(
			validatePolicyRow({
				on: "tool:bash",
				scope: { depth: "deep" },
				run: { models: "light" },
			})[0],
		).toMatch(/scope.depth/);
	});

	it("drops invalid rows with per-row errors, keeps valid ones", () => {
		const { rows, errors } = validatePolicyRows([
			{ on: "duty:classify", run: { models: "light" } },
			{ on: "duty:nope", run: { models: "light" } },
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

	it("gates plan->auto with the heavy plan reviewer; plan->hack is not gated", () => {
		const table = { rows: DEFAULT_POLICY_ROWS, errors: [] };
		const auto = policyRowFor(table, "mode:plan->auto");
		expect(auto?.run.models).toBe("heavy");
		expect(auto?.run.persona).toBe("plan-review");
		expect(auto?.run.contract).toBe("plan-gate-report");
		// hack is a direct posture switch — no readiness gate, so no policy row.
		expect(policyRowFor(table, "mode:plan->hack")).toBeUndefined();
	});
});

describe("duty rows", () => {
	it("ships live-duty defaults with tier-allowlist-compatible tiers", () => {
		const table = { rows: DEFAULT_POLICY_ROWS, errors: [] as string[] };
		expect(policyRowFor(table, "duty:compact-summarize")?.run.models).toBe(
			"light",
		);
		expect(policyRowFor(table, "duty:verify-delivery")?.run.models).toBe(
			"standard",
		);
		expect(policyRowFor(table, "tool:bash")?.run.models).toBe("light");
		expect(policyRowFor(table, "tool:watch")?.run.models).toBe("light");
	});
});
