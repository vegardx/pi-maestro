// STUB: pre-rewrite modules deleted by the deliverable-model migration. These keep
// the runtime commands/hooks compiling and inert until their real
// replacements land (deliverable shipping, worktrees). View/steer/recap now
// live in agent-commands.ts and deliverable-recap.ts.

import type { DeliverableId } from "@vegardx/pi-contracts";
import type { Deliverable } from "../schema.js";

// STUB: markdown plan summary deleted (deliverable model)
export const renderPlanSummary = (_plan: unknown) => "";

// Re-export the canonical types (renamed WorkGroup + the branded id).
export type { Deliverable, DeliverableId };
export const findDeliverable = (_plan: unknown, _id: string) =>
	undefined as Deliverable | undefined;
export const planRepoMismatch = (..._args: unknown[]): string | null => null;
export const repoFor = (
	_plan: unknown,
	_d: unknown,
): { key: string; path: string; defaultBranch?: string } => ({
	key: "default",
	path: "",
});
export const repoNameFromPath = (p: string) => p.split("/").pop() ?? "";

// STUB: old shipping exports (deliverable model). `any` returns mirror the deleted
// API surface the callers still consume. (/sync now uses the real
// reconcileShippedDeliverables from exec/shipper.ts; /park degrades gracefully.)
export const nextShippableDeliverable = (..._args: unknown[]): any => null;
export const shipDeliverableFromPlan = async (
	..._args: unknown[]
): Promise<any> => ({ ok: false });

// STUB: worktree/session bookkeeping deleted (deliverable model)
export const cleanupInactiveWorktrees = (..._args: unknown[]) => {};
export const recordPlanSession = (..._args: unknown[]) => {};
