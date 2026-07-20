// The v2 policy table (design §Policies): ONE table replaces bindings,
// transition gates, and hardcoded supervision. Closed trigger enum, three
// kinds — `mode:<edge>` (boundary reviews), `duty:<name>` (the closed harness
// duty enum), `tool:<name>` (tool gating on the supervisor bus). `models` (a
// tier) is required on every row; `scope` stays coarse (depth / agent type) —
// judgment lives in the caller's prompt, never in config matchers. Rows are
// validated fail-visible: an invalid user row is reported and the shipped
// default row stands.

import { TIER_IDS, type TierId } from "./catalog.js";
import { NODE_AGENT_TYPES } from "./plan-v2.js";

/** The closed harness duty enum. Retiring a duty deletes a row, not a role. */
export const POLICY_DUTIES = [
	"classify",
	"plan-summarize",
	"compact-summarize",
	"verify-findings",
	"verify-delivery",
] as const;
export type PolicyDuty = (typeof POLICY_DUTIES)[number];

/** Coarse row scope. Judgment never lives in matchers. */
export interface PolicyScope {
	/** Depth constraint, e.g. ">=1" (seat is 0). */
	readonly depth?: string;
	/** Restrict to one spawnable agent type. */
	readonly agent?: string;
}

/**
 * What fires when a row triggers. `models` names a catalog tier and is
 * REQUIRED. The remaining fields configure the caller/gate the row tunes;
 * unknown keys are rejected (a typo must not silently no-op).
 */
export interface PolicyRun {
	readonly models: TierId;
	readonly agent?: string;
	readonly persona?: string;
	readonly contract?: string;
	readonly strategy?: string;
	readonly warm?: string;
	readonly stale?: string;
	/** Row kill-switch: false disables the triggered behavior visibly. */
	readonly enabled?: boolean;
}

export interface PolicyRow {
	/** "mode:<from>-><to>" | "duty:<duty>" | "tool:<tool>". */
	readonly on: string;
	readonly scope?: PolicyScope;
	readonly run: PolicyRun;
}

const RUN_KEYS = new Set([
	"models",
	"agent",
	"persona",
	"contract",
	"strategy",
	"warm",
	"stale",
	"enabled",
]);
const SCOPE_KEYS = new Set(["depth", "agent"]);
const DEPTH_RE = /^(>=|<=|=)?\d$/;
const MODE_EDGE_RE = /^[a-z]+->[a-z]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one row; returns human-readable problems (empty = valid). */
export function validatePolicyRow(value: unknown): string[] {
	if (!isRecord(value)) return ["row must be an object"];
	const problems: string[] = [];
	const on = value.on;
	if (typeof on !== "string" || on.length === 0) {
		problems.push("row.on must be a non-empty string");
	} else if (on.startsWith("mode:")) {
		if (!MODE_EDGE_RE.test(on.slice("mode:".length)))
			problems.push(`row.on ${on}: mode edge must look like "plan->auto"`);
	} else if (on.startsWith("duty:")) {
		const duty = on.slice("duty:".length);
		if (!(POLICY_DUTIES as readonly string[]).includes(duty))
			problems.push(
				`row.on ${on}: unknown duty (closed enum: ${POLICY_DUTIES.join(", ")})`,
			);
	} else if (on.startsWith("tool:")) {
		if (on.slice("tool:".length).length === 0)
			problems.push("row.on tool: requires a tool name");
	} else {
		problems.push(`row.on ${String(on)}: trigger must be mode:/duty:/tool:`);
	}
	const scope = value.scope;
	if (scope !== undefined) {
		if (!isRecord(scope)) problems.push("row.scope must be an object");
		else {
			for (const key of Object.keys(scope))
				if (!SCOPE_KEYS.has(key))
					problems.push(`row.scope.${key}: unknown scope key (depth, agent)`);
			if (scope.depth !== undefined) {
				if (typeof scope.depth !== "string" || !DEPTH_RE.test(scope.depth))
					problems.push(
						`row.scope.depth ${String(scope.depth)}: expected e.g. ">=1"`,
					);
			}
			if (scope.agent !== undefined) {
				if (
					typeof scope.agent !== "string" ||
					!(NODE_AGENT_TYPES as readonly string[]).includes(scope.agent)
				)
					problems.push(
						`row.scope.agent ${String(scope.agent)}: expected one of ${NODE_AGENT_TYPES.join(", ")}`,
					);
			}
		}
	}
	const run = value.run;
	if (!isRecord(run)) {
		problems.push("row.run must be an object");
		return problems;
	}
	for (const key of Object.keys(run))
		if (!RUN_KEYS.has(key))
			problems.push(
				`row.run.${key}: unknown key (${[...RUN_KEYS].join(", ")})`,
			);
	if (
		typeof run.models !== "string" ||
		!(TIER_IDS as readonly string[]).includes(run.models)
	)
		problems.push(
			`row.run.models ${String(run.models)}: a tier is required on every row (${TIER_IDS.join(", ")})`,
		);
	if (run.enabled !== undefined && typeof run.enabled !== "boolean")
		problems.push("row.run.enabled must be boolean");
	return problems;
}

export interface ValidatedPolicyRows {
	readonly rows: readonly PolicyRow[];
	/** One entry per rejected row: "<index>: problem; problem". */
	readonly errors: readonly string[];
}

/** Validate a raw rows array; invalid rows are dropped WITH visible errors. */
export function validatePolicyRows(value: unknown): ValidatedPolicyRows {
	if (value === undefined) return { rows: [], errors: [] };
	if (!Array.isArray(value))
		return { rows: [], errors: ["policies must be an array of rows"] };
	const rows: PolicyRow[] = [];
	const errors: string[] = [];
	value.forEach((raw, index) => {
		const problems = validatePolicyRow(raw);
		if (problems.length > 0)
			errors.push(`row ${index}: ${problems.join("; ")}`);
		else rows.push(raw as PolicyRow);
	});
	return { rows, errors };
}
