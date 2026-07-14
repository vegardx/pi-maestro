// Layered `/model`-selected direct role pools.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	getSessionRoleOverride,
	MODEL_ROLES,
	type ModelConfigScope,
	type ModelRole,
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

interface ParsedProfile {
	readonly targets: readonly string[];
	readonly targetsPresent: boolean;
	readonly direct: Partial<Record<ModelRole, ProfileRoleConfig>>;
}

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
	if (!Array.isArray(raw) || raw.length === 0 || !raw.every(valid))
		return undefined;
	return new Set(raw).size === raw.length ? ([...raw] as T[]) : undefined;
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
	return models || efforts
		? { ...(models ? { models } : {}), ...(efforts ? { efforts } : {}) }
		: undefined;
}

function extractProfile(raw: unknown): ParsedProfile | undefined {
	if (!isPlainObject(raw)) return undefined;
	const direct: Partial<Record<ModelRole, ProfileRoleConfig>> = {};
	if (isPlainObject(raw.roles)) {
		for (const [name, value] of Object.entries(raw.roles)) {
			if (!ROLE_SET.has(name)) continue;
			const role = extractRole(value);
			if (role) direct[name as ModelRole] = role;
		}
	}
	return {
		targets: validArray(raw.targets, isModelId) ?? [],
		targetsPresent: Object.hasOwn(raw, "targets"),
		direct,
	};
}

function extractModels(
	raw: unknown,
): Record<string, ParsedProfile> | undefined {
	if (
		!isPlainObject(raw) ||
		!isPlainObject(raw.models) ||
		!isPlainObject(raw.models.profiles)
	)
		return undefined;
	const profiles: Record<string, ParsedProfile> = {};
	for (const [name, value] of Object.entries(raw.models.profiles)) {
		const profile = extractProfile(value);
		if (profile) profiles[name] = profile;
	}
	return Object.keys(profiles).length ? profiles : undefined;
}

function source(scope: ModelConfigScope, profile: string, role: ModelRole) {
	return { scope, profile, role };
}

function materializeProfile(
	name: string,
	global?: ParsedProfile,
	project?: ParsedProfile,
): ProfileConfig {
	const roles: Partial<Record<ModelRole, ProfileRoleConfig>> = {};
	const sources: MutableSource = {};
	for (const role of MODEL_ROLES) {
		const g = global?.direct[role];
		const p = project?.direct[role];
		const models = p?.models ?? g?.models;
		const efforts = p?.efforts ?? g?.efforts;
		if (!models && !efforts) continue;
		roles[role] = {
			...(models ? { models } : {}),
			...(efforts ? { efforts } : {}),
		};
		sources[role] = {
			...(models
				? { models: source(p?.models ? "project" : "global", name, role) }
				: {}),
			...(efforts
				? { efforts: source(p?.efforts ? "project" : "global", name, role) }
				: {}),
		};
	}
	const profile: ProfileConfig = {
		targets:
			project?.targetsPresent && project.targets.length
				? project.targets
				: (global?.targets ?? project?.targets ?? []),
		roles,
	};
	PROFILE_SOURCES.set(profile, sources);
	return profile;
}

export function readModelsConfig(
	cwd: string,
	agentDir?: string,
): ModelsConfig | undefined {
	const manager = SettingsManager.create(cwd, agentDir);
	const global = extractModels(manager.getGlobalSettings() as unknown);
	const project = extractModels(manager.getProjectSettings() as unknown);
	if (!global && !project) return undefined;
	const names = new Set([
		...Object.keys(global ?? {}),
		...Object.keys(project ?? {}),
	]);
	return {
		profiles: Object.fromEntries(
			[...names].map((name) => [
				name,
				materializeProfile(name, global?.[name], project?.[name]),
			]),
		),
	};
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
				? source("session", active.name, role)
				: persistentSource.models,
			efforts: patchEfforts
				? source("session", active.name, role)
				: persistentSource.efforts,
		},
	};
}
