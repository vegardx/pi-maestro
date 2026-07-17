// Layered `/model`-activated presets and reusable exact model sets.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type ExactModelOption,
	getSessionRoleOverride,
	MODEL_ROLES,
	type ModelPresetConfig,
	type ModelRole,
	type ModelSetConfig,
	type ModelsConfig,
	type ProfileConfig,
	type ProfileRoleConfig,
	type RolePoolSource,
	type ThinkingLevel,
} from "@vegardx/pi-contracts";

const EFFORT_SET = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);
const ROLE_SET = new Set<string>(MODEL_ROLES);
type Leaf = "models" | "efforts";
type MutableSource = Partial<
	Record<ModelRole, Partial<Record<Leaf, RolePoolSource[Leaf]>>>
>;
const PROFILE_SOURCES = new WeakMap<ProfileConfig, MutableSource>();

interface ParsedPreset {
	readonly targets: readonly string[];
	readonly targetsPresent: boolean;
	readonly modelSets: Partial<Record<ModelRole, string>>;
	readonly legacyRoles: Partial<Record<ModelRole, ProfileRoleConfig>>;
}

interface ParsedModels {
	readonly modelSets: Readonly<Record<string, ModelSetConfig>>;
	readonly presets: Readonly<Record<string, ParsedPreset>>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(value: unknown): value is string {
	return (
		typeof value === "string" && value.trim() === value && value.length > 0
	);
}

export function isModelId(value: unknown): value is string {
	if (typeof value !== "string" || value.trim() !== value) return false;
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
}

/** Resolves to the live `/model` model at selection time. */
export const SESSION_MODEL_SENTINEL = "session";

function isModelReference(value: unknown): value is string {
	return isModelId(value) || value === SESSION_MODEL_SENTINEL;
}

function validArray<T>(
	raw: unknown,
	valid: (value: unknown) => value is T,
): readonly T[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0 || !raw.every(valid))
		return undefined;
	return new Set(raw).size === raw.length ? ([...raw] as T[]) : undefined;
}

function modelArray(raw: unknown): readonly string[] | undefined {
	return validArray(raw, isModelReference);
}

function effortArray(raw: unknown): readonly ThinkingLevel[] | undefined {
	return validArray(
		raw,
		(value): value is ThinkingLevel =>
			typeof value === "string" && EFFORT_SET.has(value),
	);
}

function extractLegacyRole(raw: unknown): ProfileRoleConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const models = modelArray(raw.models);
	const efforts = effortArray(raw.efforts);
	return models || efforts
		? { ...(models ? { models } : {}), ...(efforts ? { efforts } : {}) }
		: undefined;
}

function extractOption(raw: unknown): ExactModelOption | undefined {
	if (!isPlainObject(raw)) return undefined;
	if (
		!nonEmpty(raw.id) ||
		!isModelReference(raw.model) ||
		!nonEmpty(raw.summary) ||
		typeof raw.effort !== "string" ||
		!EFFORT_SET.has(raw.effort)
	)
		return undefined;
	return {
		id: raw.id,
		model: raw.model,
		effort: raw.effort as ThinkingLevel,
		summary: raw.summary,
	};
}

function extractModelSet(raw: unknown): ModelSetConfig | undefined {
	const values = Array.isArray(raw)
		? raw
		: isPlainObject(raw) && Array.isArray(raw.options)
			? raw.options
			: undefined;
	if (!values || values.length === 0) return undefined;
	const options = values.map(extractOption);
	if (options.some((option) => !option)) return undefined;
	const concrete = options as ExactModelOption[];
	if (new Set(concrete.map((option) => option.id)).size !== concrete.length)
		return undefined;
	return { options: concrete };
}

function extractPreset(raw: unknown): ParsedPreset | undefined {
	if (!isPlainObject(raw)) return undefined;
	const modelSets: Partial<Record<ModelRole, string>> = {};
	const rawSets = isPlainObject(raw.modelSets)
		? raw.modelSets
		: isPlainObject(raw.sets)
			? raw.sets
			: undefined;
	if (rawSets) {
		for (const [role, setId] of Object.entries(rawSets)) {
			if (ROLE_SET.has(role) && nonEmpty(setId))
				modelSets[role as ModelRole] = setId;
		}
	}
	const legacyRoles: Partial<Record<ModelRole, ProfileRoleConfig>> = {};
	if (isPlainObject(raw.roles)) {
		for (const [role, value] of Object.entries(raw.roles)) {
			if (!ROLE_SET.has(role)) continue;
			const legacy = extractLegacyRole(value);
			if (legacy) legacyRoles[role as ModelRole] = legacy;
		}
	}
	return {
		targets: validArray(raw.targets, isModelId) ?? [],
		targetsPresent: Object.hasOwn(raw, "targets"),
		modelSets,
		legacyRoles,
	};
}

function extractModels(raw: unknown): ParsedModels | undefined {
	if (!isPlainObject(raw) || !isPlainObject(raw.models)) return undefined;
	const root = raw.models;
	const modelSets: Record<string, ModelSetConfig> = {};
	if (isPlainObject(root.modelSets)) {
		for (const [name, value] of Object.entries(root.modelSets)) {
			const set = extractModelSet(value);
			if (set) modelSets[name] = set;
		}
	}
	const presetRoot = isPlainObject(root.presets)
		? root.presets
		: isPlainObject(root.profiles)
			? root.profiles
			: undefined;
	const presets: Record<string, ParsedPreset> = {};
	if (presetRoot) {
		for (const [name, value] of Object.entries(presetRoot)) {
			const preset = extractPreset(value);
			if (preset) presets[name] = preset;
		}
	}
	return Object.keys(modelSets).length || Object.keys(presets).length
		? { modelSets, presets }
		: undefined;
}

