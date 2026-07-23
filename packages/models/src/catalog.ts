// v2 config reader: families (ranked; each holds free-text aliases with ordered
// per-provider attachments), rosters (light/standard/heavy tiers holding ordered
// alias refs), bindings (seat→roster bindings), region (the active model
// allowlist), and per-agent-type tier allowances. Mirrors the old conventions:
// null entries are deletion markers (skipped), invalid non-null shapes throw
// with the offending name, global+project merge with project winning per key.
//
// parseV2Settings is the single validator both boot and the /maestro editor
// use: an invalid v2 state is unwriteable (editor) and triggers the boot wipe.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type AgentAllowanceConfig,
	type AliasConfig,
	DEFAULT_AGENT_ALLOWANCES,
	type FamilyConfig,
	type RegionConfig,
	type RosterTiers,
	SPAWNABLE_AGENT_TYPES,
	type SpawnableAgentType,
	type ThinkingLevel,
	TIER_IDS,
	type TierId,
	type V2BindingConfig,
	type V2ModelsConfig,
} from "@vegardx/pi-contracts";
import { isModelId } from "./profiles.js";
import { isRegionOff } from "./region.js";

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

/**
 * Split a roster ref `"Family/Alias"` on its first `/`. Family and alias names
 * both forbid `/`, so the first slash is unambiguous. Returns undefined for a
 * malformed ref (no interior slash).
 */
export function parseAliasRef(
	ref: string,
): { family: string; alias: string } | undefined {
	if (typeof ref !== "string") return undefined;
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { family: ref.slice(0, slash), alias: ref.slice(slash + 1) };
}

function extractAlias(raw: unknown, where: string): AliasConfig {
	if (!isPlainObject(raw))
		throw new Error(`Invalid alias at ${where}: must be an object`);
	if (
		!Array.isArray(raw.attach) ||
		raw.attach.length === 0 ||
		!raw.attach.every(isModelId) ||
		new Set(raw.attach).size !== raw.attach.length
	)
		throw new Error(
			`Invalid alias at ${where}: attach must be a unique non-empty array of provider/model refs`,
		);
	if (raw.notes !== undefined && !nonEmpty(raw.notes))
		throw new Error(
			`Invalid alias at ${where}: notes must be a non-empty string`,
		);
	let effort: ThinkingLevel | undefined;
	if (raw.effort !== undefined) {
		if (typeof raw.effort !== "string" || !EFFORT_SET.has(raw.effort))
			throw new Error(
				`Invalid alias at ${where}: effort ${JSON.stringify(raw.effort)} is unsupported`,
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
				`Invalid alias at ${where}: efforts must be a unique array of thinking levels`,
			);
		if (effort && !raw.efforts.includes(effort))
			throw new Error(
				`Invalid alias at ${where}: effort must be a member of its own efforts allowlist`,
			);
		efforts = [...raw.efforts] as ThinkingLevel[];
	}
	return {
		attach: [...raw.attach] as string[],
		...(effort ? { effort } : {}),
		...(efforts ? { efforts } : {}),
		...(nonEmpty(raw.notes) ? { notes: raw.notes } : {}),
	};
}

function extractFamily(raw: unknown, name: string): FamilyConfig {
	if (!isPlainObject(raw) || !isPlainObject(raw.aliases))
		throw new Error(`Invalid family ${name}: an aliases object is required`);
	const aliases: Record<string, AliasConfig> = {};
	for (const [aliasName, value] of Object.entries(raw.aliases)) {
		if (value === null || value === undefined) continue;
		if (!nonEmpty(aliasName) || aliasName.includes("/"))
			throw new Error(
				`Invalid alias name ${JSON.stringify(aliasName)} in family ${name}: names must be non-empty and cannot contain "/"`,
			);
		aliases[aliasName] = extractAlias(value, `${name}/${aliasName}`);
	}
	if (Object.keys(aliases).length === 0)
		throw new Error(`Invalid family ${name}: has no aliases`);
	return { aliases };
}

function extractRoster(raw: unknown, name: string): RosterTiers {
	if (!isPlainObject(raw)) throw new Error(`Invalid roster: ${name}`);
	for (const key of Object.keys(raw)) {
		if (!TIER_SET.has(key))
			throw new Error(
				`Invalid roster ${name}: unknown tier ${key} (tiers are exactly ${TIER_IDS.join(", ")})`,
			);
	}
	const tiers = {} as Record<TierId, readonly string[]>;
	for (const tier of TIER_IDS) {
		const value = raw[tier];
		if (value === undefined || value === null) {
			tiers[tier] = [];
			continue;
		}
		if (!Array.isArray(value))
			throw new Error(`Invalid roster ${name}: ${tier} must be an array`);
		for (const ref of value) {
			if (typeof ref !== "string" || !parseAliasRef(ref))
				throw new Error(
					`Invalid roster ${name}: ${tier} entry ${JSON.stringify(ref)} must be a "Family/Alias" ref`,
				);
		}
		if (new Set(value).size !== value.length)
			throw new Error(`Invalid roster ${name}: duplicate ref in ${tier}`);
		tiers[tier] = [...value] as string[];
	}
	if (TIER_IDS.every((tier) => tiers[tier].length === 0))
		throw new Error(`Invalid roster ${name}: every tier is empty`);
	return tiers;
}

