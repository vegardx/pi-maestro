// backgroundModels.<set>.<tier> — layered reading and atomic writing.
//
// Reuses pi's SettingsManager for the layered read (project over global) and
// @vegardx/pi-settings' updateSettingsFile for the single crash-safe write
// path. Tier lookup applies the secondary→primary fallback so a user who
// only configures `primary` still gets sensible behaviour from `secondary`
// consumers.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { type SettingsScope, updateSettingsFile } from "@vegardx/pi-settings";
import type { BackgroundModels, BackgroundSet, Tier } from "./types.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractTiers(raw: unknown): Record<string, string> {
	if (!isPlainObject(raw)) return {};
	const out: Record<string, string> = {};
	for (const [tier, value] of Object.entries(raw)) {
		if (typeof value === "string") out[tier] = value;
	}
	return out;
}

function extractBackgroundModels(raw: unknown): BackgroundModels {
	if (!isPlainObject(raw)) return {};
	const bg = raw.backgroundModels;
	if (!isPlainObject(bg)) return {};
	const out: BackgroundModels = {};
	const primary = extractTiers(bg.primary);
	const secondary = extractTiers(bg.secondary);
	if (Object.keys(primary).length) out.primary = primary;
	if (Object.keys(secondary).length) out.secondary = secondary;
	return out;
}

/** Merged (project over global) view of backgroundModels. */
export function readBackgroundModels(
	cwd: string,
	agentDir?: string,
): BackgroundModels {
	const manager = SettingsManager.create(cwd, agentDir);
	const global = extractBackgroundModels(manager.getGlobalSettings());
	const project = extractBackgroundModels(manager.getProjectSettings());
	return {
		primary: { ...global.primary, ...project.primary },
		secondary: { ...global.secondary, ...project.secondary },
	};
}

/**
 * Resolve the "provider/id" spec for a tier under a set, applying the
 * secondary→primary fallback. Returns undefined when nothing is configured.
 */
export function getTierModel(
	models: BackgroundModels,
	tier: Tier,
	set: BackgroundSet = "primary",
): string | undefined {
	const direct = models[set]?.[tier];
	if (direct) return direct;
	if (set === "secondary") return models.primary?.[tier];
	return undefined;
}

/**
 * Set (or, when null, delete) backgroundModels.<set>.<tier> atomically.
 * Prunes emptied set objects and the backgroundModels container.
 */
export function writeBackgroundModel(
	scope: SettingsScope,
	cwd: string,
	set: BackgroundSet,
	tier: Tier,
	value: string | null,
	agentDir?: string,
): { path: string } {
	return updateSettingsFile(scope, cwd, agentDir, (raw) => {
		const bg = isPlainObject(raw.backgroundModels) ? raw.backgroundModels : {};
		const setObj = isPlainObject(bg[set])
			? (bg[set] as Record<string, unknown>)
			: {};
		if (value === null) {
			delete setObj[tier];
			if (Object.keys(setObj).length === 0) delete bg[set];
			else bg[set] = setObj;
		} else {
			setObj[tier] = value;
			bg[set] = setObj;
		}
		if (Object.keys(bg).length === 0) delete raw.backgroundModels;
		else raw.backgroundModels = bg;
	});
}
