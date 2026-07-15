// Shared normalized data and persistence operations for the interactive and
// scripting /maestro surfaces. Model arrays are ordered leaf values: a value at
// session/project replaces the lower-precedence value rather than merging.

import {
	type ExtensionContext,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	getSessionRoleOverride,
	getSessionSettingOverride,
	MODEL_ROLES,
	type ModelConfigScope,
	type ModelRole,
	type SessionSettingValue,
	setSessionRoleOverride,
	setSessionSettingOverride,
	type ThinkingLevel,
} from "@vegardx/pi-contracts";
import {
	activeProfile,
	effectiveRolePool,
	readModelsConfig,
} from "@vegardx/pi-models";
import {
	isPlainObject,
	readLayeredExtensionConfig,
	readPath,
} from "./reader.js";
import { updateSettingsFile, writeExtensionConfigKey } from "./writer.js";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const satisfies readonly ThinkingLevel[];

export type RoleLeaf = "models" | "efforts";
export type MaestroScope = ModelConfigScope;

export interface LayeredValue<T> {
	readonly global?: T;
	readonly project?: T;
	readonly session?: T;
	readonly effective?: T;
	readonly source?: MaestroScope | "default";
}

export function parseSettingValue(raw: string): SessionSettingValue {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "boolean" ||
			typeof parsed === "number" ||
			typeof parsed === "string" ||
			(Array.isArray(parsed) &&
				parsed.every((value) => typeof value === "string"))
		)
			return parsed;
	} catch {
		// Plain strings do not need JSON quoting.
	}
	return raw;
}

export function formatSettingValue(value: unknown): string {
	if (value === undefined) return "—";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.join(" → ");
	return JSON.stringify(value);
}

export function sessionModelId(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

export function activeProfileName(ctx: ExtensionContext): string | undefined {
	return activeProfile(readModelsConfig(ctx.cwd), sessionModelId(ctx))?.name;
}

export function resolveModelName(
	ctx: ExtensionContext,
	modelId: string,
): string {
	const slash = modelId.indexOf("/");
	if (slash < 1) return modelId;
	const model = ctx.modelRegistry.find(
		modelId.slice(0, slash),
		modelId.slice(slash + 1),
	);
	return (model as { name?: string } | undefined)?.name ?? modelId;
}

/** "Claude Sonnet 4.5" → "Sonnet 4.5": compact display names for table cells. */
export function shortModelName(ctx: ExtensionContext, modelId: string): string {
	return resolveModelName(ctx, modelId).replace(/^Claude /, "");
}

/** Resolved live-session fallback label, recomputed at every call site. */
export function sessionFallbackLabel(ctx: ExtensionContext): string {
	const id = sessionModelId(ctx);
	return `session → ${id ? shortModelName(ctx, id) : "none"}`;
}

function rawProfiles(raw: unknown): Record<string, unknown> {
	if (!isPlainObject(raw)) return {};
	const models = raw.models;
	if (!isPlainObject(models) || !isPlainObject(models.profiles)) return {};
	return models.profiles;
}

function roleLeafAt(
	raw: unknown,
	profile: string,
	role: ModelRole,
	leaf: RoleLeaf,
): readonly string[] | undefined {
	const profiles = rawProfiles(raw);
	const profileObject = profiles[profile];
	if (!isPlainObject(profileObject) || !isPlainObject(profileObject.roles))
		return undefined;
	const roleObject = profileObject.roles[role];
	if (!isPlainObject(roleObject)) return undefined;
	const value = roleObject[leaf];
	return Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => typeof item === "string")
		? [...value]
		: undefined;
}

export function readRoleLeaf(
	ctx: ExtensionContext,
	profile: string,
	role: ModelRole,
	leaf: RoleLeaf,
): LayeredValue<readonly string[]> {
	const managerConfig = readModelsConfig(ctx.cwd);
	const effectivePool = effectiveRolePool(
		managerConfig,
		role,
		sessionModelId(ctx),
	);
	// SettingsManager is the authoritative path resolver. Reading it directly is
	// also required to expose each authored scope in the editor.
	const manager = SettingsManager.create(ctx.cwd);
	const global = roleLeafAt(manager.getGlobalSettings(), profile, role, leaf);
	const project = roleLeafAt(manager.getProjectSettings(), profile, role, leaf);
	const session = getSessionRoleOverride(profile, role)?.[leaf];
	const effective =
		effectivePool?.profile === profile
			? effectivePool[leaf]
			: (session ?? project ?? global);
	const source = session
		? "session"
		: project
			? "project"
			: global
				? "global"
				: undefined;
	return { global, project, session, effective, source };
}

