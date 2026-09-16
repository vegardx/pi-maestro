// @vegardx/pi-models — authenticated ordered role-pool model resolution.
//
// Families → aliases → concrete `provider/model` attachments; rosters order
// aliases into light/standard/heavy tiers; bindings select a roster from the
// seat model; a region allowlist and per-persona tier allowances bound what
// anything may reach. `createModelRouter(config, port)` answers a role with one
// serializable `ModelResolution`.
//
// The package has NO dependency on Pi: everything it needs from a host is the
// three-method `ModelCatalogPort`. Reading settings off disk, building the port
// from a model registry, and authenticating a resolved model are the host's
// job, not this package's.

export {
	activeBinding,
	familyOfModel,
	parseAliasRef,
	parseModelsSettings,
	validateModelsConfig,
} from "./config.js";
export { supportedEfforts } from "./efforts.js";
export {
	isModelId,
	type ParsedModelSpec,
	parseModelSpec,
} from "./model-spec.js";
export {
	type CatalogModel,
	EMPTY_CATALOG_PORT,
	type ModelCatalogPort,
} from "./port.js";
export {
	activeRegion,
	isRegionOff,
	modelAllowedByRegion,
	REGION_OFF,
	regionError,
	regionNames,
} from "./region.js";
export {
	MODEL_ROLES,
	type ModelRole,
	personaForRole,
} from "./roles.js";
export {
	clampEffort,
	createModelRouter,
	fallbackNotice,
	type InheritedModel,
	type ModelCandidateFact,
	type ModelResolution,
	ModelResolutionError,
	type ModelResolutionRequest,
	type ModelResolutionSource,
	type ModelRouter,
	type ModelRouterConfig,
	type RoleRouteRequest,
	type TierExplanation,
} from "./router.js";
export { THINKING_LEVELS, type ThinkingLevel } from "./thinking.js";
export {
	type AgentAllowanceConfig,
	type AliasConfig,
	type BindingConfig,
	DEFAULT_PERSONA_ALLOWANCES,
	DIRECT_SELECTORS,
	type DirectSelector,
	type FamilyConfig,
	MAX_SPREAD,
	type ModelsConfig,
	type RegionConfig,
	type RosterTiers,
	TIER_IDS,
	type TierId,
} from "./vocabulary.js";
