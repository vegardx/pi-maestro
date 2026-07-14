// @vegardx/pi-models — tier-based model resolution via profiles.

export {
	getModelMeta,
	type ModelMeta,
	shortModelName,
} from "./model-meta.js";
export {
	activeProfile,
	effectiveRolePool,
	isModelId,
	LEGACY_TIER_ROLES,
	readModelsConfig,
	resolveTierConfig,
	type EffectiveRolePool,
	type TierResolution,
} from "./profiles.js";
export {
	parseModelSpec,
	type ResolvedBackgroundModel,
	resolveModel,
	resolveModelWithin,
} from "./resolver.js";
export {
	type AuthenticatedRoleCandidate,
	type ExactRoleChoice,
	type ResolvedRoleModelFull,
	type RolePoolResolution,
	type RolePoolResolveOptions,
	type RoleResolveOptions,
	resolveRoleModel,
	resolveRoleModelWithin,
	resolveRolePool,
	resolveTierModel,
	supportedEfforts,
	validateRoleModelConfig,
} from "./role-resolver.js";
