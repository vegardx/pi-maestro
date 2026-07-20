// Domain configuration for /maestro. This module owns layered authored values
// that are richer than capability-declared scalar settings: exact model sets,
// preset bindings, semantic kind bindings, runtime policy composition, and
// transition-gate contracts.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	AGENT_KINDS,
	type AgentKind,
	type AgentKindDefinition,
	type AgentPermissionPolicy,
	type AgentRuntimePolicyDefinition,
	type AgentSessionPolicy,
	type AgentTransportPolicy,
	ALL_MODES,
	MODEL_ROLES,
	type ModelRole,
	type SessionSettingValue,
	SPAWNABLE_AGENT_TYPES,
	type SpawnableAgentType,
	TIER_IDS,
	type TierId,
} from "@vegardx/pi-contracts";
import {
	activePreset,
	activeV2Profile,
	explainTier,
	readModelsConfig,
	readV2Config,
	resolveExactModelSelection,
} from "@vegardx/pi-models";
import {
	formatSettingValue,
	type LayeredValue,
	type MaestroScope,
	readAdvancedValue,
	sessionModelId,
	writeAdvancedValue,
} from "./model.js";
import { isPlainObject } from "./reader.js";

import { updateSettingsFile } from "./writer.js";

export const DOMAIN_EXTENSION = "maestro";
const THINKING = new Set<string>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const MODES = new Set<string>(ALL_MODES);

export interface ModelOptionConfig {
	readonly id: string;
	readonly model: string;
	readonly effort: string;
	readonly summary: string;
}
export interface ModelSetDetail {
	readonly id: string;
	readonly options: readonly ModelOptionConfig[];
	readonly usedBy: readonly string[];
}
export interface PresetDetail {
	readonly id: string;
	readonly targets: readonly string[];
	readonly modelSets: Readonly<Record<string, string>>;
	readonly source: "global" | "project" | "mixed" | "unset";
}
export interface AgentKindBinding {
	readonly kind: AgentKind;
	readonly modelSet?: string;
	readonly option?: string;
	readonly runtimePolicy: string;
	readonly source: MaestroScope | "builtin";
}
export interface RuntimePolicyConfig {
	readonly id: string;
	readonly permissions: string;
	readonly session: string;
	readonly transport: string;
}
export interface TransitionGateConfig {
	readonly id: string;
	readonly edges: readonly string[];
	readonly agentKind: AgentKind;
	readonly contract: string;
	readonly enabled: boolean;
}
export interface DomainSnapshot {
	readonly mainModel?: string;
	readonly contextFacts: {
		readonly cwd: string;
		readonly provider?: string;
		readonly modelId?: string;
		readonly contextWindow?: number;
		readonly maxTokens?: number;
	};
	readonly activePreset?: string;
	readonly matchedTarget?: string;
	readonly presets: readonly PresetDetail[];
	readonly modelSets: readonly ModelSetDetail[];
	readonly kinds: readonly AgentKindBinding[];
	readonly kindDefinitions: readonly AgentKindDefinition[];
	readonly runtimePolicies: readonly RuntimePolicyConfig[];
	readonly permissions: readonly AgentPermissionPolicy[];
	readonly sessions: readonly AgentSessionPolicy[];
	readonly transports: readonly AgentTransportPolicy[];
	readonly gates: readonly TransitionGateConfig[];
}

export interface DomainRegistryInput {
	readonly kinds?: readonly AgentKindDefinition[];
	readonly runtime?: {
		readonly policies?: readonly AgentRuntimePolicyDefinition[];
		readonly permissions?: readonly AgentPermissionPolicy[];
		readonly sessions?: readonly AgentSessionPolicy[];
		readonly transports?: readonly AgentTransportPolicy[];
	};
}

export const DEFAULT_TRANSITION_GATES: readonly TransitionGateConfig[] = [
	{
		id: "execution-readiness",
		edges: ["plan->auto", "plan->hack"],
		agentKind: "plan-review",
		contract: "bounded-report",
		enabled: true,
	},
];

