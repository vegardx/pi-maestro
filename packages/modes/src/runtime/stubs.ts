// STUB: pre-rewrite modules deleted by the group-model migration. These keep
// the runtime commands/hooks compiling and inert until their real
// replacements land (view/steer/recap UI, deliverable shipping, worktrees).

import type { WorkGroup } from "../schema.js";

// STUB: maestro-tmux + markdown deleted (group model)
export const handleSteerCommand = (..._args: unknown[]) => {};
export const handleViewCommand = (..._args: unknown[]) => {};
export type ViewState = { viewPaneId: string | undefined };
export const renderPlanSummary = (_plan: unknown) => "";

// STUB: recap deleted (group model)
export const formatRecap = (..._args: unknown[]) => "";

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
// API surface the callers still consume.
export const nextShippableDeliverable = (..._args: unknown[]): any => null;
export const parkPlan = async (..._args: unknown[]): Promise<any> => {};
export const shipDeliverableFromPlan = async (
	..._args: unknown[]
): Promise<any> => ({ ok: false });
export const syncPrState = async (..._args: unknown[]): Promise<any> => ({});

// STUB: worktree/session bookkeeping deleted (group model)
export const cleanupInactiveWorktrees = (..._args: unknown[]) => {};
export const recordPlanSession = (..._args: unknown[]) => {};
