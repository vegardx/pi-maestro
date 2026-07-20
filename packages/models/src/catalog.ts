// v2 config reader: catalogs (fast/normal/heavy tiers), profiles
// (seat→catalog bindings), and per-agent-type tier allowlists. Mirrors
// profiles.ts conventions: null entries are deletion markers (skipped),
// invalid non-null shapes throw with the offending name, global+project
// merge with project winning per key. Read-only slice for now — the v2
// resolver flips over in a later phase.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type AgentTierConfig,
	type CatalogEntry,
	type CatalogTiers,
	DEFAULT_AGENT_TIERS,
	SPAWNABLE_AGENT_TYPES,
	type SpawnableAgentType,
	type ThinkingLevel,
	TIER_IDS,
	type TierId,
	type V2ModelsConfig,
	type V2ProfileConfig,
} from "@vegardx/pi-contracts";
import { isModelId } from "./profiles.js";

const EFFORT_SET = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const TIER_SET = new Set<string>(TIER_IDS);
const AGENT_SET = new Set<string>(SPAWNABLE_AGENT_TYPES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
	return (
		typeof value === "string" && value.trim() === value && value.length > 0
	);
}

function extractEntry(raw: unknown, where: string): CatalogEntry {
	if (!isPlainObject(raw) || !isModelId(raw.model))
		throw new Error(
			`Invalid catalog entry at ${where}: model must be a concrete provider/model ref (the session model is reached via inheritance, never through the catalog)`,
		);
	if (raw.family !== undefined && !nonEmpty(raw.family))
		throw new Error(
			`Invalid catalog entry at ${where}: family must be a non-empty string`,
		);
	if (raw.notes !== undefined && !nonEmpty(raw.notes))
		throw new Error(
			`Invalid catalog entry at ${where}: notes must be a non-empty string`,
		);
	let effort: ThinkingLevel | undefined;
	if (raw.effort !== undefined) {
		if (typeof raw.effort !== "string" || !EFFORT_SET.has(raw.effort))
			throw new Error(
				`Invalid catalog entry at ${where}: effort ${JSON.stringify(raw.effort)} is unsupported`,
			);
		effort = raw.effort as ThinkingLevel;
	}
	let efforts: readonly ThinkingLevel[] | undefined;
	if (raw.efforts !== undefined) {
		if (
			!Array.isArray(raw.efforts) ||
			raw.efforts.length === 0 ||
			!raw.efforts.every(
				(level) => typeof level === "string" && EFFORT_SET.has(level),
			) ||
			new Set(raw.efforts).size !== raw.efforts.length
		)
			throw new Error(
				`Invalid catalog entry at ${where}: efforts must be a unique array of thinking levels`,
			);
		if (effort && !raw.efforts.includes(effort))
			throw new Error(
				`Invalid catalog entry at ${where}: effort must be a member of its own efforts allowlist`,
			);
		efforts = [...raw.efforts] as ThinkingLevel[];
	}
	return {
		model: raw.model,
		...(nonEmpty(raw.family) ? { family: raw.family } : {}),
		...(nonEmpty(raw.notes) ? { notes: raw.notes } : {}),
		...(effort ? { effort } : {}),
		...(efforts ? { efforts } : {}),
	};
}

function extractCatalog(raw: unknown, name: string): CatalogTiers {
	if (!isPlainObject(raw)) throw new Error(`Invalid catalog: ${name}`);
	for (const key of Object.keys(raw)) {
		if (!TIER_SET.has(key))
			throw new Error(
				`Invalid catalog ${name}: unknown tier ${key} (tiers are exactly ${TIER_IDS.join(", ")})`,
			);
	}
	const tiers = {} as Record<TierId, readonly CatalogEntry[]>;
	for (const tier of TIER_IDS) {
		const value = raw[tier];
		if (value === undefined || value === null) {
			tiers[tier] = [];
			continue;
		}
		if (!Array.isArray(value))
			throw new Error(`Invalid catalog ${name}: ${tier} must be an array`);
		tiers[tier] = value.map((entry, index) =>
			extractEntry(entry, `${name}.${tier}[${index}]`),
		);
		const refs = tiers[tier].map((entry) => entry.model);
		if (new Set(refs).size !== refs.length)
			throw new Error(`Invalid catalog ${name}: duplicate model in ${tier}`);
	}
	if (TIER_IDS.every((tier) => tiers[tier].length === 0))
		throw new Error(`Invalid catalog ${name}: every tier is empty`);
	return tiers;
}

/** True when a `models.profiles` entry has the v2 shape (a catalog binding). */
export function isV2ProfileShape(value: unknown): boolean {
	return isPlainObject(value) && nonEmpty(value.catalog);
}

function extractProfile(raw: unknown, name: string): V2ProfileConfig {
	if (!isPlainObject(raw) || !nonEmpty(raw.catalog))
		throw new Error(`Invalid profile ${name}: catalog reference is required`);
	let targets: readonly string[] | undefined;
	if (raw.targets !== undefined) {
		if (
			!Array.isArray(raw.targets) ||
			!raw.targets.every(isModelId) ||
			new Set(raw.targets).size !== raw.targets.length
		)
			throw new Error(
				`Invalid profile ${name}: targets must be unique concrete provider/model ids`,
			);
		targets = [...raw.targets] as string[];
	}
	return { catalog: raw.catalog, ...(targets ? { targets } : {}) };
}

