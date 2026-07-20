// @vegardx/pi-models — authenticated exact model selection.

export {
	activeV2Profile,
	isV2ProfileShape,
	parseV2Settings,
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
	type ResolvedModelAuth,
	resolveModelAuth,
} from "./model-auth.js";
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
export { buildV2FromV1, MODELS_V2_MIGRATION } from "./v2-migration.js";
export {
	clampEffort,
	explainCatalogEntry,
	explainTier,
	fallbackNotice,
	type InheritedModel,
	resolveV2Model,
	type V2CandidateFact,
	type V2Resolution,
	V2ResolutionError,
	type V2ResolutionRequest,
	type V2ResolutionSource,
} from "./v2-resolver.js";
