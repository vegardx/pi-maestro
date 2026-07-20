// The live policy table: shipped default rows + user rows from layered
// settings, merged by trigger (a user row REPLACES the default row with the
// same `on`; an invalid user row is reported fail-visible and the default
// stands). Only rows with real consumers ship as defaults — a row nothing
// reads is a lie the linter should catch, not configuration.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type PolicyDuty,
	type PolicyRow,
	type ThinkingLevel,
	validatePolicyRows,
} from "@vegardx/pi-contracts";
import { resolveV2Model } from "@vegardx/pi-models";
import { readLayeredExtensionConfig } from "@vegardx/pi-settings";

/**
 * Shipped defaults — only rows with live consumers: the plan→execution
 * boundary reviews (the transition gate reads tier/persona/contract and the
 * kill-switch) and `tool:bash` (the command-auditor's LLM rung on child
 * agents' unknown commands; deny-only, fail-open). Duty rows land WITH
 * their consumers.
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
	{
		on: "tool:bash",
		scope: { depth: ">=1" },
		run: { models: "fast", contract: "verdict" },
	},
	// Live duties: the compaction summariser and the /verify read agents
	// resolve their tier here (v1 role bindings are the fallback when a row
	// is absent, disabled, or unresolvable).
	{ on: "duty:compact-summarize", run: { models: "fast" } },
	{ on: "duty:verify-delivery", run: { models: "normal" } },
	// The watcher's compile/judge calls (design §The watcher).
	{ on: "tool:watch", run: { models: "fast" } },
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

/** Agent-type lens a duty resolves through (tier allowlist validation). */
const DUTY_AGENT: Readonly<Record<PolicyDuty, "explorer" | "reviewer">> = {
	classify: "explorer",
	"plan-summarize": "explorer",
	"compact-summarize": "explorer",
	"verify-findings": "reviewer",
	"verify-delivery": "reviewer",
};

/**
 * Resolve a duty's policy row to a concrete model via the v2 resolver
 * (residency-filtered). Null when the row is absent, disabled, or fails to
 * resolve — the caller falls back to its pre-table behavior, fail-open.
 */
export async function resolveDutyModel(
	ctx: ExtensionContext,
	duty: PolicyDuty,
): Promise<{ modelId: string; effort?: ThinkingLevel } | null> {
	const row = policyRowFor(readPolicyTable(ctx.cwd), `duty:${duty}`);
	if (!row || row.run.enabled === false) return null;
	try {
		const resolved = await resolveV2Model(ctx, {
			agent: DUTY_AGENT[duty],
			tier: row.run.models,
		});
		return {
			modelId: resolved.modelId,
			...(resolved.effort ? { effort: resolved.effort } : {}),
		};
	} catch {
		return null;
	}
}
