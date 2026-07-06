// Shared plan vocabulary. The full plan tree + engine live in the modes
// package; contracts exposes only the cross-cutting enums and lightweight
// summaries that other modules (commit, subagents) reference.

import type { DeliverableId, GroupId, WorkItemId } from "./ids.js";

// ─── Group statuses ──────────────────────────────────────────────────────────

export const GROUP_STATUSES = [
	"planned",
	"active",
	"complete",
	"shipped",
	"superseded",
	"abandoned",
] as const;

export type GroupStatus = (typeof GROUP_STATUSES)[number];

// ─── Work item kinds ─────────────────────────────────────────────────────────

export const WORK_ITEM_KINDS = [
	"task",
	"followup",
	"question",
	"manual",
] as const;

export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

// ─── Agent mode ──────────────────────────────────────────────────────────────

export type AgentMode = "full" | "read-only";

// ─── Model slot ──────────────────────────────────────────────────────────────

export type ModelSlot = "default" | "alternate";

// ─── Minimal cross-boundary summaries ────────────────────────────────────────

/** Minimal group view passed across capability boundaries. */
export interface GroupSummary {
	readonly id: GroupId;
	readonly title: string;
	readonly status: GroupStatus;
}

/** Minimal work-item view passed across capability boundaries. */
export interface WorkItemSummary {
	readonly id: WorkItemId;
	readonly title: string;
	readonly kind: WorkItemKind;
	readonly done: boolean;
}

// ─── Backwards-compat (removed in cleanup task) ──────────────────────────────

/** @deprecated Use GROUP_STATUSES */
export const DELIVERABLE_STATUSES = [
	"planned",
	"active",
	"in-review",
	"needs-attention",
	"ready-to-ship",
	"shipped",
	"abandoned",
] as const;

/** @deprecated Use GroupStatus */
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

/** @deprecated Removed in group model */
export type DeliverableLifecycle = "pre" | "post";

/** @deprecated Use GroupSummary */
export interface DeliverableSummary {
	readonly id: DeliverableId;
	readonly title: string;
	readonly status: DeliverableStatus;
	readonly lifecycle?: DeliverableLifecycle;
}
