// @vegardx/pi-models — authenticated ordered role-pool resolution.

export {
	getModelMeta,
	type ModelMeta,
	shortModelName,
} from "./model-meta.js";
export { type ParsedModelSpec, parseModelSpec } from "./model-spec.js";
export {
	activeProfile,
	type EffectiveRolePool,
	effectiveRolePool,
	isModelId,
	readModelsConfig,
} from "./profiles.js";
export {
	type AuthenticatedRoleCandidate,
	type ExactRoleChoice,
	type ResolvedRoleModelFull,
	type RolePoolResolution,
	type RolePoolResolveOptions,
	resolveRolePool,
	resolveRolePoolWithin,
	supportedEfforts,
} from "./role-resolver.js";
