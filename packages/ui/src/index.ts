// @vegardx/pi-ui — shared TUI component kit. Pure render(width) → string[]
// functions (snapshot-testable, plain text by default) plus thin Component
// wrappers and host-UI helpers. Widgets are parameterised over
// @vegardx/pi-contracts shapes, so this library never depends on the
// extensions that consume it.

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
	type CommitResult,
	commitQuestion,
	initQuestionnaireState,
	moveCursor,
	optionValue,
	QuestionnaireComponent,
	type QuestionnaireRenderOptions,
	type QuestionnaireState,
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
