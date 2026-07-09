// models.profiles — layered reading of the tier-based model configuration.
//
// Reads the top-level `models` key from settings.json. A profile owns a set of
// `/model` targets and pins the work/review/fast tiers; `plan` is always the live
// session model. Activation is DERIVED (target match), never stored.
//
// Merges global and project layers with project winning per profile.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
	ModelsConfig,
	ProfileConfig,
	ThinkingLevel,
	Tier,
	TierConfig,
} from "@vegardx/pi-contracts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A tier is either `{ model?, effort? }` or a bare model string. */
function extractTierConfig(raw: unknown): TierConfig | undefined {
	if (typeof raw === "string") {
		return raw.length > 0 ? { model: raw } : {};
	}
	if (isPlainObject(raw)) {
		const model =
			typeof raw.model === "string" && raw.model.length > 0
				? raw.model
				: undefined;
		const effort =
			typeof raw.effort === "string"
				? (raw.effort as ThinkingLevel)
				: undefined;
		return { model, effort };
	}
	return undefined;
}

function extractProfileConfig(raw: unknown): ProfileConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const targets = Array.isArray(raw.targets)
		? raw.targets.filter(
				(t): t is string => typeof t === "string" && t.length > 0,
			)
		: [];
	// A profile with no targets can never activate, but keep it so the menu can
	// show/edit it while the user is still assigning target models.
	return {
		targets,
		work: extractTierConfig(raw.work),
		review: extractTierConfig(raw.review),
		fast: extractTierConfig(raw.fast),
	};
}

function extractModelsConfig(raw: unknown): ModelsConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const models = raw.models;
	if (!isPlainObject(models)) return undefined;
	const rawProfiles = models.profiles;
	if (!isPlainObject(rawProfiles)) return undefined;

	const profiles: Record<string, ProfileConfig> = {};
	let hasProfiles = false;
	for (const [name, value] of Object.entries(rawProfiles)) {
		const profile = extractProfileConfig(value);
		if (profile) {
			profiles[name] = profile;
			hasProfiles = true;
		}
	}

	if (!hasProfiles) return undefined;
	return { profiles };
}

/**
 * Read and merge the `models` config from global and project settings. Project
 * wins per profile (targets, and each tier independently).
 */
export function readModelsConfig(
	cwd: string,
	agentDir?: string,
): ModelsConfig | undefined {
	const manager = SettingsManager.create(cwd, agentDir);
	const globalConfig = extractModelsConfig(
		manager.getGlobalSettings() as unknown,
	);
	const projectConfig = extractModelsConfig(
		manager.getProjectSettings() as unknown,
	);

	if (!globalConfig && !projectConfig) return undefined;
	if (!globalConfig) return projectConfig;
	if (!projectConfig) return globalConfig;

	const mergedProfiles: Record<string, ProfileConfig> = {};
	const allNames = new Set([
		...Object.keys(globalConfig.profiles),
		...Object.keys(projectConfig.profiles),
	]);

	for (const name of allNames) {
		const g = globalConfig.profiles[name];
		const p = projectConfig.profiles[name];
		if (!g) {
			if (p) mergedProfiles[name] = p;
			continue;
		}
		if (!p) {
			mergedProfiles[name] = g;
			continue;
		}
		mergedProfiles[name] = {
			targets: p.targets.length > 0 ? p.targets : g.targets,
			work: p.work ?? g.work,
			review: p.review ?? g.review,
			fast: p.fast ?? g.fast,
		};
	}

	return { profiles: mergedProfiles };
}

/**
 * The active profile is the one whose `targets` include the session model. Returns
 * undefined when no profile claims the current model (⇒ every tier tracks plan).
 */
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

/** Pure resolution of a tier to a model id + effort — no auth. */
export interface TierResolution {
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
	readonly tier: Tier;
	/** True when this tier follows the live session model (`plan`, or an unset tier). */
	readonly tracksPlan: boolean;
	/** The active profile's name, when one claimed the session model. */
	readonly profile?: string;
}

/**
 * Resolve a tier to a concrete model id + effort, purely from config. `plan`
 * always resolves to the session model. `work`/`review`/`fast` resolve to their
 * pinned model, or track plan when unset/model-less. Returns undefined only when
 * a tier would track plan but there is no session model to fall back to.
 */
export function resolveTierConfig(
	cfg: ModelsConfig | undefined,
	tier: Tier,
	session: { modelId: string; effort?: ThinkingLevel } | undefined,
): TierResolution | undefined {
	if (tier === "plan") {
		if (!session) return undefined;
		return {
			modelId: session.modelId,
			effort: session.effort,
			tier,
			tracksPlan: true,
		};
	}

	const active = session ? activeProfile(cfg, session.modelId) : undefined;
	const tierConfig = active?.profile[tier];
	if (tierConfig?.model) {
		return {
			modelId: tierConfig.model,
			effort: tierConfig.effort,
			tier,
			tracksPlan: false,
			profile: active?.name,
		};
	}

	// Unset or model-less ⇒ track plan (but carry a tier-level effort override).
	if (!session) return undefined;
	return {
		modelId: session.modelId,
		effort: tierConfig?.effort ?? session.effort,
		tier,
		tracksPlan: true,
		profile: active?.name,
	};
}
