// @vegardx/pi-models — authenticated ordered role-pool resolution.

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
	activeProfile,
	type EffectiveRolePool,
	effectiveRolePool,
	isModelId,
	readModelsConfig,
	SESSION_MODEL_SENTINEL,
	validatePresetTargets,
} from "./profiles.js";
export {
	type AuthenticatedRoleCandidate,
	type ExactRoleChoice,
	type ResolvedRoleModelFull,
	type RolePoolResolution,
	type RolePoolResolveOptions,
	resolveRolePool,
	resolveRolePoolWithin,
	resolveSentinelPool,
	supportedEfforts,
} from "./role-resolver.js";
