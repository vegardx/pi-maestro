// @vegardx/pi-models — tier-based model resolution via profiles.

export {
	getModelMeta,
	type ModelMeta,
	shortModelName,
} from "./model-meta.js";
export {
	activeProfile,
	readModelsConfig,
	resolveTierConfig,
	type TierResolution,
} from "./profiles.js";
export {
	parseModelSpec,
	type ResolvedBackgroundModel,
	resolveModel,
	resolveModelWithin,
} from "./resolver.js";
export {
	type ResolvedRoleModelFull,
	type RoleResolveOptions,
	resolveRoleModel,
	resolveRoleModelWithin,
	resolveTierModel,
	validateRoleModelConfig,
} from "./role-resolver.js";
