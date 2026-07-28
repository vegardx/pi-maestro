// @vegardx/pi-ui — shared TUI component kit. Pure render(width) → string[]
// functions (snapshot-testable, plain text by default) plus thin Component
// wrappers and host-UI helpers. Widgets are parameterised over
// @vegardx/pi-contracts shapes, so this library never depends on the
// extensions that consume it.

export {
	AGENT_EVENT_MESSAGE_TYPE,
	type AgentCardEvent,
	buildCardBody,
	buildCardHeader,
	buildEventContent,
	buildStatsTrailer,
	clipReport,
	eventBg,
	eventColor,
	firstParagraph,
	formatDuration,
	formatEffort,
	type ResearchCardEvent,
	registerAgentCardRenderer,
	sendAgentEvent,
} from "./agent-cards.js";
export {
	type AgentViewTarget,
	openAgentLiveView,
	renderSessionEntry,
	SessionTail,
} from "./agent-view.js";
export {
	AnswerEditor,
	type AnswerModeHandle,
	type AnswerModeOptions,
	openAnswerMode,
} from "./answer-editor.js";
export {
	type ExplorerView,
	explorerTabRow,
	initExplorerView,
	isExplorerQuestion,
	optionPageLines,
	renderCompareMatrix,
	renderExplorer,
} from "./explorer.js";
export { composeFooterLine, type FooterRightCandidate } from "./footer.js";
export {
	defaultPalette,
	deliverableStatusGlyph,
	deliverableStatusStyle,
	formatCount,
	formatElapsed,
	type Palette,
	padRight,
	runStatusGlyph,
	runStatusStyle,
	type Style,
	truncate,
} from "./format.js";
export {
	type HudActions,
	type HudAgentCapabilities,
	type HudAgentLeaf,
	type HudAgentNode,
	HudComponent,
	type HudDeps,
	type HudFocusState,
	type HudPlanRow,
	type HudPlanTask,
	type HudPlanView,
	type HudQuestionRow,
	type HudSnapshot,
	type HudStatus,
	type HudTab,
	hudElapsed,
} from "./hud.js";
export {
	composeTabBar,
	type HudPanelPort,
	type HudTabCounts,
	hudTabCounts,
	MaestroEditor,
	type MaestroEditorDeps,
} from "./maestro-editor.js";
export {
	type NotifyKind,
	notify,
	notifyError,
	notifyWarning,
	setStatus,
} from "./notify.js";
export {
	PlanTreeComponent,
	type PlanTreeNode,
	type PlanTreeOptions,
	renderPlanTree,
} from "./plan-tree.js";
export {
	type ProgressBarOptions,
	renderProgressBar,
	SPINNER_FRAMES,
	spinnerFrame,
} from "./progress.js";
export {
	CollapsibleQuestionnaireComponent,
	type CollapsibleQuestionnaireOptions,
	type CommitResult,
	commitQuestion,
	initQuestionnaireState,
	isShown,
	moveCursor,
	type OverlayHandle,
	optionValue,
	paletteFromTheme,
	QuestionnaireComponent,
	type QuestionnaireRenderOptions,
	type QuestionnaireRunOptions,
	type QuestionnaireState,
	recommendedIndex,
	renderQuestionnaire,
	renderRichText,
	runQuestionnaire,
	setFreeText,
	startFreeText,
	toggleSelection,
} from "./questionnaire.js";
export {
	RunDashboardComponent,
	type RunDashboardOptions,
	type RunDashboardRow,
	renderRunDashboard,
} from "./run-dashboard.js";
