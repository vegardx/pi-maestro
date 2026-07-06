// Shared plan vocabulary. The full plan tree + engine live in the modes
// package; contracts exposes only the cross-cutting enums and lightweight
// summaries that other modules (commit, subagents) reference.

import type { GroupId, WorkItemId } from "./ids.js";

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
