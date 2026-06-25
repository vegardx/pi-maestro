// @vegardx/pi-modes — permission modes, plan/deliverable engine, execution,
// shipping, and compaction. This child wires the mode runtime, plan tools,
// commands, Shift+Tab cycle, policy gates, session hydration, and modes.v1
// capability. Execution/worktrees/shipping/compaction land in later children.

import { defineExtension } from "@vegardx/pi-core";
import { createModesRuntime } from "./runtime.js";

export { ModesAskQueue } from "./ask-queue.js";
export {
	buildCompactionInstructions,
	buildCompactionSeed,
	createCrashSnapshot,
	shouldOwnCompaction,
} from "./compaction.js";
export { PLAN_CONTAINER, PlanEngine } from "./engine.js";
export {
	classifyExecutionSteering,
	completeActiveDeliverable,
	completionGateSatisfied,
	FanoutOrchestrator,
	parseShippedPr,
	startSequentialExecution,
	transitionThrough,
} from "./execution.js";
export { renderPlanMarkdown, renderPlanSeed } from "./markdown.js";
export {
	classifyBash,
	computeActiveTools,
	PLAN_TOOL_NAMES,
	toolBlockedInPlanMode,
} from "./policy.js";
export { createModesRuntime } from "./runtime.js";
export * from "./schema.js";
export {
	appendModesState,
	hydrateModesState,
	MODES_STATE_ENTRY,
	toPersistedState,
} from "./session.js";
export {
	deliverableIssueBody,
	nextShippableDeliverable,
	parkPlan,
	shipDeliverableFromPlan,
	sweepMergedPrs,
	syncPrState,
} from "./shipping.js";
export {
	initialModesState,
	MODE_CYCLE,
	nextMode,
	setActivePlan,
	transitionMode,
} from "./state.js";
export { createPlanStore, plansRoot } from "./storage.js";
export {
	createDeliverableTool,
	createPlanTool,
	createPlanTools,
	createTaskTool,
} from "./tools.js";
export { renderModeFooter, renderPlanPanel, renderPlanSidebar } from "./ui.js";
export {
	activateDeliverableWorktree,
	cleanupInactiveWorktrees,
	deliverableSessionSeed,
	deliverableWorktreePath,
	reconcileWorktrees,
	recordDeliverableSession,
	recordPlanSession,
} from "./worktree.js";

export default defineExtension(
	{
		name: "modes",
		path: "packages/modes/src/index.ts",
		doc: "Permission modes, plan engine/tools, execution and shipping orchestration.",
	},
	(pi, maestro) => {
		createModesRuntime(pi, maestro);
	},
);