function mergePreset(
	global: ParsedPreset | undefined,
	project: ParsedPreset | undefined,
): ParsedPreset {
	return {
		targets:
			project?.targetsPresent && project.targets.length
				? project.targets
				: (global?.targets ?? project?.targets ?? []),
		targetsPresent: project?.targetsPresent ?? global?.targetsPresent ?? false,
		modelSets: { ...global?.modelSets, ...project?.modelSets },
		legacyRoles: Object.fromEntries(
			MODEL_ROLES.flatMap((role) => {
				const g = global?.legacyRoles[role];
				const p = project?.legacyRoles[role];
				const models = p?.models ?? g?.models;
				const efforts = p?.efforts ?? g?.efforts;
				return models || efforts
					? [
							[
								role,
								{
									...(models ? { models } : {}),
									...(efforts ? { efforts } : {}),
								},
							],
						]
					: [];
			}),
		),
	};
}

function compatibilityProfile(
	name: string,
	preset: ParsedPreset,
	global?: ParsedPreset,
	project?: ParsedPreset,
): ProfileConfig {
	const profile: ProfileConfig = {
		targets: preset.targets,
		roles: preset.legacyRoles,
	};
	const sources: MutableSource = {};
	for (const role of MODEL_ROLES) {
		const g = global?.legacyRoles[role];
		const p = project?.legacyRoles[role];
		sources[role] = {
			...(p?.models || g?.models
				? {
						models: {
							scope: p?.models ? "project" : "global",
							profile: name,
							role,
						},
					}
				: {}),
			...(p?.efforts || g?.efforts
				? {
						efforts: {
							scope: p?.efforts ? "project" : "global",
							profile: name,
							role,
						},
					}
				: {}),
		};
	}
	PROFILE_SOURCES.set(profile, sources);
	return profile;
}

export function validatePresetTargets(cfg: ModelsConfig): void {
	const owner = new Map<string, string>();
	for (const [presetId, preset] of Object.entries(cfg.presets)) {
		for (const target of preset.targets) {
			const previous = owner.get(target);
			if (previous && previous !== presetId) {
				throw new Error(
					`Model preset target ${target} overlaps between ${previous} and ${presetId}`,
				);
			}
			owner.set(target, presetId);
		}
	}
}

export function readModelsConfig(
	cwd: string,
	agentDir?: string,
): ModelsConfig | undefined {
	const manager = SettingsManager.create(cwd, agentDir);
	const global = extractModels(manager.getGlobalSettings() as unknown);
	const project = extractModels(manager.getProjectSettings() as unknown);
	if (!global && !project) return undefined;
	const modelSets = { ...global?.modelSets, ...project?.modelSets };
	const names = new Set([
		...Object.keys(global?.presets ?? {}),
		...Object.keys(project?.presets ?? {}),
	]);
	const merged = Object.fromEntries(
		[...names].map((name) => [
			name,
			mergePreset(global?.presets[name], project?.presets[name]),
		]),
	) as Record<string, ParsedPreset>;
	const presets: Record<string, ModelPresetConfig> = Object.fromEntries(
		Object.entries(merged).map(([name, preset]) => [
			name,
			{ targets: preset.targets, modelSets: preset.modelSets },
		]),
	);
	const profiles = Object.fromEntries(
		Object.entries(merged).map(([name, preset]) => [
			name,
			compatibilityProfile(
				name,
				preset,
				global?.presets[name],
				project?.presets[name],
			),
		]),
	);
	const config: ModelsConfig = { modelSets, presets, profiles };
	validatePresetTargets(config);
	return config;
}

export function activePreset(
	cfg: ModelsConfig | undefined,
	sessionModelId: string | undefined,
): { id: string; preset: ModelPresetConfig } | undefined {
	if (!cfg || !sessionModelId) return undefined;
	const matches = Object.entries(cfg.presets).filter(([, preset]) =>
		preset.targets.includes(sessionModelId),
	);
	if (matches.length > 1)
		throw new Error(
			`Model preset target ${sessionModelId} has multiple owners`,
		);
	const match = matches[0];
	return match ? { id: match[0], preset: match[1] } : undefined;
}

/** @deprecated Compatibility alias used by the existing settings surface. */
export function activeProfile(
	cfg: ModelsConfig | undefined,
	sessionModelId: string | undefined,
): { name: string; profile: ProfileConfig } | undefined {
	const active = activePreset(cfg, sessionModelId);
	return active && cfg
		? { name: active.id, profile: cfg.profiles[active.id] }
		: undefined;
}

export interface EffectiveRolePool {
	readonly profile: string;
	readonly role: ModelRole;
	readonly models: readonly string[];
	readonly efforts: readonly ThinkingLevel[];
	readonly provenance: RolePoolSource;
}

/** @deprecated Compatibility projection for the settings editor. */
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
	return {
		profile: active.name,
		role,
		models: patchModels ?? persistent?.models ?? [],
		efforts: patchEfforts ?? persistent?.efforts ?? [],
		provenance: {
			models: patchModels
				? { scope: "session", profile: active.name, role }
				: persistentSource.models,
			efforts: patchEfforts
				? { scope: "session", profile: active.name, role }
				: persistentSource.efforts,
		},
	};
}
