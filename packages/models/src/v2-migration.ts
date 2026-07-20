// The v1→v2 models migration: presets/modelSets → profiles/catalogs. ADDITIVE
// — v1 keys stay (verifier/summarizer fallback paths still read roles); the
// migration only writes the v2 shape where none exists, so a hand-authored
// v2 config is never touched. Role→tier mapping (design §v1→v2 mapping):
//
//   fast   ← classifier, plan-summarizer, compact-summarizer sets
//   normal ← worker, general, codebase-research, web-research sets
//   heavy  ← verifier + every *-review set
//
// Session-sentinel options are DROPPED (v2 reaches the session model via
// inheritance, never through the catalog); "auto" efforts are dropped too
// (effort is resolver/persona business in v2). A preset whose sets yield an
// all-empty catalog is skipped with a note rather than written invalid.

import type { SettingsMigration } from "@vegardx/pi-settings";
import { SESSION_MODEL_SENTINEL } from "./profiles.js";

const TIER_ROLES: Readonly<
	Record<"fast" | "normal" | "heavy", readonly string[]>
> = {
	fast: ["classifier", "plan-summarizer", "compact-summarizer"],
	normal: ["worker", "general", "codebase-research", "web-research"],
	heavy: [
		"verifier",
		"plan-review",
		"practical-review",
		"adversarial-review",
		"correctness-review",
		"security-review",
		"test-review",
		"simplification-review",
	],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface MigratedEntry {
	model: string;
	effort?: string;
}

function entriesFromSet(rawSet: unknown): MigratedEntry[] {
	if (!isPlainObject(rawSet) || !Array.isArray(rawSet.options)) return [];
	const entries: MigratedEntry[] = [];
	for (const option of rawSet.options) {
		if (!isPlainObject(option)) continue;
		const model = option.model;
		if (typeof model !== "string" || model === SESSION_MODEL_SENTINEL) continue;
		const effort =
			typeof option.effort === "string" && option.effort !== "auto"
				? option.effort
				: undefined;
		entries.push({ model, ...(effort ? { effort } : {}) });
	}
	return entries;
}

/**
 * Build the v2 slice for one file's models object. Returns null when there
 * is nothing to migrate (no presets, or v2 already present).
 */
export function buildV2FromV1(models: Record<string, unknown>): {
	catalogs: Record<string, Record<string, MigratedEntry[]>>;
	profiles: Record<string, { targets?: string[]; catalog: string }>;
	skipped: string[];
} | null {
	if (isPlainObject(models.catalogs) || isPlainObject(models.profiles))
		return null; // hand-authored v2 present — never touch it
	const presets = isPlainObject(models.presets) ? models.presets : undefined;
	const sets = isPlainObject(models.modelSets) ? models.modelSets : undefined;
	if (!presets || !sets) return null;

	const catalogs: Record<string, Record<string, MigratedEntry[]>> = {};
	const profiles: Record<string, { targets?: string[]; catalog: string }> = {};
	const skipped: string[] = [];
	for (const [name, rawPreset] of Object.entries(presets)) {
		if (!isPlainObject(rawPreset)) continue;
		const roleSets = isPlainObject(rawPreset.modelSets)
			? rawPreset.modelSets
			: {};
		const tiers: Record<string, MigratedEntry[]> = {};
		for (const [tier, roles] of Object.entries(TIER_ROLES)) {
			const seen = new Set<string>();
			const entries: MigratedEntry[] = [];
			for (const role of roles) {
				const setId = roleSets[role];
				if (typeof setId !== "string") continue;
				for (const entry of entriesFromSet(sets[setId])) {
					if (seen.has(entry.model)) continue;
					seen.add(entry.model);
					entries.push(entry);
				}
			}
			if (entries.length > 0) tiers[tier] = entries;
		}
		if (Object.keys(tiers).length === 0) {
			skipped.push(name);
			continue;
		}
		catalogs[name] = tiers;
		const targets = Array.isArray(rawPreset.targets)
			? rawPreset.targets.filter(
					(item): item is string => typeof item === "string",
				)
			: [];
		profiles[name] = {
			...(targets.length > 0 ? { targets } : {}),
			catalog: name,
		};
	}
	if (Object.keys(catalogs).length === 0) return null;
	return { catalogs, profiles, skipped };
}

/** The registered migration (runSettingsMigrations applies it per file). */
export const MODELS_V2_MIGRATION: SettingsMigration = {
	id: "2026-07-20-models-v2-profiles",
	description:
		"Derive v2 catalogs/profiles from v1 presets/modelSets (additive; v1 kept for fallback paths)",
	apply: (raw) => {
		const models = isPlainObject(raw.models) ? raw.models : undefined;
		if (!models) return false;
		const built = buildV2FromV1(models);
		if (!built) return false;
		models.catalogs = built.catalogs;
		models.profiles = built.profiles;
		return true;
	},
};
