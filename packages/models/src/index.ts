// @vegardx/pi-models — authenticated exact model selection.

export {
	activeBinding,
	familyOfModel,
	parseAliasRef,
	parseModelsSettings,
	readV2Config,
	validateModelsConfig,
} from "./catalog.js";
export { supportedEfforts } from "./efforts.js";
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
	activeRegion,
	isRegionOff,
	modelAllowedByRegion,
	REGION_OFF,
	regionError,
	regionNames,
} from "./region.js";
export { type RoleModel, resolveModelForRole } from "./resolve-for-role.js";
export {
	agentTypeForRole,
	clampEffort,
	defaultTierForAgent,
	explainAttachment,
	explainTier,
	fallbackNotice,
	type InheritedModel,
	type ModelCandidateFact,
	type ModelResolution,
	ModelResolutionError,
	type ModelResolutionRequest,
	type ModelResolutionSource,
	resolveModel,
} from "./resolver.js";