function ensureProfile(
	raw: Record<string, unknown>,
	profileName: string,
): Record<string, unknown> {
	if (!isPlainObject(raw.models)) raw.models = {};
	const models = raw.models as Record<string, unknown>;
	if (!isPlainObject(models.profiles)) models.profiles = {};
	const profiles = models.profiles as Record<string, unknown>;
	if (!isPlainObject(profiles[profileName]))
		profiles[profileName] = { targets: [] };
	return profiles[profileName] as Record<string, unknown>;
}

function pruneRole(
	raw: Record<string, unknown>,
	profileName: string,
	role: ModelRole,
): void {
	const profile = ensureProfile(raw, profileName);
	if (!isPlainObject(profile.roles)) return;
	const roles = profile.roles as Record<string, unknown>;
	const roleConfig = roles[role];
	if (isPlainObject(roleConfig) && Object.keys(roleConfig).length === 0)
		delete roles[role];
	if (Object.keys(roles).length === 0) delete profile.roles;
}

export function readProfileTargets(
	ctx: ExtensionContext,
	profile: string,
): LayeredValue<readonly string[]> {
	const manager = SettingsManager.create(ctx.cwd);
	const at = (raw: unknown): readonly string[] | undefined => {
		const value = rawProfiles(raw)[profile];
		if (!isPlainObject(value) || !Array.isArray(value.targets))
			return undefined;
		return value.targets.every((target) => typeof target === "string")
			? [...value.targets]
			: undefined;
	};
	const global = at(manager.getGlobalSettings());
	const project = at(manager.getProjectSettings());
	return {
		global,
		project,
		effective: project ?? global ?? [],
		source: project ? "project" : global ? "global" : undefined,
	};
}

export function writeProfileTargets(
	ctx: ExtensionContext,
	profile: string,
	scope: Exclude<MaestroScope, "session">,
	targets: readonly string[] | undefined,
): void {
	updateSettingsFile(scope, ctx.cwd, undefined, (raw) => {
		const profileObject = ensureProfile(raw, profile);
		if (targets) profileObject.targets = [...targets];
		else delete profileObject.targets;
	});
}

export function createProfile(
	ctx: ExtensionContext,
	name: string,
	scope: Exclude<MaestroScope, "session">,
): void {
	updateSettingsFile(scope, ctx.cwd, undefined, (raw) => {
		ensureProfile(raw, name);
	});
}

export function renameProfile(
	ctx: ExtensionContext,
	oldName: string,
	newName: string,
	scope: Exclude<MaestroScope, "session">,
): void {
	updateSettingsFile(scope, ctx.cwd, undefined, (raw) => {
		if (!isPlainObject(raw.models) || !isPlainObject(raw.models.profiles))
			return;
		const profiles = raw.models.profiles as Record<string, unknown>;
		if (profiles[oldName] !== undefined) {
			profiles[newName] = profiles[oldName];
			delete profiles[oldName];
		}
	});
}

export function deleteProfile(
	ctx: ExtensionContext,
	name: string,
	scope: Exclude<MaestroScope, "session">,
): void {
	updateSettingsFile(scope, ctx.cwd, undefined, (raw) => {
		if (!isPlainObject(raw.models) || !isPlainObject(raw.models.profiles))
			return;
		delete raw.models.profiles[name];
	});
}

export function writeRoleLeaf(
	ctx: ExtensionContext,
	profile: string,
	role: ModelRole,
	leaf: RoleLeaf,
	scope: MaestroScope,
	values: readonly string[] | undefined,
): void {
	if (values?.length === 0)
		throw new Error(
			"Explicit role pools cannot be empty; reset the scope instead.",
		);
	if (scope === "session") {
		const previous = getSessionRoleOverride(profile, role) ?? {};
		const patch = { ...previous, [leaf]: values };
		setSessionRoleOverride(profile, role, patch);
		return;
	}
	updateSettingsFile(scope, ctx.cwd, undefined, (raw) => {
		const profileObject = ensureProfile(raw, profile);
		if (!isPlainObject(profileObject.roles)) profileObject.roles = {};
		const roles = profileObject.roles as Record<string, unknown>;
		if (!isPlainObject(roles[role])) roles[role] = {};
		const roleObject = roles[role] as Record<string, unknown>;
		if (values) roleObject[leaf] = [...values];
		else delete roleObject[leaf];
		pruneRole(raw, profile, role);
	});
}

