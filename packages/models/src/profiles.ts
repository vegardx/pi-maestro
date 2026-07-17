// Layered `/model`-activated presets and reusable exact model sets.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type ExactModelOption,
	MODEL_ROLES,
	type ModelPresetConfig,
	type ModelRole,
	type ModelSetConfig,
	type ModelsConfig,
	type ThinkingLevel,
} from "@vegardx/pi-contracts";

const EFFORT_SET = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const ROLE_SET = new Set<string>(MODEL_ROLES);

interface ParsedPreset {
	readonly targets: readonly string[];
	readonly targetsPresent: boolean;
	readonly modelSets: Partial<Record<ModelRole, string>>;
}

interface ParsedModels {
	readonly modelSets: Readonly<Record<string, ModelSetConfig>>;
	readonly presets: Readonly<Record<string, ParsedPreset>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim() === value && value.length > 0;
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

function validArray<T>(raw: unknown, valid: (value: unknown) => value is T): readonly T[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0 || !raw.every(valid)) return undefined;
	return new Set(raw).size === raw.length ? ([...raw] as T[]) : undefined;
}

function extractOption(raw: unknown): ExactModelOption | undefined {
	if (!isPlainObject(raw)) return undefined;
	if (
		!nonEmpty(raw.id) ||
		!isModelReference(raw.model) ||
		!nonEmpty(raw.summary) ||
		typeof raw.effort !== "string" ||
		!EFFORT_SET.has(raw.effort)
	) return undefined;
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
	if (new Set(concrete.map((option) => option.id)).size !== concrete.length) return undefined;
	return { options: concrete };
}

function extractPreset(raw: unknown): ParsedPreset | undefined {
	if (!isPlainObject(raw)) return undefined;
	const modelSets: Partial<Record<ModelRole, string>> = {};
	const rawSets = isPlainObject(raw.modelSets) ? raw.modelSets : undefined;
	if (rawSets) {
		for (const [role, setId] of Object.entries(rawSets)) {
			if (ROLE_SET.has(role) && nonEmpty(setId)) modelSets[role as ModelRole] = setId;
		}
	}
	return {
		targets: validArray(raw.targets, isModelId) ?? [],
		targetsPresent: Object.hasOwn(raw, "targets"),
		modelSets,
	};
}

function extractModels(raw: unknown): ParsedModels | undefined {
	if (!isPlainObject(raw) || !isPlainObject(raw.models)) return undefined;
	const root = raw.models;
	// Full cutover: old `models.profiles` and role-pool leaves are unsupported.
	if (Object.hasOwn(root, "profiles")) {
		throw new Error("Unsupported model configuration: models.profiles was removed; use models.presets and models.modelSets");
	}
	const modelSets: Record<string, ModelSetConfig> = {};
	if (isPlainObject(root.modelSets)) {
		for (const [name, value] of Object.entries(root.modelSets)) {
			const set = extractModelSet(value);
			if (!set) throw new Error(`Invalid exact model set: ${name}`);
			modelSets[name] = set;
		}
	}
	const presets: Record<string, ParsedPreset> = {};
	if (isPlainObject(root.presets)) {
		for (const [name, value] of Object.entries(root.presets)) {
			const preset = extractPreset(value);
			if (!preset) throw new Error(`Invalid model preset: ${name}`);
			presets[name] = preset;
		}
	}
	return Object.keys(modelSets).length || Object.keys(presets).length ? { modelSets, presets } : undefined;
}

function mergePreset(global: ParsedPreset | undefined, project: ParsedPreset | undefined): ParsedPreset {
	return {
		targets: project?.targetsPresent ? project.targets : (global?.targets ?? []),
		targetsPresent: project?.targetsPresent ?? global?.targetsPresent ?? false,
		modelSets: { ...global?.modelSets, ...project?.modelSets },
	};
}

export function validatePresetTargets(config: ModelsConfig): void {
	const owner = new Map<string, string>();
	for (const [presetId, preset] of Object.entries(config.presets)) {
		for (const target of preset.targets) {
			const previous = owner.get(target);
			if (previous && previous !== presetId) {
				throw new Error(`Model preset target ${target} overlaps between ${previous} and ${presetId}`);
			}
			owner.set(target, presetId);
		}
	}
}

export function readModelsConfig(cwd: string, agentDir?: string): ModelsConfig | undefined {
	const manager = SettingsManager.create(cwd, agentDir);
	const global = extractModels(manager.getGlobalSettings() as unknown);
	const project = extractModels(manager.getProjectSettings() as unknown);
	if (!global && !project) return undefined;
	const modelSets = { ...global?.modelSets, ...project?.modelSets };
	const names = new Set([...Object.keys(global?.presets ?? {}), ...Object.keys(project?.presets ?? {})]);
	const presets = Object.fromEntries(
		[...names].map((name) => {
			const preset = mergePreset(global?.presets[name], project?.presets[name]);
			return [name, { targets: preset.targets, modelSets: preset.modelSets } satisfies ModelPresetConfig];
		}),
	);
	const config: ModelsConfig = { modelSets, presets };
	validatePresetTargets(config);
	return config;
}

export function activePreset(
	config: ModelsConfig | undefined,
	sessionModelId: string | undefined,
): { id: string; preset: ModelPresetConfig } | undefined {
	if (!config || !sessionModelId) return undefined;
	const matches = Object.entries(config.presets).filter(([, preset]) => preset.targets.includes(sessionModelId));
	if (matches.length > 1) throw new Error(`Model preset target ${sessionModelId} has multiple owners`);
	const match = matches[0];
	return match ? { id: match[0], preset: match[1] } : undefined;
}
