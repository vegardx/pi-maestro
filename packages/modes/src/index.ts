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
export {
	buildCorpusFixtures,
	type FixtureOptions,
	type FixturePartition,
	type FixtureSet,
	type SanitizedBashFixture,
	sanitizeCommand,
} from "./bash-corpus-fixtures.js";
export {
	buildTaxonomyReport,
	type CommandFamily,
	type CommandTaxonomy,
	classifyCorpusCommand,
	type ParserFeature,
	type TaxonomyReport,
	type TaxonomyReportOptions,
	type TaxonomyRepresentative,
	taxonomyDigest,
} from "./bash-corpus-taxonomy.js";
export {
	type BashActor,
	type BashEffect,
	type BashGuidance,
	type BashPolicyDecision,
	type BashPolicyInput,
	type BashRoute,
	classifyBashEffects,
	decideBashPolicy,
	dedicatedToolSuggestion,
} from "./bash-policy.js";
export {
	auditBashShadowCorpus,
	type BashShadowReport,
	createBashShadowPolicy,
} from "./bash-policy-shadow.js";
export {
	replayShadowPolicies,
	type ShadowBaselineReport,
	type ShadowComparison,
	type ShadowDecisionRecord,
	type ShadowPolicy,
	type ShadowPolicyDecision,
	type ShadowPolicySummary,
	type ShadowReplayInput,
	type ShadowReplayOptions,
	type ShadowRoute,
	shadowBaselineDigest,
} from "./bash-shadow-replay.js";
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
	APPLE_CONTAINER_OWNER_LABEL,
	APPLE_CONTAINER_RESEARCH_IMAGE,
	type AppleContainerCommandOptions,
	type AppleContainerCommandResult,
	type AppleContainerCommandRunner,
	type AppleContainerProbe,
	AppleContainerStrongBackend,
	type AppleContainerStrongOptions,
	createArgs as createAppleContainerArgs,
	createControllerEnvironment,
	createStrongGuestEnvironment,
	ownedContainerNames,
	SpawnAppleContainerRunner,
} from "./isolation/apple-container.js";
export {
	type IsolationBackend,
	type IsolationBackendState,
	type IsolationBackendStatus,
	type IsolationBackendTier,
	IsolationUnavailableError,
	ReservedStrongIsolationBackend,
} from "./isolation/backend.js";
export {
	createResearchEnvironment,
	LightweightSeatbeltBackend,
	type LightweightSeatbeltOptions,
	networkDestinationAllowed,
	type SandboxRuntimeAdapter,
	seatbeltConfig,
} from "./isolation/lightweight-seatbelt.js";
export {
	enumerateWorkspace,
	type ResearchWorkspace,
	ResearchWorkspaceManager,
	type ResearchWorkspaceManagerOptions,
	workspaceManifest,
} from "./isolation/workspace.js";
export {
	type OverlayComponent,
	type OverlayId,
	OverlayManager,
} from "./overlay-manager.js";
export {
	computeActiveTools,
	PLAN_TOOL_NAMES,
	toolBlockedInPlanMode,
} from "./policy.js";
export {
	DEFAULT_MAESTRO_SECTION_BYTES,
	GITHUB_PR_BODY_BYTES,
	MAESTRO_PR_BEGIN,
	MAESTRO_PR_END,
	type PrProvenanceRenderOptions,
	renderMaestroPrSection,
	updateMaestroPrBody,
} from "./pr-provenance.js";
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
	type ExecutionPolicySettings,
	readExecutionPolicySettings,
	readModesCompactionSettings,
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
export {
	type AssignmentAnalytics,
	applyWorkflowAnalyticsEvent,
	assignmentAnalytics,
	type CanonicalFindingAnalytics,
	canonicalFromReviewLedger,
	createWorkflowAnalyticsLedger,
	type FinalVerificationAnalytics,
	type RawFindingAnalytics,
	WORKFLOW_ANALYTICS_VERSION,
	type WorkflowAnalyticsEvent,
	type WorkflowAnalyticsLedger,
	type WorkflowStageAnalytics,
	workflowAnalyticsTotals,
} from "./workflow-analytics.js";

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