export function readAdvancedValue(
	cwd: string,
	extension: string,
	path: string,
	defaultValue?: SessionSettingValue,
): LayeredValue<SessionSettingValue> {
	const { global: globalConfig, project: projectConfig } =
		readLayeredExtensionConfig(cwd);
	const global = readPath(globalConfig[extension], path) as
		| SessionSettingValue
		| undefined;
	const project = readPath(projectConfig[extension], path) as
		| SessionSettingValue
		| undefined;
	const session = getSessionSettingOverride(extension, path);
	return {
		global,
		project,
		session,
		effective: session ?? project ?? global ?? defaultValue,
		source:
			session !== undefined
				? "session"
				: project !== undefined
					? "project"
					: global !== undefined
						? "global"
						: "default",
	};
}

export function writeAdvancedValue(
	cwd: string,
	extension: string,
	path: string,
	scope: MaestroScope,
	value: SessionSettingValue | undefined,
): void {
	if (scope === "session") {
		setSessionSettingOverride(extension, path, value);
		return;
	}
	writeExtensionConfigKey(scope, cwd, extension, path, value ?? null);
}

export function modelProfileKeys(ctx: ExtensionContext): string[] {
	return Object.keys(readModelsConfig(ctx.cwd)?.profiles ?? {});
}

export function isModelRole(value: string): value is ModelRole {
	return (MODEL_ROLES as readonly string[]).includes(value);
}

export interface ModelOption {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly supported: readonly ThinkingLevel[];
}

export function supportedEfforts(model: unknown): readonly ThinkingLevel[] {
	const entry = model as {
		reasoning?: boolean;
		thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
		compat?: { forceAdaptiveThinking?: boolean };
	};
	if (entry.reasoning === false) return ["off"];
	let efforts = THINKING_LEVELS.filter(
		(level) => entry.thinkingLevelMap?.[level] !== null,
	);
	if (entry.compat?.forceAdaptiveThinking)
		efforts = efforts.filter((level) => level !== "off" && level !== "minimal");
	return efforts;
}

/**
 * Every exact model id referenced by any profile's targets or role models
 * leaves, in every authored scope. Referenced ids must stay selectable even
 * without auth, or an unauthenticated provider's config would become
 * uneditable from the UI.
 */
function referencedModelIds(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const profile of modelProfileKeys(ctx)) {
		const targets = readProfileTargets(ctx, profile);
		for (const id of [...(targets.global ?? []), ...(targets.project ?? [])])
			ids.add(id);
		for (const role of MODEL_ROLES) {
			const leaf = readRoleLeaf(ctx, profile, role, "models");
			for (const id of [
				...(leaf.global ?? []),
				...(leaf.project ?? []),
				...(leaf.session ?? []),
			])
				ids.add(id);
		}
	}
	return ids;
}

export function modelOptions(ctx: ExtensionContext): ModelOption[] {
	// Candidates are authenticated models plus anything the config already
	// references. Unauthenticated-but-referenced models are dormant targets —
	// the runtime role resolver filters to authenticated models at spawn time
	// — but the rest of the catalog is noise and stays hidden.
	const referenced = referencedModelIds(ctx);
	const options: ModelOption[] = [];
	for (const model of ctx.modelRegistry.getAll()) {
		const id = `${model.provider}/${model.id}`;
		const isReferenced = referenced.delete(id);
		const authenticated = ctx.modelRegistry.hasConfiguredAuth(model);
		if (!authenticated && !isReferenced) continue;
		options.push({
			id,
			label: `${(model as { name?: string }).name ?? model.id} (${model.provider})`,
			description: authenticated ? "available" : "needs authentication",
			supported: supportedEfforts(model),
		});
	}
	// Referenced ids the registry does not know keep their raw id as label.
	// Without registry metadata, effort support cannot be narrowed.
	for (const id of referenced) {
		options.push({
			id,
			label: id,
			description: "needs authentication",
			supported: [...THINKING_LEVELS],
		});
	}
	return options;
}
