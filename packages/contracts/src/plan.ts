// Shared plan vocabulary. The full plan tree + engine live in the modes
// package; contracts exposes only the cross-cutting enums and lightweight
// summaries that other modules (commit, subagents) reference.

import type { DeliverableId, WorkItemId } from "./ids.js";

export const DELIVERABLE_STATUSES = [
	"planned",
	"active",
	"in-review",
	"needs-attention",
	"ready-to-ship",
	"shipped",
	"abandoned",
] as const;

export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

export const WORK_ITEM_KINDS = [
	"task",
	"followup",
	"question",
	"manual",
] as const;

export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

/** A plan-boundary checklist that gates (`pre`) or trails (`post`) the plan. */
export type DeliverableLifecycle = "pre" | "post";

/** Minimal deliverable view passed across capability boundaries. */
export interface DeliverableSummary {
	readonly id: DeliverableId;
	readonly title: string;
	readonly status: DeliverableStatus;
	readonly lifecycle?: DeliverableLifecycle;
}

/** Minimal work-item view passed across capability boundaries. */
export interface WorkItemSummary {
	readonly id: WorkItemId;
	readonly title: string;
	readonly kind: WorkItemKind;
	readonly done: boolean;
}
