// @vegardx/pi-models — preset-based model resolution with slots.

export {
	getModelMeta,
	type ModelMeta,
	shortModelName,
} from "./model-meta.js";
export { readModelsConfig } from "./presets.js";
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
	resolveSlotModel,
	validateRoleModelConfig,
} from "./role-resolver.js";