function objectAt(
	raw: unknown,
	path: readonly string[],
): Record<string, unknown> {
	let value: unknown = raw;
	for (const part of path) {
		if (!isPlainObject(value)) return {};
		value = value[part];
	}
	return isPlainObject(value) ? value : {};
}

function sourceFor(global: unknown, project: unknown): PresetDetail["source"] {
	if (global !== undefined && project !== undefined) return "mixed";
	if (project !== undefined) return "project";
	if (global !== undefined) return "global";
	return "unset";
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (cause) {
		throw new Error(
			`Value must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function strings(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(nonEmpty);
}

function validateOption(value: unknown, path: string): string[] {
	if (!isPlainObject(value)) return [`${path} must be an object`];
	const errors: string[] = [];
	if (!nonEmpty(value.id)) errors.push(`${path}.id must be non-empty`);
	if (
		!nonEmpty(value.model) ||
		(value.model !== "session" && !String(value.model).includes("/"))
	)
		errors.push(`${path}.model must be session or provider/model`);
	if (
		!nonEmpty(value.effort) ||
		(value.effort !== "auto" && !THINKING.has(value.effort))
	)
		errors.push(`${path}.effort is unsupported`);
	if (value.efforts !== undefined) {
		if (
			!strings(value.efforts) ||
			value.efforts.length === 0 ||
			value.efforts.some((level) => !THINKING.has(level))
		)
			errors.push(`${path}.efforts must be a non-empty thinking-level array`);
		else if (
			value.effort !== "auto" &&
			nonEmpty(value.effort) &&
			!value.efforts.includes(value.effort)
		)
			errors.push(`${path}.effort must be inside its own efforts allowlist`);
	}
	if (!nonEmpty(value.summary))
		errors.push(`${path}.summary must be non-empty`);
	return errors;
}

export function validateDomainValue(key: string, value: unknown): string[] {
	const parts = key.split(".");
	if (
		parts[0] !== "models" &&
		parts[0] !== "agents" &&
		parts[0] !== "transitionGates"
	)
		return [];
	// null deletes the key (reset / remove-from-menu); always structurally valid.
	if (value === null || value === "null") return [];
	// Whole-preset writes let the editor create/replace a preset in one step.
	if (parts[0] === "models" && parts[1] === "presets" && parts.length === 3) {
		if (!isPlainObject(value)) return ["preset must be an object"];
		const errors: string[] = [];
		if (value.targets !== undefined) {
			if (!strings(value.targets))
				errors.push("preset targets must be a string array");
			else if (value.targets.some((entry) => !entry.includes("/")))
				errors.push("preset targets must be exact provider/model ids");
		}
		if (value.modelSets !== undefined) {
			if (!isPlainObject(value.modelSets))
				errors.push("preset modelSets must be an object");
			else
				for (const [role, set] of Object.entries(value.modelSets)) {
					if (!MODEL_ROLES.includes(role as ModelRole))
						errors.push(`unknown model role ${role}`);
					if (!nonEmpty(set))
						errors.push(`modelSets.${role} must name a model set`);
				}
		}
		return errors;
	}
	if (parts[0] === "models" && parts[1] === "modelSets") {
		if (parts.length === 3) {
			const options = Array.isArray(value)
				? value
				: isPlainObject(value) && Array.isArray(value.options)
					? value.options
					: undefined;
			if (!options?.length)
				return ["model set requires a non-empty options array"];
			const errors = options.flatMap((option, index) =>
				validateOption(option, `options[${index}]`),
			);
			const ids = options
				.filter(isPlainObject)
				.map((option) => option.id)
				.filter(nonEmpty);
			if (new Set(ids).size !== ids.length)
				errors.push("model option ids must be unique");
			return errors;
		}
	}
	if (parts[0] === "models" && parts[1] === "presets" && parts.length === 4) {
		if (parts[3] === "targets") {
			if (!strings(value) || value.length === 0)
				return ["preset targets require a non-empty string array"];
			if (value.some((entry) => !entry.includes("/")))
				return ["preset targets must be exact provider/model ids"];
			return [];
		}
		if (parts[3] === "modelSets") {
			if (!isPlainObject(value)) return ["preset modelSets must be an object"];
			return Object.entries(value).flatMap(([role, set]) => [
				...(MODEL_ROLES.includes(role as ModelRole)
					? []
					: [`unknown model role ${role}`]),
				...(nonEmpty(set) ? [] : [`modelSets.${role} must name a model set`]),
			]);
		}
	}
	// v2: whole-catalog writes ({ fast?: [...], normal?: [...], heavy?: [...] }).
	// `models.catalogs` is canonical (migration + menu); `models.catalog` is
	// the legacy spelling the reader still honors.
	if (
		parts[0] === "models" &&
		(parts[1] === "catalog" || parts[1] === "catalogs") &&
		parts.length === 3
	) {
		if (!isPlainObject(value)) return ["catalog must be an object"];
		const errors: string[] = [];
		for (const [tier, entries] of Object.entries(value)) {
			if (!TIER_IDS.includes(tier as TierId)) {
				errors.push(`unknown tier ${tier} (tiers are ${TIER_IDS.join(", ")})`);
				continue;
			}
			if (entries === null) continue; // tier deletion marker
			if (!Array.isArray(entries)) {
				errors.push(`${tier} must be an array`);
				continue;
			}
			entries.forEach((entry, index) => {
				if (!isPlainObject(entry) || !nonEmpty(entry.model))
					errors.push(`${tier}[${index}].model is required`);
				else if (!String(entry.model).includes("/"))
					errors.push(
						`${tier}[${index}].model must be a concrete provider/model ref`,
					);
				if (
					isPlainObject(entry) &&
					entry.effort !== undefined &&
					!THINKING.has(entry.effort as string)
				)
					errors.push(`${tier}[${index}].effort is unsupported`);
			});
		}
		return errors;
	}
	// v2: whole-profile writes ({ catalog, targets? }).
	if (parts[0] === "models" && parts[1] === "profiles" && parts.length === 3) {
		if (!isPlainObject(value)) return ["profile must be an object"];
		const errors: string[] = [];
		if (!nonEmpty(value.catalog))
			errors.push("profile catalog reference is required");
		if (value.targets !== undefined) {
			if (!strings(value.targets))
				errors.push("profile targets must be a string array");
			else if (value.targets.some((entry) => !entry.includes("/")))
				errors.push("profile targets must be exact provider/model ids");
		}
		return errors;
	}
	if (parts[0] === "models" && parts[1] === "residency") {
		if (parts.length === 3 && parts[2] === "active") {
			return nonEmpty(value)
				? []
				: ["residency active must be a non-empty name"];
		}
		if (parts.length === 4 && parts[2] === "lists") {
			if (["off", "none"].includes(parts[3].toLowerCase()))
				return ['"off"/"none" are reserved (the no-filter state)'];
			return strings(value) && value.length > 0
				? []
				: ["residency list requires a non-empty pattern array"];
		}
	}
	// v2: per-agent-type tier allowlists (agents.worker.models = ["normal","heavy"]).
	if (
		parts[0] === "agents" &&
		SPAWNABLE_AGENT_TYPES.includes(parts[1] as SpawnableAgentType) &&
		parts.length === 3 &&
		parts[2] === "models"
	) {
		if (
			!strings(value) ||
			value.length === 0 ||
			value.some((tier) => !TIER_IDS.includes(tier as TierId))
		)
			return [
				`agent tier allowlist must be a non-empty array of ${TIER_IDS.join("|")}`,
			];
		if (new Set(value).size !== value.length)
			return ["agent tier allowlist entries must be unique"];
		return [];
	}
	if (parts[0] === "agents" && parts[1] === "kinds" && parts.length === 4) {
		if (!AGENT_KINDS.includes(parts[2] as AgentKind))
			return [`unknown agent kind ${parts[2]}`];
		if (!nonEmpty(value)) return [`${parts[3]} must be non-empty`];
		return ["modelSet", "option", "runtimePolicy"].includes(parts[3])
			? []
			: [`unsupported kind binding ${parts[3]}`];
	}
	if (
		parts[0] === "agents" &&
		parts[1] === "runtimePolicies" &&
		parts.length === 3
	) {
		if (!isPlainObject(value)) return ["runtime policy must be an object"];
		return ["permissions", "session", "transport"].flatMap((field) =>
			nonEmpty(value[field])
				? []
				: [`runtime policy ${field} reference is required`],
		);
	}
	if (parts[0] === "transitionGates" && parts.length === 2) {
		if (!isPlainObject(value)) return ["transition gate must be an object"];
		const errors: string[] = [];
		if (!strings(value.edges) || value.edges.length === 0)
			errors.push("transition gate edges require a non-empty string array");
		else
			for (const edge of value.edges) {
				const [from, to, extra] = edge.split("->");
				if (
					extra ||
					!MODES.has(from ?? "") ||
					!MODES.has(to ?? "") ||
					from === to
				)
					errors.push(`invalid transition edge ${edge}`);
			}
		if (
			!nonEmpty(value.agentKind) ||
			!AGENT_KINDS.includes(value.agentKind as AgentKind)
		)
			errors.push("transition gate agentKind is unsupported");
		if (!nonEmpty(value.contract))
			errors.push("transition gate contract is required");
		if (value.enabled !== undefined && typeof value.enabled !== "boolean")
			errors.push("transition gate enabled must be boolean");
		return errors;
	}
	return [`unsupported domain key ${key}`];
}

function candidateValue(
	cwd: string,
	key: string,
	scope: MaestroScope,
	value: SessionSettingValue,
): unknown {
	const current = readAdvancedValue(cwd, DOMAIN_EXTENSION, key);
	return {
		global: current.global,
		project: current.project,
		session: current.session,
		[scope]: value,
	};
}

/** Validate a proposed edit against the effective graph before writing it. */
export function validateDomainEdit(
	ctx: ExtensionContext,
	key: string,
	scope: MaestroScope,
	value: SessionSettingValue,
	registry: DomainRegistryInput = {},
): string[] {
	const parsed =
		value === "null"
			? null
			: typeof value === "string" &&
					(value.startsWith("{") ||
						value.startsWith("[") ||
						value.startsWith('"'))
				? parseJson(value)
				: value;
	const errors = validateDomainValue(key, parsed);
	const config = readModelsConfig(ctx.cwd);
	if (
		key.startsWith("models.presets.") &&
		key.endsWith(".targets") &&
		Array.isArray(parsed)
	) {
		const presetId = key.split(".")[2] ?? "";
		for (const [other, preset] of Object.entries(config?.presets ?? {})) {
			if (other === presetId) continue;
			for (const target of parsed)
				if (preset.targets.includes(String(target)))
					errors.push(`target ${target} is already owned by preset ${other}`);
		}
	}
	if (
		key.startsWith("models.presets.") &&
		key.endsWith(".modelSets") &&
		isPlainObject(parsed)
	) {
		for (const setId of Object.values(parsed))
			if (nonEmpty(setId) && !config?.modelSets[setId])
				errors.push(`unknown model set ${setId}`);
	}
	if (key.startsWith("agents.kinds.")) {
		const [, , kindId, leaf] = key.split(".");
		if (leaf === "modelSet" && nonEmpty(parsed) && !config?.modelSets[parsed])
			errors.push(`unknown model set ${parsed}`);
		if (leaf === "option" && nonEmpty(parsed)) {
			const binding = readAdvancedValue(
				ctx.cwd,
				DOMAIN_EXTENSION,
				`agents.kinds.${kindId}.modelSet`,
			).effective;
			const set =
				typeof binding === "string" ? config?.modelSets[binding] : undefined;
			if (!set?.options.some((option) => option.id === parsed))
				errors.push(`option ${parsed} is not in the bound model set`);
		}
		if (leaf === "runtimePolicy" && nonEmpty(parsed)) {
			const ids = new Set([
				...(registry.runtime?.policies ?? []).map((item) => item.id),
				...Object.keys(domainObjects(ctx, "agents.runtimePolicies")),
			]);
			if (!ids.has(parsed)) errors.push(`unknown runtime policy ${parsed}`);
		}
	}
	if (key.startsWith("agents.runtimePolicies.") && isPlainObject(parsed)) {
		const sets = {
			permissions: new Set(
				(registry.runtime?.permissions ?? []).map((item) => item.id),
			),
			session: new Set(
				(registry.runtime?.sessions ?? []).map((item) => item.id),
			),
			transport: new Set(
				(registry.runtime?.transports ?? []).map((item) => item.id),
			),
		};
		for (const field of Object.keys(sets) as Array<keyof typeof sets>)
			if (nonEmpty(parsed[field]) && !sets[field].has(parsed[field] as string))
				errors.push(`unknown ${field} policy ${parsed[field]}`);
		const permission = (registry.runtime?.permissions ?? []).find(
			(item) => item.id === parsed.permissions,
		);
		const session = (registry.runtime?.sessions ?? []).find(
			(item) => item.id === parsed.session,
		);
		const transport = (registry.runtime?.transports ?? []).find(
			(item) => item.id === parsed.transport,
		);
		if (
			permission?.mode === "full" &&
			permission.isolation === "host" &&
			session?.session === "ephemeral"
		)
			errors.push(
				"unsafe runtime policy: ephemeral full-access host agents are not allowed",
			);
		if (transport?.transport === "host" && permission?.mode !== "full")
			errors.push(
				"unsafe runtime policy: read-only agents cannot use host transport",
			);
	}
	if (key.startsWith("transitionGates.") && isPlainObject(parsed)) {
		const kind = (registry.kinds ?? []).find(
			(entry) => entry.id === parsed.agentKind,
		);
		if (!kind)
			errors.push(`unknown gate agent kind ${String(parsed.agentKind)}`);
		else if (
			!kind.contracts.some((contract) => contract.id === parsed.contract)
		)
			errors.push(
				`agent kind ${kind.id} does not provide contract ${String(parsed.contract)}`,
			);
	}
	void candidateValue(ctx.cwd, key, scope, value); // documents all scopes as valid edit targets
	return errors;
}

function domainObjects(
	ctx: ExtensionContext,
	path: string,
): Record<string, unknown> {
	const manager = SettingsManager.create(ctx.cwd);
	const parts = path.split(".");
	return {
		...objectAt(manager.getGlobalSettings(), [
			"extensionConfig",
			DOMAIN_EXTENSION,
			...parts,
		]),
		...objectAt(manager.getProjectSettings(), [
			"extensionConfig",
			DOMAIN_EXTENSION,
			...parts,
		]),
	};
}

function binding(
	ctx: ExtensionContext,
	kind: AgentKind,
	leaf: "modelSet" | "option" | "runtimePolicy",
): LayeredValue<SessionSettingValue> {
	return readAdvancedValue(
		ctx.cwd,
		DOMAIN_EXTENSION,
		`agents.kinds.${kind}.${leaf}`,
	);
}

export function readDomainSnapshot(
	ctx: ExtensionContext,
	registry: DomainRegistryInput = {},
): DomainSnapshot {
	let config: ReturnType<typeof readModelsConfig>;
	try {
		config = readModelsConfig(ctx.cwd);
	} catch {
		config = undefined;
	}
	const manager = SettingsManager.create(ctx.cwd);
	const globalPresets = objectAt(manager.getGlobalSettings(), [
		"models",
		"presets",
	]);
	const projectPresets = objectAt(manager.getProjectSettings(), [
		"models",
		"presets",
	]);
	const mainModel = sessionModelId(ctx);
	const active = activePreset(config, mainModel);
	const presets = Object.entries(config?.presets ?? {}).map(([id, preset]) => ({
		id,
		targets: preset.targets,
		modelSets: Object.fromEntries(
			Object.entries(preset.modelSets).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		),
		source: sourceFor(globalPresets[id], projectPresets[id]),
	}));
	const modelSets = Object.entries(config?.modelSets ?? {}).map(
		([id, set]) => ({
			id,
			options: set.options,
			usedBy: presets.flatMap((preset) =>
				Object.entries(preset.modelSets)
					.filter(([, setId]) => setId === id)
					.map(([role]) => `preset ${preset.id} · ${role}`),
			),
		}),
	);
	const builtins = new Map(
		(registry.kinds ?? []).map((kind) => [kind.id, kind]),
	);
	const kinds = AGENT_KINDS.map((kind) => ({
		kind,
		modelSet: binding(ctx, kind, "modelSet").effective as string | undefined,
		option: binding(ctx, kind, "option").effective as string | undefined,
		runtimePolicy:
			(binding(ctx, kind, "runtimePolicy").effective as string | undefined) ??
			builtins.get(kind)?.runtimePolicy ??
			"unset",
		source:
			binding(ctx, kind, "runtimePolicy").source === "default"
				? ("builtin" as const)
				: ((binding(ctx, kind, "runtimePolicy").source ?? "builtin") as
						| MaestroScope
						| "builtin"),
	}));
	const authoredPolicies = domainObjects(ctx, "agents.runtimePolicies");
	const runtimePolicies: RuntimePolicyConfig[] = [
		...(registry.runtime?.policies ?? []),
		...Object.entries(authoredPolicies).flatMap(([id, raw]) =>
			isPlainObject(raw) &&
			nonEmpty(raw.permissions) &&
			nonEmpty(raw.session) &&
			nonEmpty(raw.transport)
				? [
						{
							id,
							permissions: raw.permissions,
							session: raw.session,
							transport: raw.transport,
						},
					]
				: [],
		),
	].filter(
		(entry, index, all) =>
			all.findIndex((candidate) => candidate.id === entry.id) === index,
	);
	const authoredGates = domainObjects(ctx, "transitionGates");
	const gates = Object.keys(authoredGates).length
		? Object.entries(authoredGates).flatMap(([id, raw]) =>
				isPlainObject(raw) &&
				strings(raw.edges) &&
				nonEmpty(raw.agentKind) &&
				nonEmpty(raw.contract)
					? [
							{
								id,
								edges: raw.edges,
								agentKind: raw.agentKind as AgentKind,
								contract: raw.contract,
								enabled: raw.enabled !== false,
							},
						]
					: [],
			)
		: [...DEFAULT_TRANSITION_GATES];
	return {
		mainModel,
		contextFacts: {
			cwd: ctx.cwd,
			provider: ctx.model?.provider,
			modelId: ctx.model?.id,
			contextWindow: (ctx.model as { contextWindow?: number } | undefined)
				?.contextWindow,
			maxTokens: (ctx.model as { maxTokens?: number } | undefined)?.maxTokens,
		},
		activePreset: active?.id,
		matchedTarget:
			active && mainModel && active.preset.targets.includes(mainModel)
				? mainModel
				: undefined,
		presets,
		modelSets,
		kinds,
		kindDefinitions: registry.kinds ?? [],
		runtimePolicies,
		permissions: registry.runtime?.permissions ?? [],
		sessions: registry.runtime?.sessions ?? [],
		transports: registry.runtime?.transports ?? [],
		gates,
	};
}

export async function explainModelSelection(
	ctx: ExtensionContext,
	role: ModelRole,
): Promise<string> {
	const snapshot = readDomainSnapshot(ctx);
	const result = await resolveExactModelSelection(ctx, { role });
	const lines = [
		`Main model: ${snapshot.mainModel ?? "none"}`,
		`Active preset: ${snapshot.activePreset ?? "none"}${snapshot.matchedTarget ? ` (matched target ${snapshot.matchedTarget})` : ""}`,
		`Context facts: cwd=${snapshot.contextFacts.cwd} · provider=${snapshot.contextFacts.provider ?? "none"} · context=${snapshot.contextFacts.contextWindow ?? "unknown"} · max output=${snapshot.contextFacts.maxTokens ?? "unknown"}`,
		`Assignment: ${result.selected ? `${result.selected.modelId} @ ${result.selected.effort} (${result.selected.optionId})` : "unavailable"}`,
		`Source/provenance: ${result.selected?.source ?? "none"} · preset ${result.presetId ?? "none"} · set ${result.modelSetId ?? "none"}`,
		"Options:",
		...result.candidates.map(
			(fact, index) =>
				`  ${index + 1}. ${fact.optionId}: ${fact.modelId ?? fact.authoredModel} @ ${fact.effort} — ${fact.available ? "available" : (fact.reason ?? "unavailable")} — ${fact.summary}`,
		),
	];
	if (result.errors.length)
		lines.push(
			"Errors:",
			...result.errors.map((error) => `  - ${error.code}: ${error.message}`),
		);
	if (result.selected?.source === "session")
		lines.push(
			"Fallback: no configured active assignment; the exact live /model option is used.",
		);
	else
		lines.push(
			"Fallback: configured model sets do not gain an implicit session fallback; options are tried in authored order.",
		);
	return lines.join("\n");
}

/**
 * The v2 explanation: inheritance-first. The seat's model is the universal
 * default every spawned agent inherits; tiers exist only for deliberate
 * variation (persona instructions, policy rows), filtered by residency and
 * the agent's tier allowlist. One screen answers "what would this agent
 * actually run on, and why".
 */
export async function explainModelSelectionV2(
	ctx: ExtensionContext,
	agent: SpawnableAgentType,
): Promise<string> {
	const sessionModel = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: undefined;
	const config = readV2Config(ctx.cwd);
	const lines: string[] = [
		`Seat (session model): ${sessionModel ?? "none"} — every spawned agent INHERITS this unless a tier is deliberately requested.`,
	];
	if (!config) {
		lines.push(
			"No v2 catalogs/profiles configured: everything inherits the seat.",
			"(v1 presets are auto-migrated at boot when present; or author catalogs and profiles under the models settings key.)",
		);
		return lines.join("\n");
	}
	const active = activeV2Profile(config, sessionModel);
	lines.push(
		active
			? `Profile: ${active.id}${active.profile.targets?.length ? ` (target ${sessionModel})` : " (default profile)"} → catalog ${active.profile.catalog}`
			: "Profile: none matches this seat — tier requests fall back to the seat with a visible notice.",
	);
	const allowed = config.agents[agent]?.models ?? [];
	lines.push(
		`Agent ${agent}: allowed tiers ${allowed.length ? allowed.join(", ") : "none"}`,
	);
	for (const tier of TIER_IDS) {
		const explained = await explainTier(ctx, agent, tier);
		const marker = allowed.includes(tier)
			? ""
			: " (not allowed for this agent)";
		if (explained.candidates.length === 0) {
			lines.push(
				`  ${tier}${marker}: empty — a ${tier} request falls back to the seat (deduped notice).`,
			);
			continue;
		}
		lines.push(`  ${tier}${marker}:`);
		for (const fact of explained.candidates) {
			const detail = [
				fact.effort ? `@ ${fact.effort}` : undefined,
				fact.family ? `family ${fact.family}` : undefined,
				fact.available ? "available" : (fact.reason ?? "unavailable"),
				fact.notes,
			]
				.filter(Boolean)
				.join(" — ");
			lines.push(`    - ${fact.model} ${detail}`);
		}
	}
	lines.push(
		"Resolution order: inherit the caller's model unless a tier is named (persona instruction or policy row); residency strikes non-members before any reasoning; an unresolvable tier falls back to the seat, visibly.",
	);
	return lines.join("\n");
}

export function domainImpact(
	snapshot: DomainSnapshot,
	key: string,
	value: unknown,
): string[] {
	const parts = key.split(".");
	if (parts[0] === "models" && parts[1] === "modelSets") {
		const setId = parts[2] ?? "";
		const used =
			snapshot.modelSets.find((set) => set.id === setId)?.usedBy ?? [];
		return [
			`Changes exact options for ${used.length ? used.join(", ") : "no current bindings"}.`,
			`New value: ${formatSettingValue(value)}`,
		];
	}
	if (parts[0] === "agents" && parts[1] === "runtimePolicies") {
		const id = parts[2];
		const used = snapshot.kinds
			.filter((kind) => kind.runtimePolicy === id)
			.map((kind) => kind.kind);
		return [
			`Used by: ${used.join(", ") || "none"}.`,
			"Future runs resolve this policy before spawn; live assignments remain immutable.",
		];
	}
	if (parts[0] === "agents" && parts[1] === "kinds")
		return [
			`Affects future ${parts[2]} runs only; persisted assignments are unchanged.`,
		];
	if (parts[0] === "transitionGates")
		return [
			`Affects ${isPlainObject(value) && strings(value.edges) ? value.edges.join(", ") : "configured transitions"}; in-flight rulings keep their persisted contract.`,
		];
	if (parts[0] === "models" && parts[1] === "presets")
		return [
			`May change which preset activates for /model and every role mapped by preset ${parts[2]}.`,
		];
	return [];
}

function setObjectPath(
	root: Record<string, unknown>,
	parts: readonly string[],
	value: unknown,
): void {
	// null means DELETE. Storing a literal null poisoned the whole models
	// config: extractModels threw on the null entry and every preset/set
	// disappeared from view at once (2026-07-19).
	if (value === null || value === undefined) {
		let current: Record<string, unknown> = root;
		const chain: Record<string, unknown>[] = [root];
		for (const part of parts.slice(0, -1)) {
			const next = current[part];
			if (!isPlainObject(next)) return; // nothing to delete
			current = next;
			chain.push(current);
		}
		delete current[parts.at(-1) as string];
		// Prune now-empty parents so deletes leave no husk objects behind.
		for (let i = chain.length - 1; i > 0; i--) {
			if (Object.keys(chain[i]).length === 0)
				delete chain[i - 1][parts[i - 1] as string];
			else break;
		}
		return;
	}
	let current = root;
	for (const part of parts.slice(0, -1)) {
		if (!isPlainObject(current[part])) current[part] = {};
		current = current[part] as Record<string, unknown>;
	}
	current[parts.at(-1) as string] = value;
}

export function writeDomainValue(
	ctx: ExtensionContext,
	key: string,
	scope: MaestroScope,
	raw: string,
	registry: DomainRegistryInput = {},
): string[] {
	const parsed = parseJson(raw);
	const serialized: SessionSettingValue =
		typeof parsed === "boolean" ||
		typeof parsed === "number" ||
		typeof parsed === "string" ||
		(Array.isArray(parsed) && parsed.every((item) => typeof item === "string"))
			? (parsed as SessionSettingValue)
			: JSON.stringify(parsed);
	const errors = validateDomainEdit(ctx, key, scope, serialized, registry);
	if (errors.length) return errors;
	// v2 agent tier allowlists live in the raw settings root (next to
	// models.*) so readV2Config sees them — unlike kind bindings, which stay
	// in the maestro extension config.
	const rawSettingsKey =
		key.startsWith("models.") ||
		/^agents\.(worker|explorer|reviewer)\.models$/.test(key);
	if (rawSettingsKey && scope !== "session") {
		updateSettingsFile(scope, ctx.cwd, undefined, (root) =>
			setObjectPath(root, key.split("."), parsed),
		);
	} else {
		writeAdvancedValue(ctx.cwd, DOMAIN_EXTENSION, key, scope, serialized);
	}
	return [];
}
