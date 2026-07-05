// models.presets — layered reading of the preset-based model configuration.
//
// Reads the top-level `models` key from settings.json (alongside
// `extensionConfig`). Merges global and project layers with project winning:
//   - `active`: project overrides global (simple replace)
//   - `presets`: deep merge — project can add presets or override tiers
//   - Per-tier arrays: project replaces the entire array (not concat)
//
//

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
	ModelsConfig,
	PresetTierEntry,
	PresetTierMap,
	Tier,
} from "@vegardx/pi-contracts";
import { TIERS } from "@vegardx/pi-contracts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

const TIER_SET: ReadonlySet<string> = new Set(TIERS);

function extractPresetTierMap(raw: unknown): PresetTierMap | undefined {
	if (!isPlainObject(raw)) return undefined;
	const out: Partial<Record<Tier, PresetTierEntry>> = {};
	let found = false;
	for (const [key, value] of Object.entries(raw)) {
		if (!TIER_SET.has(key)) continue;
		if (isPlainObject(value) && typeof value.model === "string") {
			out[key as Tier] = {
				model: value.model,
				effort:
					typeof value.effort === "string"
						? (value.effort as PresetTierEntry["effort"])
						: undefined,
			};
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
		if (!isPlainObject(value)) continue;
		const tierMap = extractPresetTierMap(value);
		presets[name] = tierMap ?? {};
		hasPresets = true;
	}

	if (!hasPresets) return undefined;
	// Default active to first preset name if not specified
	const resolvedActive = active ?? Object.keys(presets)[0];
	return { active: resolvedActive, presets };
}

/**
 * Read and merge the `models` config from global and project settings.
 *
 */
export function readModelsConfig(
	cwd: string,
	agentDir?: string,
): ModelsConfig | undefined {
	const manager = SettingsManager.create(cwd, agentDir);
	const globalRaw = manager.getGlobalSettings() as unknown;
	const projectRaw = manager.getProjectSettings() as unknown;

	const globalConfig = extractModelsConfig(globalRaw);
	const projectConfig = extractModelsConfig(projectRaw);

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
		// Per-tier: project wins
		const merged: Partial<Record<Tier, PresetTierEntry>> = {};
		for (const tier of TIERS) {
			const val = p[tier] ?? g[tier];
			if (val) merged[tier] = val;
		}
		mergedPresets[name] = merged;
	}

	return {
		active: projectConfig.active ?? globalConfig.active,
		presets: mergedPresets,
	};
}