function extractBinding(raw: unknown, name: string): V2BindingConfig {
	if (!isPlainObject(raw) || !nonEmpty(raw.roster))
		throw new Error(`Invalid binding ${name}: a roster reference is required`);
	let targets: readonly string[] | undefined;
	if (raw.targets !== undefined) {
		if (
			!Array.isArray(raw.targets) ||
			!raw.targets.every(isModelId) ||
			new Set(raw.targets).size !== raw.targets.length
		)
			throw new Error(
				`Invalid binding ${name}: targets must be unique concrete provider/model ids`,
			);
		targets = [...raw.targets] as string[];
	}
	return { roster: raw.roster, ...(targets ? { targets } : {}) };
}

function extractRegion(raw: unknown): RegionConfig {
	if (!isPlainObject(raw)) throw new Error("Invalid region: must be an object");
	let active: string | undefined;
	if (raw.active !== undefined) {
		if (!nonEmpty(raw.active))
			throw new Error("Invalid region: active must be a non-empty string");
		active = raw.active;
	}
	const lists: Record<string, readonly string[]> = {};
	if (raw.lists !== undefined) {
		if (!isPlainObject(raw.lists))
			throw new Error("Invalid region: lists must be an object");
		for (const [listName, value] of Object.entries(raw.lists)) {
			if (value === null || value === undefined) continue;
			if (
				!Array.isArray(value) ||
				value.length === 0 ||
				!value.every((pattern) => nonEmpty(pattern))
			)
				throw new Error(
					`Invalid region list ${listName}: must be a non-empty array of provider/model patterns`,
				);
			lists[listName] = [...value] as string[];
		}
	}
	return { ...(active ? { active } : {}), lists };
}

function extractAllowance(
	raw: unknown,
	name: string,
): AgentAllowanceConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	if (raw.tiers === undefined) return undefined;
	if (
		!Array.isArray(raw.tiers) ||
		raw.tiers.length === 0 ||
		!raw.tiers.every(
			(tier) => typeof tier === "string" && TIER_SET.has(tier),
		) ||
		new Set(raw.tiers).size !== raw.tiers.length
	)
		throw new Error(
			`Invalid allowances.${name}.tiers: must be a unique non-empty array of ${TIER_IDS.join("|")}`,
		);
	return { tiers: [...raw.tiers] as TierId[] };
}

interface ParsedV2 {
	readonly families: Record<string, FamilyConfig>;
	readonly rosters: Record<string, RosterTiers>;
	readonly bindings: Record<string, V2BindingConfig>;
	readonly region?: RegionConfig;
	readonly allowances: Partial<
		Record<SpawnableAgentType, AgentAllowanceConfig>
	>;
}

function extractV2(raw: unknown): ParsedV2 | undefined {
	if (!isPlainObject(raw)) return undefined;
	const models = isPlainObject(raw.models) ? raw.models : undefined;
	if (!models) return undefined;

	const families: Record<string, FamilyConfig> = {};
	if (isPlainObject(models.families)) {
		for (const [name, value] of Object.entries(models.families)) {
			if (value === null || value === undefined) continue;
			if (!nonEmpty(name) || name.includes("/"))
				throw new Error(
					`Invalid family name ${JSON.stringify(name)}: names must be non-empty and cannot contain "/"`,
				);
			families[name] = extractFamily(value, name);
		}
	}

	const rosters: Record<string, RosterTiers> = {};
	if (isPlainObject(models.rosters)) {
		for (const [name, value] of Object.entries(models.rosters)) {
			if (value === null || value === undefined) continue;
			rosters[name] = extractRoster(value, name);
		}
	}

	const bindings: Record<string, V2BindingConfig> = {};
	if (isPlainObject(models.bindings)) {
		for (const [name, value] of Object.entries(models.bindings)) {
			if (value === null || value === undefined) continue;
			bindings[name] = extractBinding(value, name);
		}
	}

	const region =
		models.region !== undefined ? extractRegion(models.region) : undefined;

	const allowances: Partial<Record<SpawnableAgentType, AgentAllowanceConfig>> =
		{};
	if (isPlainObject(models.allowances)) {
		for (const [name, value] of Object.entries(models.allowances)) {
			if (!AGENT_SET.has(name)) continue;
			if (value === null || value === undefined) continue;
			const allowance = extractAllowance(value, name);
			if (allowance) allowances[name as SpawnableAgentType] = allowance;
		}
	}

	return Object.keys(families).length ||
		Object.keys(rosters).length ||
		Object.keys(bindings).length ||
		region ||
		Object.keys(allowances).length
		? { families, rosters, bindings, region, allowances }
		: undefined;
}

