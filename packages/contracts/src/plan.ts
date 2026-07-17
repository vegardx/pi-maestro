// Shared plan and delivery vocabulary. The full persisted plan tree and engine
// live in modes; this module owns every cross-package state-machine value.

import type { DeliverableId, WorkItemId } from "./ids.js";

/** Current on-disk plan schema. Older plans are intentionally unsupported. */
export const PLAN_SCHEMA_VERSION = 5 as const;

// ─── Deliverable lifecycle ──────────────────────────────────────────────────

export const DELIVERABLE_STATUSES = [
	"planned",
	"active",
	"complete",
	"failed",
	"shipped",
	"superseded",
	"abandoned",
] as const;

export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

export const DELIVERABLE_TRANSITIONS = {
	planned: ["active", "abandoned"],
	active: ["complete", "failed", "abandoned"],
	complete: [
		"active",
		"planned",
		"shipped",
		"failed",
		"superseded",
		"abandoned",
	],
	failed: ["planned", "active", "abandoned"],
	shipped: ["planned"],
	superseded: [],
	abandoned: [],
} as const satisfies Record<DeliverableStatus, readonly DeliverableStatus[]>;

/** A failure is recoverable only when a retry/replacement may move it onward. */
export interface DeliveryFailure {
	readonly code: string;
	readonly message: string;
	readonly failedAt: string;
	readonly recoverable: boolean;
	readonly attempt: number;
	readonly agentId?: string;
	readonly cause?: string;
}

// ─── Work items ─────────────────────────────────────────────────────────────

export const WORK_ITEM_KINDS = [
	"task",
	"followup",
	"question",
	"manual",
] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];
export type AgentMode = "full" | "read-only";

// ─── Findings and gates ─────────────────────────────────────────────────────

export const FINDING_SEVERITIES = ["critical", "major", "minor"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** A decidable, source-addressable problem. Empty prose is never a finding. */
export interface StructuredFinding {
	readonly id: string;
	readonly severity: FindingSeverity;
	readonly category: string;
	readonly actual: string;
	readonly file?: string;
	readonly line?: number;
	readonly task?: string;
	readonly claim?: string;
	readonly evidence?: readonly string[];
}

export const TRANSITION_GATE_KINDS = [
	"dependencies",
	"work-items",
	"findings",
	"approval",
	"manual",
] as const;
export type TransitionGateKind = (typeof TRANSITION_GATE_KINDS)[number];

export const TRANSITION_GATE_STATUSES = [
	"pending",
	"blocked",
	"satisfied",
	"waived",
] as const;
export type TransitionGateStatus = (typeof TRANSITION_GATE_STATUSES)[number];

/** Durable evidence for why a workflow transition is open or held. */
export interface TransitionGate {
	readonly id: string;
	readonly kind: TransitionGateKind;
	readonly status: TransitionGateStatus;
	readonly from: string;
	readonly to: string;
	readonly checkedAt: string;
	readonly reason?: string;
	readonly findingIds?: readonly string[];
	readonly waivedAt?: string;
	readonly waivedBy?: string;
}

export function validateStructuredFinding(value: unknown): string[] {
	if (!isRecord(value)) return ["finding must be an object"];
	const errors: string[] = [];
	if (!nonEmpty(value.id)) errors.push("finding.id must be non-empty");
	if (!FINDING_SEVERITIES.includes(value.severity as FindingSeverity))
		errors.push("finding.severity is unsupported");
	if (!nonEmpty(value.category))
		errors.push("finding.category must be non-empty");
	if (!nonEmpty(value.actual)) errors.push("finding.actual must be non-empty");
	if (
		value.line !== undefined &&
		(!Number.isSafeInteger(value.line) || Number(value.line) < 1)
	)
		errors.push("finding.line must be a positive safe integer");
	if (
		value.evidence !== undefined &&
		(!Array.isArray(value.evidence) || value.evidence.some((v) => !nonEmpty(v)))
	)
		errors.push("finding.evidence must contain non-empty strings");
	return errors;
}

export function validateTransitionGate(value: unknown): string[] {
	if (!isRecord(value)) return ["gate must be an object"];
	const errors: string[] = [];
	if (!nonEmpty(value.id)) errors.push("gate.id must be non-empty");
	if (!TRANSITION_GATE_KINDS.includes(value.kind as TransitionGateKind))
		errors.push("gate.kind is unsupported");
	if (!TRANSITION_GATE_STATUSES.includes(value.status as TransitionGateStatus))
		errors.push("gate.status is unsupported");
	if (!nonEmpty(value.from) || !nonEmpty(value.to))
		errors.push("gate.from and gate.to must be non-empty");
	if (!validTimestamp(value.checkedAt))
		errors.push("gate.checkedAt must be an ISO timestamp");
	if (value.status === "blocked" && !nonEmpty(value.reason))
		errors.push("blocked gate requires a reason");
	if (
		value.status === "waived" &&
		(!validTimestamp(value.waivedAt) || !nonEmpty(value.waivedBy))
	)
		errors.push("waived gate requires waivedAt and waivedBy");
	if (
		value.status !== "waived" &&
		(value.waivedAt !== undefined || value.waivedBy !== undefined)
	)
		errors.push("only waived gates may carry waiver metadata");
	if (
		value.findingIds !== undefined &&
		(!Array.isArray(value.findingIds) ||
			value.findingIds.some((v) => !nonEmpty(v)))
	)
		errors.push("gate.findingIds must contain non-empty strings");
	if (
		value.kind === "findings" &&
		(!Array.isArray(value.findingIds) || value.findingIds.length === 0)
	)
		errors.push("findings gate requires findingIds");
	return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function validTimestamp(value: unknown): value is string {
	return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

// ─── Minimal cross-boundary summaries ───────────────────────────────────────

export interface DeliverableSummary {
	readonly id: DeliverableId;
	readonly title: string;
	readonly status: DeliverableStatus;
	readonly completedAt?: string;
	readonly failure?: DeliveryFailure;
}

export interface WorkItemSummary {
	readonly id: WorkItemId;
	readonly title: string;
	readonly kind: WorkItemKind;
	readonly done: boolean;
}
