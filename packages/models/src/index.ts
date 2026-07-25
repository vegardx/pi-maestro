// @vegardx/pi-models — authenticated exact model selection.

export {
	activeV2Binding,
	familyOfModel,
	parseAliasRef,
	parseV2Settings,
	readV2Config,
	validateV2Config,
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
	resolveV2Model,
	type V2CandidateFact,
	type V2Resolution,
	V2ResolutionError,
	type V2ResolutionRequest,
	type V2ResolutionSource,
} from "./v2-resolver.js";
