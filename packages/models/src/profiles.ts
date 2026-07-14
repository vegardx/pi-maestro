// Layered `/model`-selected role profiles with deprecated tier input support.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	getSessionRoleOverride,
	MODEL_ROLES,
	type LegacyPinnableTier,
	type LegacyTierConfig,
	type ModelConfigScope,
	type ModelRole,
	type ModelsConfig,
	type ProfileConfig,
	type ProfileRoleConfig,
	type RolePoolSource,
	type ThinkingLevel,
	type Tier,
} from "@vegardx/pi-contracts";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const EFFORT_SET = new Set<string>(EFFORTS);
const ROLE_SET = new Set<string>(MODEL_ROLES);

/** Legacy fan-out is intentionally centralized and read-only. */
export const LEGACY_TIER_ROLES: Readonly<
	Record<LegacyPinnableTier, readonly ModelRole[]>
> = {
	work: ["worker", "delegate"],
	review: ["reviewer", "advisor", "verifier"],
	fast: [
		"research",
		"classifier",
		"plan-summarizer",
		"compact-summarizer",
	],
};

interface ParsedProfile {
	readonly targets: readonly string[];
	readonly targetsPresent: boolean;
	readonly direct: Partial<Record<ModelRole, ProfileRoleConfig>>;
	readonly legacy: Partial<Record<LegacyPinnableTier, LegacyTierConfig>>;
}

interface ParsedModels {
	readonly profiles: Readonly<Record<string, ParsedProfile>>;
}

type Leaf = "models" | "efforts";
type MutableSource = Partial<Record<ModelRole, Partial<Record<Leaf, RolePoolSource[Leaf]>>>>;
const PROFILE_SOURCES = new WeakMap<ProfileConfig, MutableSource>();

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isModelId(value: unknown): value is string {
	if (typeof value !== "string" || value.trim() !== value) return false;
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
}

function validArray<T>(
	raw: unknown,
	valid: (value: unknown) => value is T,
): readonly T[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0 || !raw.every(valid)) {
		return undefined;
	}
	const values = raw as T[];
	return new Set(values).size === values.length ? [...values] : undefined;
}

function modelArray(raw: unknown): readonly string[] | undefined {
	return validArray(raw, isModelId);
}

function effortArray(raw: unknown): readonly ThinkingLevel[] | undefined {
	return validArray(
		raw,
		(value): value is ThinkingLevel =>
			typeof value === "string" && EFFORT_SET.has(value),
	);
}

function extractRole(raw: unknown): ProfileRoleConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const models = modelArray(raw.models);
	const efforts = effortArray(raw.efforts);
	if (!models && !efforts) return undefined;
	return { ...(models ? { models } : {}), ...(efforts ? { efforts } : {}) };
}

