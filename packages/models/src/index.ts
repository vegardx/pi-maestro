// @vegardx/pi-models — authenticated exact model selection.

export {
	activeV2Profile,
	isV2ProfileShape,
	readV2Config,
	validateV2Config,
} from "./catalog.js";
export { supportedEfforts } from "./efforts.js";
export {
	type AssignmentSelectionOptions,
	type AuthenticatedExactModelSelection,
	type ExactSelectionOptions,
	type ExactSelectionResolution,
	type PersistedExactAssignment,
	resolveAgentAssignment,
	resolveExactModelSelection,
} from "./exact-selection.js";
export {
	getModelMeta,
	type ModelMeta,
	shortModelName,
} from "./model-meta.js";
export { type ParsedModelSpec, parseModelSpec } from "./model-spec.js";
export {
	activePreset,
	isModelId,
	readModelsConfig,
	SESSION_MODEL_SENTINEL,
	validatePresetTargets,
} from "./profiles.js";
export {
	activeResidency,
	isResidencyOff,
	modelAllowedByResidency,
	RESIDENCY_OFF,
	residencyError,
	residencyNames,
} from "./residency.js";