/** Cross-object rules that only make sense on the merged config. */
export function validateV2Config(config: V2ModelsConfig): void {
	// Every roster ref must name an existing Family/Alias.
	for (const [rosterName, tiers] of Object.entries(config.rosters)) {
		for (const tier of TIER_IDS) {
			for (const ref of tiers[tier]) {
				const parsed = parseAliasRef(ref);
				if (!parsed || !config.families[parsed.family]?.aliases[parsed.alias])
					throw new Error(
						`Roster ${rosterName}.${tier} references unknown alias ${ref}`,
					);
			}
		}
	}
	// Bindings: roster exists, single default (targetless), no target overlap.
	const owner = new Map<string, string>();
	let defaultBinding: string | undefined;
	for (const [name, binding] of Object.entries(config.bindings)) {
		if (!config.rosters[binding.roster])
			throw new Error(
				`Binding ${name} references unknown roster ${binding.roster}`,
			);
		if (!binding.targets || binding.targets.length === 0) {
			if (defaultBinding)
				throw new Error(
					`Bindings ${defaultBinding} and ${name} both have no targets — only one default binding is allowed`,
				);
			defaultBinding = name;
			continue;
		}
		for (const target of binding.targets) {
			const previous = owner.get(target);
			if (previous && previous !== name)
				throw new Error(
					`Binding target ${target} overlaps between ${previous} and ${name}`,
				);
			owner.set(target, name);
		}
	}
	// Region: an active name must resolve to a list (or be the reserved off state).
	const active = config.region.active;
	if (active && !isRegionOff(active) && !config.region.lists[active])
		throw new Error(
			`Active region ${active} has no configured list — add it or set region off`,
		);
}

/**
 * Parse + merge + validate the v2 slice from two raw settings objects
 * (global, project — project winning per key). Exported so the /maestro
 * editor can validate a CANDIDATE global settings object before any byte is
 * written: an invalid v2 state is unwriteable, never write-then-warn. Throws
 * with the offending name; returns undefined when nothing v2 exists.
 */
export function parseV2Settings(
	globalRaw: unknown,
	projectRaw: unknown,
): V2ModelsConfig | undefined {
	const global = extractV2(globalRaw);
	const project = extractV2(projectRaw);
	if (!global && !project) return undefined;
	const activeRegionName = project?.region?.active ?? global?.region?.active;
	const region: RegionConfig = {
		...(activeRegionName ? { active: activeRegionName } : {}),
		lists: { ...global?.region?.lists, ...project?.region?.lists },
	};
	const config: V2ModelsConfig = {
		families: { ...global?.families, ...project?.families },
		rosters: { ...global?.rosters, ...project?.rosters },
		bindings: { ...global?.bindings, ...project?.bindings },
		region,
		allowances: {
			...DEFAULT_AGENT_ALLOWANCES,
			...global?.allowances,
			...project?.allowances,
		},
	};
	validateV2Config(config);
	return config;
}

/**
 * Read the merged v2 slice. Returns undefined when nothing v2 is configured
 * (an empty models block = inherit-all).
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
 * The family (and alias) a concrete model belongs to: the first family/alias
 * whose attachments list it. Used to derive the author's family for diversity
 * and the resolved identity for the footer. Undefined when the model is
 * attached to no alias (no diversity edge, footer shows the raw model).
 */
export function familyOfModel(
	config: V2ModelsConfig | undefined,
	modelId: string | undefined,
): { family: string; alias: string } | undefined {
	if (!config || !modelId) return undefined;
	for (const [family, familyConfig] of Object.entries(config.families)) {
		for (const [alias, aliasConfig] of Object.entries(familyConfig.aliases)) {
			if (aliasConfig.attach.includes(modelId)) return { family, alias };
		}
	}
	return undefined;
}

/**
 * The active binding for a session model: the binding whose targets contain
 * it, else the default (targetless) binding, else undefined.
 */
export function activeV2Binding(
	config: V2ModelsConfig | undefined,
	sessionModelId: string | undefined,
): { id: string; binding: V2BindingConfig } | undefined {
	if (!config) return undefined;
	if (sessionModelId) {
		for (const [id, binding] of Object.entries(config.bindings)) {
			if (binding.targets?.includes(sessionModelId)) return { id, binding };
		}
	}
	for (const [id, binding] of Object.entries(config.bindings)) {
		if (!binding.targets || binding.targets.length === 0)
			return { id, binding };
	}
	return undefined;
}
