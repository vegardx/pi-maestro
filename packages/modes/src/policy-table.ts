// The live policy table: shipped default rows + user rows from layered
// settings, merged by trigger (a user row REPLACES the default row with the
// same `on`; an invalid user row is reported fail-visible and the default
// stands). Only rows with real consumers ship as defaults — a row nothing
// reads is a lie the linter should catch, not configuration.

import { type PolicyRow, validatePolicyRows } from "@vegardx/pi-contracts";
import { readLayeredExtensionConfig } from "@vegardx/pi-settings";

/**
 * Shipped defaults. Currently: the plan→execution boundary reviews (the
 * transition gate reads its row for tier/persona/contract and the
 * kill-switch). Duty and tool rows land WITH their consumers — the
 * command-auditor's LLM rung will bring `tool:bash`.
 */
export const DEFAULT_POLICY_ROWS: readonly PolicyRow[] = [
	{
		on: "mode:plan->auto",
		run: {
			agent: "reviewer",
			persona: "plan-review",
			models: "heavy",
			contract: "plan-gate-report",
		},
	},
	{
		on: "mode:plan->hack",
		run: {
			agent: "reviewer",
			persona: "plan-review",
			models: "heavy",
			contract: "plan-gate-report",
		},
	},
];

export interface PolicyTable {
	readonly rows: readonly PolicyRow[];
	/** Fail-visible problems from user rows (surface once, never crash). */
	readonly errors: readonly string[];
}

/**
 * Read the merged policy table: defaults ∪ user rows (`modes.policies` in the
 * layered extension config), user rows winning by `on`.
 */
export function readPolicyTable(cwd: string, agentDir?: string): PolicyTable {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const raw = (merged.modes as Record<string, unknown> | undefined)?.policies;
	const { rows: userRows, errors } = validatePolicyRows(raw);
	const byTrigger = new Map<string, PolicyRow>();
	for (const row of DEFAULT_POLICY_ROWS) byTrigger.set(row.on, row);
	for (const row of userRows) byTrigger.set(row.on, row);
	return { rows: [...byTrigger.values()], errors };
}

/** The row for one trigger, or undefined (absent = built-in behavior). */
export function policyRowFor(
	table: PolicyTable,
	on: string,
): PolicyRow | undefined {
	return table.rows.find((row) => row.on === on);
}
