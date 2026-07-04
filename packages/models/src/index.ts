// @vegardx/pi-models — background-model tier resolution. Maps stable tier/set
// labels (declared by extensions) to user-configured "provider/id" specs,
// with auth checked against the host model registry.

export {
	getTierModel,
	readBackgroundModels,
	writeBackgroundModel,
} from "./background.js";
export { readModelsConfig } from "./presets.js";
export {
	parseModelSpec,
	type ResolvedBackgroundModel,
	type ResolveOptions,
	resolveModel,
	resolveModelWithin,
} from "./resolver.js";
export {
	type ResolvedRoleModelFull,
	resolveRoleModel,
	resolveRoleModelWithin,
	type RoleResolveOptions,
	validateRoleModelConfig,
} from "./role-resolver.js";
export {
	BACKGROUND_SETS,
	type BackgroundModels,
	type BackgroundSet,
	TIERS,
	type Tier,
	type TierMap,
} from "./types.js";
