// models.presets — layered reading of the preset-based model configuration.
//
// Reads the top-level `models` key from settings.json (alongside
// `extensionConfig`). Merges global and project layers with project winning:
//   - `active`: project overrides global (simple replace)
//   - `presets`: deep merge — project can add presets or override tiers
//   - Per-tier arrays: project replaces the entire array (not concat)
//
// Also handles backward compatibility with the old `backgroundModels` format.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelsConfig, PresetTierMap, Tier } from "@vegardx/pi-contracts";
import { TIERS } from "@vegardx/pi-contracts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

const TIER_SET: ReadonlySet<string> = new Set(TIERS);

function extractPresetTierMap(raw: unknown): PresetTierMap | undefined {
	if (!isPlainObject(raw)) return undefined;
	const out: Partial<Record<Tier, readonly string[]>> = {};
	let found = false;
	for (const [key, value] of Object.entries(raw)) {
		if (!TIER_SET.has(key)) continue;
		if (isStringArray(value) && value.length > 0) {
			out[key as Tier] = value;
			found = true;
		}
	}
	return found ? out : undefined;
}

function extractModelsConfig(raw: unknown): ModelsConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const models = raw.models;
	if (!isPlainObject(models)) return undefined;

	const active = typeof models.active === "string" ? models.active : undefined;
	const rawPresets = models.presets;
	if (!isPlainObject(rawPresets)) return undefined;

	const presets: Record<string, PresetTierMap> = {};
	let hasPresets = false;
	for (const [name, value] of Object.entries(rawPresets)) {
		const tierMap = extractPresetTierMap(value);
		if (tierMap) {
			presets[name] = tierMap;
			hasPresets = true;
		}
	}

	if (!hasPresets) return undefined;
	// Default active to first preset name if not specified
	const resolvedActive = active ?? Object.keys(presets)[0];
	return { active: resolvedActive, presets };
}

/**
 * Migrate old `backgroundModels.primary/secondary` → new presets format.
 * Returns undefined if no old format found.
 */
function migrateOldFormat(raw: unknown): ModelsConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const bg = raw.backgroundModels;
	if (!isPlainObject(bg)) return undefined;
	// Only migrate if there's no `models` key (new format takes priority)
	if (isPlainObject(raw.models)) return undefined;

	const presets: Record<string, PresetTierMap> = {};

	const primary = bg.primary;
	if (isPlainObject(primary)) {
		const tierMap: Partial<Record<Tier, readonly string[]>> = {};
		for (const [tier, value] of Object.entries(primary)) {
			if (TIER_SET.has(tier) && typeof value === "string") {
				tierMap[tier as Tier] = [value];
			}
		}
		if (Object.keys(tierMap).length > 0) {
			presets.default = tierMap;
		}
	}

	const secondary = bg.secondary;
	if (isPlainObject(secondary)) {
		const tierMap: Partial<Record<Tier, readonly string[]>> = {};
		for (const [tier, value] of Object.entries(secondary)) {
			if (TIER_SET.has(tier) && typeof value === "string") {
				tierMap[tier as Tier] = [value];
			}
		}
		if (Object.keys(tierMap).length > 0) {
			presets.secondary = tierMap;
		}
	}

	if (Object.keys(presets).length === 0) return undefined;
	return { active: "default", presets };
}

/**
 * Read and merge the `models` config from global and project settings.
 * Falls back to migrating old `backgroundModels` format if new format absent.
 */
export function readModelsConfig(
	cwd: string,
	agentDir?: string,
): ModelsConfig | undefined {
	const manager = SettingsManager.create(cwd, agentDir);
	const globalRaw = manager.getGlobalSettings() as unknown;
	const projectRaw = manager.getProjectSettings() as unknown;

	const globalConfig =
		extractModelsConfig(globalRaw) ?? migrateOldFormat(globalRaw);
	const projectConfig =
		extractModelsConfig(projectRaw) ?? migrateOldFormat(projectRaw);

	if (!globalConfig && !projectConfig) return undefined;
	if (!globalConfig) return projectConfig;
	if (!projectConfig) return globalConfig;

	// Merge: project wins for `active`; presets deep-merged per tier
	const mergedPresets: Record<string, PresetTierMap> = {};
	const allNames = new Set([
		...Object.keys(globalConfig.presets),
		...Object.keys(projectConfig.presets),
	]);

	for (const name of allNames) {
		const g = globalConfig.presets[name];
		const p = projectConfig.presets[name];
		if (!g) {
			if (p) mergedPresets[name] = p;
			continue;
		}
		if (!p) {
			mergedPresets[name] = g;
			continue;
		}
		// Per-tier: project replaces entire array
		const merged: Partial<Record<Tier, readonly string[]>> = {};
		for (const tier of TIERS) {
			const arr = p[tier] ?? g[tier];
			if (arr) merged[tier] = arr;
		}
		mergedPresets[name] = merged;
	}

	return {
		active: projectConfig.active ?? globalConfig.active,
		presets: mergedPresets,
	};
}
