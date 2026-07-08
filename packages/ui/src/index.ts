// @vegardx/pi-ui — shared TUI component kit. Pure render(width) → string[]
// functions (snapshot-testable, plain text by default) plus thin Component
// wrappers and host-UI helpers. Widgets are parameterised over
// @vegardx/pi-contracts shapes, so this library never depends on the
// extensions that consume it.

export {
	type ExplorerView,
	explorerTabRow,
	initExplorerView,
	isExplorerQuestion,
	optionPageLines,
	renderCompareMatrix,
	renderExplorer,
} from "./explorer.js";
export {
	defaultPalette,
	formatCount,
	formatElapsed,
	groupStatusGlyph,
	groupStatusStyle,
	type Palette,
	padRight,
	runStatusGlyph,
	runStatusStyle,
	type Style,
	truncate,
} from "./format.js";
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
