// models.presets — layered reading of the preset-based model configuration.
//
// Reads the top-level `models` key from settings.json. Merges global and
// project layers with project winning:
//   - `active`: project overrides global
//   - `presets`: deep merge — project can add presets or override slots

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
	ModelsConfig,
	PresetConfig,
	SlotConfig,
	ThinkingLevel,
} from "@vegardx/pi-contracts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractSlotConfig(raw: unknown): SlotConfig | undefined {
	if (isPlainObject(raw) && typeof raw.model === "string") {
		return {
			model: raw.model,
			effort:
				typeof raw.effort === "string"
					? (raw.effort as ThinkingLevel)
					: undefined,
		};
	}
	// Simple string format (just model, no effort)
	if (typeof raw === "string") {
		return { model: raw };
	}
	return undefined;
}

function extractPresetConfig(raw: unknown): PresetConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const def = extractSlotConfig(raw.default);
	const alt = extractSlotConfig(raw.alternate);
	// Allow newly created presets with empty slots
	if (def === undefined && alt === undefined) return undefined;
	return {
		default: def ?? { model: "" },
		alternate: alt,
	};
}

function extractModelsConfig(raw: unknown): ModelsConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const models = raw.models;
	if (!isPlainObject(models)) return undefined;

	const active = typeof models.active === "string" ? models.active : undefined;
	const rawPresets = models.presets;
	if (!isPlainObject(rawPresets)) return undefined;

	const presets: Record<string, PresetConfig> = {};
	let hasPresets = false;
	for (const [name, value] of Object.entries(rawPresets)) {
		const preset = extractPresetConfig(value);
		if (preset) {
			presets[name] = preset;
			hasPresets = true;
		}
	}

	if (!hasPresets) return undefined;
	const resolvedActive = active ?? Object.keys(presets)[0];
	return { active: resolvedActive, presets };
}

/**
 * Read and merge the `models` config from global and project settings.
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

	// Merge: project wins for `active`; presets deep-merged per slot
	const mergedPresets: Record<string, PresetConfig> = {};
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
		// Per-slot: project wins
		mergedPresets[name] = {
			default: p.default ?? g.default,
			alternate: p.alternate ?? g.alternate,
		};
	}

	return {
		active: projectConfig.active ?? globalConfig.active,
		presets: mergedPresets,
	};
}