function extractLegacy(raw: unknown): LegacyTierConfig | undefined {
	if (typeof raw === "string") return isModelId(raw) ? { model: raw } : undefined;
	if (!isPlainObject(raw)) return undefined;
	const model = isModelId(raw.model) ? raw.model : undefined;
	const effort =
		typeof raw.effort === "string" && EFFORT_SET.has(raw.effort)
			? (raw.effort as ThinkingLevel)
			: undefined;
	if (!model && !effort) return undefined;
	return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

function extractProfile(raw: unknown): ParsedProfile | undefined {
	if (!isPlainObject(raw)) return undefined;
	const targetsPresent = Object.hasOwn(raw, "targets");
	const targets = validArray(raw.targets, isModelId) ?? [];
	const direct: Partial<Record<ModelRole, ProfileRoleConfig>> = {};
	if (isPlainObject(raw.roles)) {
		for (const [name, value] of Object.entries(raw.roles)) {
			// Unknown role names and malformed role values never enter config.
			if (!ROLE_SET.has(name)) continue;
			const role = extractRole(value);
			if (role) direct[name as ModelRole] = role;
		}
	}
	const legacy: Partial<Record<LegacyPinnableTier, LegacyTierConfig>> = {};
	for (const tier of ["work", "review", "fast"] as const) {
		const value = extractLegacy(raw[tier]);
		if (value) legacy[tier] = value;
	}
	return { targets, targetsPresent, direct, legacy };
}

function extractModels(raw: unknown): ParsedModels | undefined {
	if (!isPlainObject(raw) || !isPlainObject(raw.models)) return undefined;
	const rawProfiles = raw.models.profiles;
	if (!isPlainObject(rawProfiles)) return undefined;
	const profiles: Record<string, ParsedProfile> = {};
	for (const [name, value] of Object.entries(rawProfiles)) {
		const profile = extractProfile(value);
		if (profile) profiles[name] = profile;
	}
	return Object.keys(profiles).length > 0 ? { profiles } : undefined;
}

function source(
	scope: ModelConfigScope,
	profile: string,
	role: ModelRole,
	legacyTier?: LegacyPinnableTier,
) {
	return { scope, profile, role, ...(legacyTier ? { legacyTier } : {}) };
}

function materializeProfile(
	name: string,
	global: ParsedProfile | undefined,
	project: ParsedProfile | undefined,
): ProfileConfig {
	const roles: Partial<Record<ModelRole, ProfileRoleConfig>> = {};
	const sources: MutableSource = {};
	for (const role of MODEL_ROLES) {
		const g = global?.direct[role];
		const p = project?.direct[role];
		let models = p?.models ?? g?.models;
		let efforts = p?.efforts ?? g?.efforts;
		let modelsSource = p?.models
			? source("project", name, role)
			: g?.models
				? source("global", name, role)
				: undefined;
		let effortsSource = p?.efforts
			? source("project", name, role)
			: g?.efforts
				? source("global", name, role)
				: undefined;

		// Direct leaves at either persistent scope always beat legacy fallback.
		for (const tier of ["work", "review", "fast"] as const) {
			if (!LEGACY_TIER_ROLES[tier].includes(role)) continue;
			const pLegacy = project?.legacy[tier];
			const gLegacy = global?.legacy[tier];
			if (!models) {
				const model = pLegacy?.model ?? gLegacy?.model;
				if (model) {
					models = [model];
					modelsSource = source(
						pLegacy?.model ? "project" : "global",
						name,
						role,
						tier,
					);
				}
			}
			if (!efforts) {
				const effort = pLegacy?.effort ?? gLegacy?.effort;
				if (effort) {
					efforts = [effort];
					effortsSource = source(
						pLegacy?.effort ? "project" : "global",
						name,
						role,
						tier,
					);
				}
			}
			break;
		}
		if (models || efforts) {
			roles[role] = {
				...(models ? { models } : {}),
				...(efforts ? { efforts } : {}),
			};
			sources[role] = {
				...(modelsSource ? { models: modelsSource } : {}),
				...(effortsSource ? { efforts: effortsSource } : {}),
			};
		}
	}
	const targets = project?.targetsPresent
		? project.targets
		: (global?.targets ?? project?.targets ?? []);
	const profile: ProfileConfig = {
		targets,
		roles,
		// Preserve parsed compatibility input for old settings/UI readers.
		work: project?.legacy.work ?? global?.legacy.work,
		review: project?.legacy.review ?? global?.legacy.review,
		fast: project?.legacy.fast ?? global?.legacy.fast,
	};
	PROFILE_SOURCES.set(profile, sources);
	return profile;
}

/** Read global/project profiles; project role arrays replace global per leaf. */
export function readModelsConfig(
	cwd: string,
	agentDir?: string,
): ModelsConfig | undefined {
	const manager = SettingsManager.create(cwd, agentDir);
	const global = extractModels(manager.getGlobalSettings() as unknown);
	const project = extractModels(manager.getProjectSettings() as unknown);
	if (!global && !project) return undefined;
	const names = new Set([
		...Object.keys(global?.profiles ?? {}),
		...Object.keys(project?.profiles ?? {}),
	]);
	const profiles: Record<string, ProfileConfig> = {};
	for (const name of names) {
		profiles[name] = materializeProfile(
			name,
			global?.profiles[name],
			project?.profiles[name],
		);
	}
	return { profiles };
}

export function activeProfile(
	cfg: ModelsConfig | undefined,
	sessionModelId: string | undefined,
): { name: string; profile: ProfileConfig } | undefined {
	if (!cfg || !sessionModelId) return undefined;
	for (const [name, profile] of Object.entries(cfg.profiles)) {
		if (profile.targets.includes(sessionModelId)) return { name, profile };
	}
	return undefined;
}

export interface EffectiveRolePool {
	readonly profile: string;
	readonly role: ModelRole;
	readonly models: readonly string[];
	readonly efforts: readonly ThinkingLevel[];
	readonly provenance: RolePoolSource;
}

/** Apply the typed session patch to an active persistent role pool. */
export function effectiveRolePool(
	cfg: ModelsConfig | undefined,
	role: ModelRole,
	sessionModelId: string | undefined,
): EffectiveRolePool | undefined {
	const active = activeProfile(cfg, sessionModelId);
	if (!active) return undefined;
	const persistent = active.profile.roles[role];
	const persistentSource = PROFILE_SOURCES.get(active.profile)?.[role] ?? {};
	const patch = getSessionRoleOverride(active.name, role);
	const patchModels = patch ? modelArray(patch.models) : undefined;
	const patchEfforts = patch ? effortArray(patch.efforts) : undefined;
	const models = patchModels ?? persistent?.models ?? [];
	const efforts = patchEfforts ?? persistent?.efforts ?? [];
	return {
		profile: active.name,
		role,
		models,
		efforts,
		provenance: {
			models: patchModels
				? source("session", active.name, role)
				: persistentSource.models,
			efforts: patchEfforts
				? source("session", active.name, role)
				: persistentSource.efforts,
		},
	};
}

// ─── Deprecated tier facade for unchanged runtime callers ──────────────────

export interface TierResolution {
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
	readonly tier: Tier;
	readonly tracksPlan: boolean;
	readonly profile?: string;
}

const TIER_ROLE: Record<Exclude<Tier, "plan">, ModelRole> = {
	work: "worker",
	review: "reviewer",
	fast: "research",
};

/** @deprecated Resolve a ModelRole pool instead. */
export function resolveTierConfig(
	cfg: ModelsConfig | undefined,
	tier: Tier,
	session: { modelId: string; effort?: ThinkingLevel } | undefined,
): TierResolution | undefined {
	if (tier === "plan") {
		return session
			? { ...session, tier, tracksPlan: true }
			: undefined;
	}
	const pool = effectiveRolePool(cfg, TIER_ROLE[tier], session?.modelId);
	if (pool?.models[0]) {
		return {
			modelId: pool.models[0],
			effort: pool.efforts[0],
			tier,
			tracksPlan: false,
			profile: pool.profile,
		};
	}
	if (!session) return undefined;
	return {
		modelId: session.modelId,
		effort: pool?.efforts[0] ?? session.effort,
		tier,
		tracksPlan: true,
		profile: pool?.profile,
	};
}
