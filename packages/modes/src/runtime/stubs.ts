// STUB: pre-rewrite modules deleted by the group-model migration. These keep
// the runtime commands/hooks compiling and inert until their real
// replacements land (deliverable shipping, worktrees). View/steer/recap now
// live in agent-commands.ts and group-recap.ts.

import type { WorkGroup } from "../schema.js";

// STUB: markdown plan summary deleted (group model)
export const renderPlanSummary = (_plan: unknown) => "";

// STUB: old schema exports (group model)
export type Deliverable = WorkGroup;
export type DeliverableId = string;
export const findDeliverable = (_plan: unknown, _id: string) =>
	undefined as WorkGroup | undefined;
export const planRepoMismatch = (..._args: unknown[]): string | null => null;
export const repoFor = (
	_plan: unknown,
	_d: unknown,
): { key: string; path: string; defaultBranch?: string } => ({
	key: "default",
	path: "",
});
export const repoNameFromPath = (p: string) => p.split("/").pop() ?? "";

// STUB: old shipping exports (group model). `any` returns mirror the deleted
// API surface the callers still consume. (/sync now uses the real
// reconcileShippedGroups from exec/shipper.ts; /park degrades gracefully.)
export const nextShippableDeliverable = (..._args: unknown[]): any => null;
export const shipDeliverableFromPlan = async (
	..._args: unknown[]
): Promise<any> => ({ ok: false });

// STUB: worktree/session bookkeeping deleted (group model)
export const cleanupInactiveWorktrees = (..._args: unknown[]) => {};
export const recordPlanSession = (..._args: unknown[]) => {};
