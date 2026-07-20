// v2 plan vocabulary (plan-schema cutover PR-2). The recursive PlanNode/
// PlanV2 types themselves live with the plan module (packages/modes/src/plan)
// — this module is the SHARED vocabulary: schema version, node agent types,
// the persisted resolution record, the diversity record, envelope and watch
// config, plus their validators. Statuses and task kinds are v1's, reused
// verbatim — the state machine survives, it just applies to every node.

import { SPAWNABLE_AGENT_TYPES, type TierId } from "./catalog.js";
import type { DeliverableStatus, WorkItemKind } from "./plan.js";

export const PLAN_SCHEMA_VERSION_V2 = 6 as const;

/**
 * Spawnable node agent types — the same list the catalog's allowlists and
 * the persona registry use. `caller` is deliberately unrepresentable: a
 * plan node cannot be a harness component.
 */
export const NODE_AGENT_TYPES = SPAWNABLE_AGENT_TYPES;
export type NodeAgentType = (typeof NODE_AGENT_TYPES)[number];

/**
 * Node lifecycle: v1's DeliverableStatus values and transitions verbatim.
 * `shipped` is only reachable for branch-owning nodes; non-branch nodes
 * terminate at `complete` (their contract output is the deliverable).
 * `abandoned` is how ledger entries "go away" — append-only, never splice.
 */
export type NodeStatus = DeliverableStatus;

/** Task kinds: WorkItemKind survives whole (incl. the lifecycle pair). */
export type NodeTaskKind = WorkItemKind;

// ─── Persisted model resolution ──────────────────────────────────────────────

export const NODE_RESOLUTION_SOURCES = [
	"inherit",
	"persona-tier",
	"session-fallback",
] as const;
export type NodeResolutionSource = (typeof NODE_RESOLUTION_SOURCES)[number];

/**
 * Written by the harness at spawn, revalidated on resume (catalog ∩
 * residency ∩ allowlist may have changed). NEVER authored — plans carry no
 * model fields (inheritance is the rule). One entry per session generation,
 * newest last; `source` powers the "inherit / session-fallback are exempt
 * but labeled" explain rule.
 */
export interface NodeResolution {
	readonly model: string;
	/** From the catalog entry — authored, never inferred. Empty when the
	 *  resolution didn't pass through the catalog (inherit/fallback). */
	readonly family: string;
	/** Absent when source is inherit or session-fallback. */
	readonly tier?: TierId;
	readonly source: NodeResolutionSource;
	readonly effort?: string;
	/** Recorded when source is session-fallback (fail-visible, deduped). */
	readonly fallbackReason?: string;
	readonly resolvedAt: string;
	/** Resolution is per session generation. */
	readonly generation: number;
}

export function validateNodeResolution(value: unknown): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return ["resolution must be an object"];
	const record = value as Record<string, unknown>;
	const errors: string[] = [];
	if (typeof record.model !== "string" || record.model.length === 0)
		errors.push("resolution model is required");
	if (typeof record.family !== "string")
		errors.push("resolution family must be a string (may be empty)");
	if (!NODE_RESOLUTION_SOURCES.includes(record.source as NodeResolutionSource))
		errors.push(
			`resolution source must be one of ${NODE_RESOLUTION_SOURCES.join(", ")}`,
		);
	if (record.source === "persona-tier" && record.tier === undefined)
		errors.push("persona-tier resolutions must name their tier");
	if (
		(record.source === "inherit" || record.source === "session-fallback") &&
		record.tier !== undefined &&
		record.source === "inherit"
	)
		errors.push("inherit resolutions carry no tier");
	if (record.source === "session-fallback" && !record.fallbackReason)
		errors.push("session-fallback resolutions must record fallbackReason");
	if (typeof record.resolvedAt !== "string" || !record.resolvedAt)
		errors.push("resolution resolvedAt is required");
	if (!Number.isInteger(record.generation) || (record.generation as number) < 0)
		errors.push("resolution generation must be a non-negative integer");
	return errors;
}

// ─── Diversity record ────────────────────────────────────────────────────────

/**
 * The parent-child family edge check — soft but loud: same family without a
 * waiver is a recorded warning surfaced in explain output, never a block.
 */
export interface DiversityRecord {
	readonly parentFamily: string;
	readonly family: string;
	readonly sameFamily: boolean;
	/** The authored diversityWaiver reason, when the planner knowingly waived. */
	readonly waiver?: string;
	readonly recordedAt: string;
}

export function validateDiversityRecord(value: unknown): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return ["diversity record must be an object"];
	const record = value as Record<string, unknown>;
	const errors: string[] = [];
	if (typeof record.parentFamily !== "string")
		errors.push("diversity parentFamily must be a string");
	if (typeof record.family !== "string")
		errors.push("diversity family must be a string");
	if (typeof record.sameFamily !== "boolean")
		errors.push("diversity sameFamily must be a boolean");
	if (
		record.sameFamily === true &&
		record.waiver !== undefined &&
		(typeof record.waiver !== "string" || record.waiver.trim().length === 0)
	)
		errors.push("diversity waiver, when present, must be a non-empty reason");
	if (typeof record.recordedAt !== "string" || !record.recordedAt)
		errors.push("diversity recordedAt is required");
	return errors;
}

/** Build the edge record: compare families, honoring an authored waiver. */
export function diversityRecordFor(
	parentFamily: string,
	family: string,
	waiver: string | undefined,
	recordedAt: string,
): DiversityRecord {
	// Unknown families (empty string — inherit/fallback resolutions) never
	// flag: the rule compares AUTHORED families only, and half an edge is
	// not an edge.
	const sameFamily =
		parentFamily.length > 0 && family.length > 0 && parentFamily === family;
	return {
		parentFamily,
		family,
		sameFamily,
		...(sameFamily && waiver ? { waiver } : {}),
		recordedAt,
	};
}

// ─── Envelope & watch ────────────────────────────────────────────────────────

/** Per-node fan-out bounds. Absent fields → the plan's defaultEnvelope. */
export interface NodeEnvelope {
	/** Cap on direct children (authored + dynamic). */
	readonly maxChildren?: number;
	/** Cap on concurrently-running children (backpressure: steer, not refuse). */
	readonly maxConcurrent?: number;
}

export function validateNodeEnvelope(value: unknown): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return ["envelope must be an object"];
	const record = value as Record<string, unknown>;
	const errors: string[] = [];
	for (const field of ["maxChildren", "maxConcurrent"] as const) {
		if (
			record[field] !== undefined &&
			(!Number.isInteger(record[field]) || (record[field] as number) < 1)
		)
			errors.push(`envelope ${field} must be a positive integer`);
	}
	return errors;
}

/**
 * Per-node watcher OVERRIDES. Defaults live with the watcher policy; a node
 * states exceptions. Carries the incident-hardened knobs (IDLE_DONE_THRESHOLD,
 * dirty-hold cadence) into config instead of constants.
 */
export interface NodeWatchConfig {
	readonly idleDoneThreshold?: number;
	readonly dirtyHoldMaxSteers?: number;
	readonly dirtyHoldResteerMs?: number;
	/** Watcher-caller lifetime (design doc): one-shot vs until-condition. */
	readonly lifetime?: "one-shot" | "until-condition";
}

/** Default tree depth bound: the seat is depth 0; authored trees nest ≤ this. */
export const DEFAULT_MAX_DEPTH = 3;