function extractAgentTiers(
	raw: unknown,
	name: string,
): AgentTierConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	if (raw.models === undefined) return undefined;
	if (
		!Array.isArray(raw.models) ||
		raw.models.length === 0 ||
		!raw.models.every(
			(tier) => typeof tier === "string" && TIER_SET.has(tier),
		) ||
		new Set(raw.models).size !== raw.models.length
	)
		throw new Error(
			`Invalid agents.${name}.models: must be a unique non-empty array of ${TIER_IDS.join("|")}`,
		);
	return { models: [...raw.models] as TierId[] };
}

interface ParsedV2 {
	readonly catalogs: Record<string, CatalogTiers>;
	readonly profiles: Record<string, V2ProfileConfig>;
	readonly agents: Partial<Record<SpawnableAgentType, AgentTierConfig>>;
}

function extractV2(raw: unknown): ParsedV2 | undefined {
	if (!isPlainObject(raw)) return undefined;
	const models = isPlainObject(raw.models) ? raw.models : undefined;
	const catalogs: Record<string, CatalogTiers> = {};
	// Canonical key is `models.catalogs` (what the v1→v2 migration writes and
	// the editor edits); `models.catalog` is the legacy spelling from the
	// first config-slice PR — still read, with `catalogs` winning per name.
	for (const key of ["catalog", "catalogs"] as const) {
		const container = models?.[key];
		if (!isPlainObject(container)) continue;
		for (const [name, value] of Object.entries(container)) {
			if (value === null || value === undefined) continue;
			catalogs[name] = extractCatalog(value, name);
		}
	}
	const profiles: Record<string, V2ProfileConfig> = {};
	if (models && isPlainObject(models.profiles)) {
		for (const [name, value] of Object.entries(models.profiles)) {
			if (value === null || value === undefined) continue;
			// Legacy (pre-cutover) profile shapes are profiles.ts's problem —
			// it throws its guidance error. Here we only parse v2 shapes.
			if (!isV2ProfileShape(value)) continue;
			profiles[name] = extractProfile(value, name);
		}
	}
	const agents: Partial<Record<SpawnableAgentType, AgentTierConfig>> = {};
	// Canonical key is `models.agents.<type>.models`; the root-level
	// `agents.<type>.models` spelling is legacy — still read, models.agents
	// winning per type.
	const agentContainers = [raw.agents, models?.agents];
	for (const container of agentContainers) {
		if (!isPlainObject(container)) continue;
		for (const [name, value] of Object.entries(container)) {
			if (!AGENT_SET.has(name)) continue; // kinds/runtimePolicies live here too
			if (value === null || value === undefined) continue;
			const tiers = extractAgentTiers(value, name);
			if (tiers) agents[name as SpawnableAgentType] = tiers;
		}
	}
	return Object.keys(catalogs).length ||
		Object.keys(profiles).length ||
		Object.keys(agents).length
		? { catalogs, profiles, agents }
		: undefined;
}

/** Cross-object rules that only make sense on the merged config. */
export function validateV2Config(config: V2ModelsConfig): void {
	const owner = new Map<string, string>();
	let defaultProfile: string | undefined;
	for (const [name, profile] of Object.entries(config.profiles)) {
		if (!config.catalogs[profile.catalog])
			throw new Error(
				`Profile ${name} references unknown catalog ${profile.catalog}`,
			);
		if (!profile.targets || profile.targets.length === 0) {
			if (defaultProfile)
				throw new Error(
					`Profiles ${defaultProfile} and ${name} both have no targets — only one default profile is allowed`,
				);
			defaultProfile = name;
			continue;
		}
		for (const target of profile.targets) {
			const previous = owner.get(target);
			if (previous && previous !== name)
				throw new Error(
					`Profile target ${target} overlaps between ${previous} and ${name}`,
				);
			owner.set(target, name);
		}
	}
}

/**
 * Parse + merge + validate the v2 slice from two raw settings objects
 * (global, project — project winning per key). Exported so the /maestro
 * editor can validate a CANDIDATE global settings object before any byte is
 * written: an invalid v2 state is unwriteable, never write-then-warn.
 * Throws with the offending name; returns undefined when nothing v2 exists.
 */
export function parseV2Settings(
	globalRaw: unknown,
	projectRaw: unknown,
): V2ModelsConfig | undefined {
	const global = extractV2(globalRaw);
	const project = extractV2(projectRaw);
	if (!global && !project) return undefined;
	const config: V2ModelsConfig = {
		catalogs: { ...global?.catalogs, ...project?.catalogs },
		profiles: { ...global?.profiles, ...project?.profiles },
		agents: {
			...DEFAULT_AGENT_TIERS,
			...global?.agents,
			...project?.agents,
		},
	};
	validateV2Config(config);
	return config;
}

/**
 * Read the merged v2 slice. Returns undefined when nothing v2 is configured
 * — v1 keeps driving resolution either way until the v2 resolver lands.
 */
export function readV2Config(
	cwd: string,
	agentDir?: string,
): V2ModelsConfig | undefined {
	const manager = SettingsManager.create(cwd, agentDir);
	return parseV2Settings(
		manager.getGlobalSettings() as unknown,
		manager.getProjectSettings() as unknown,
	);
}

/**
 * The active profile for a session model: the profile whose targets contain
 * it, else the default (targetless) profile, else undefined.
 */
export function activeV2Profile(
	config: V2ModelsConfig | undefined,
	sessionModelId: string | undefined,
): { id: string; profile: V2ProfileConfig } | undefined {
	if (!config) return undefined;
	if (sessionModelId) {
		for (const [id, profile] of Object.entries(config.profiles)) {
			if (profile.targets?.includes(sessionModelId)) return { id, profile };
		}
	}
	for (const [id, profile] of Object.entries(config.profiles)) {
		if (!profile.targets || profile.targets.length === 0)
			return { id, profile };
	}
	return undefined;
}
