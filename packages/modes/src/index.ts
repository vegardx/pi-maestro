// @vegardx/pi-modes — permission modes, plan/deliverable engine, execution,
// shipping, and compaction. This child wires the mode runtime, plan tools,
// commands, Shift+Tab cycle, policy gates, session hydration, and modes.v1
// capability. Execution/worktrees/shipping/compaction land in later children.

import { defineExtension } from "@vegardx/pi-core";
import { createModesRuntime } from "./runtime/index.js";

export { AgentBridge, initAgentBridge, isAgentMode } from "./agent-bridge.js";
export { ModesAskQueue } from "./ask-queue.js";
export {
	type AgentPosture,
	type BashCorpusCall,
	type BashCorpusOutcome,
	type CorpusActor,
	type CorpusDiagnostic,
	type CorpusMode,
	type ExtractCorpusOptions,
	extractBashCorpusFile,
	extractBashCorpusJsonl,
	type SessionCorpus,
} from "./bash-corpus.js";
export type {
	CompactionBucketSnapshot,
	CompactionDecision,
	DeliverableSliceResult,
	DependencySummary,
	ModesCompactionDetails,
	PendingModesCompaction,
	SummariseFn,
	SummariseOutput,
} from "./compaction.js";
export {
	buildCarryForwardSummary,
	buildCompactionMarker,
	buildDeliverableSliceCompactionResult,
	buildEndSummaryPreamble,
	buildSummariserPreamble,
	buildSummary,
	COMPACTION_SCHEMA_VERSION,
	collectDependencySummaries,
	countDeliverableSlicesOnBranch,
	createCrashSnapshot,
	decideCompactionOwnership,
	downstreamDependents,
	findLatestCompactionSummary,
	readModesCompactionDetails,
	renderDeliverableSection,
	summaryHash,
	transitiveDependencies,
} from "./compaction.js";
export {
	type AgentState,
	DeliverableExecutor,
	type DeliverableRunState,
	type ExecutorDeps,
} from "./deliverable-executor.js";
export { buildRecap } from "./deliverable-recap.js";
export { PlanEngine } from "./engine.js";
export {
	createExecution,
	type ExecutionHandle,
} from "./exec/index.js";
export { composeFooterLine, type FooterRightCandidate } from "./footer.js";
export {
	buildForwardSummaryPrompt,
	buildPlanAwareCompactionMarker,
	type ForwardSummaryInput,
} from "./forward-summary.js";
export {
	type FooterDeps,
	formatCacheHitRate,
	formatModelLabel,
	formatSessionUsage,
	installFooter,
} from "./install-footer.js";
export {
	type OverlayComponent,
	type OverlayId,
	OverlayManager,
} from "./overlay-manager.js";
export {
	classifyBash,
	computeActiveTools,
	PLAN_TOOL_NAMES,
	toolBlockedInPlanMode,
} from "./policy.js";
export {
	createModesRuntime,
	type ModesRuntime,
	type ModesRuntimeOptions,
} from "./runtime/index.js";
export * from "./schema.js";
export {
	appendModesState,
	collectCarryForwardInput,
	EXECUTION_SEED_ENTRY,
	hasExecutionSeed,
	hydrateModesState,
	MODES_STATE_ENTRY,
	resolveShipSummaryInput,
	toPersistedState,
} from "./session.js";
export {
	getImplementOverrides,
	type ImplementOverrides,
	readModesCompactionSettings,
	resolveInternalRoleModel,
	setImplementOverrides,
} from "./settings.js";
export {
	buildPrBody,
	shouldShip,
} from "./shipping.js";
export {
	initialModesState,
	MODE_CYCLE,
	nextMode,
	setActivePlan,
	setExecution,
	transitionMode,
} from "./state.js";
export { createPlanStore, plansRoot } from "./storage.js";
export { createModesSummariser } from "./summarise.js";
export {
	createAgentTool,
	createDeliverableTool,
	createPlanTool,
	createTaskTool,
} from "./tools.js";
export { renderModeFooter, renderPlanPanel, renderPlanSidebar } from "./ui.js";

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
