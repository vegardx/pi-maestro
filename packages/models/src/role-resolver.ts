// Role-pool model resolution. Direct role APIs enforce configured allowlists;
// deprecated tier/extension inputs remain as a compatibility facade for runtime
// callers that have not migrated yet.

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	MODEL_ROLES,
	type ModelRole,
	type ResolvedRoleCandidate,
	type ResolvedRoleModel,
	type RoleModelConfig,
	type RolePoolSource,
	type RoleResolutionError,
	type ThinkingLevel,
	type Tier,
} from "@vegardx/pi-contracts";
import {
	type ExtensionConfigMap,
	getConfigObject,
	readLayeredExtensionConfig,
} from "@vegardx/pi-settings";
import { effectiveRolePool, readModelsConfig } from "./profiles.js";
import { parseModelSpec } from "./resolver.js";

const EFFORTS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];
const EFFORT_SET = new Set<string>(EFFORTS);
const ROLE_SET = new Set<string>(MODEL_ROLES);

export interface ExactRoleChoice {
	readonly model?: string;
	readonly effort?: ThinkingLevel;
}

/** New strict API input. */
export interface RolePoolResolveOptions {
	readonly role: ModelRole;
	readonly choice?: ExactRoleChoice;
	readonly requireApiKey?: boolean;
}

export interface AuthenticatedRoleCandidate extends ResolvedRoleCandidate {
	readonly model: Model<Api>;
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
}

/** Result is returned even on failure so authored validation errors stay visible. */
export interface RolePoolResolution {
	readonly role: ModelRole;
	readonly profile?: string;
	readonly configuredModels: readonly string[];
	readonly candidates: readonly AuthenticatedRoleCandidate[];
	readonly allowedEfforts: readonly ThinkingLevel[];
	readonly provenance: RolePoolSource;
	readonly selected: ResolvedRoleModelFull | null;
	readonly errors: readonly RoleResolutionError[];
}

export interface ResolvedRoleModelFull extends ResolvedRoleModel {
	readonly model: Model<Api>;
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
}

function lookup(ctx: ExtensionContext, spec: string): Model<Api> | undefined {
	const parsed = parseModelSpec(spec);
	return parsed
		? ctx.modelRegistry.find(parsed.provider, parsed.modelId)
		: undefined;
}

async function authenticate(
	ctx: ExtensionContext,
	spec: string,
	requireApiKey?: boolean,
): Promise<{
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
} | null> {
	const model = lookup(ctx, spec);
	if (!model) return null;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || (requireApiKey && !auth.apiKey)) return null;
	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

function modelId(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

/** Pi's null map entries are explicitly unsupported; missing entries default. */
export function supportedEfforts(model: Model<Api>): readonly ThinkingLevel[] {
	const details = model as Model<Api> & {
		reasoning?: boolean;
		thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	};
	if (details.reasoning === false) return ["off"];
	return EFFORTS.filter(
		(effort) => details.thinkingLevelMap?.[effort] !== null,
	);
}

function intersection(
	configured: readonly ThinkingLevel[],
	supported: readonly ThinkingLevel[],
): readonly ThinkingLevel[] {
	if (configured.length === 0) return supported;
	const supportedSet = new Set(supported);
	return configured.filter((effort) => supportedSet.has(effort));
}

function error(
	code: RoleResolutionError["code"],
	message: string,
	choice: ExactRoleChoice = {},
): RoleResolutionError {
	return {
		code,
		message,
		...(choice.model ? { modelId: choice.model } : {}),
		...(choice.effort ? { effort: choice.effort } : {}),
	};
}

/**
 * Resolve an authenticated direct-role pool. Explicit choices are exact and
 * never substituted; omitted model choices walk the ordered pool, then the
 * live session model. Omitted efforts use the first supported allowed effort.
 */
export async function resolveRolePool(
	ctx: ExtensionContext,
	opts: RolePoolResolveOptions,
): Promise<RolePoolResolution> {
	const sessionId = modelId(ctx);
	const pool = effectiveRolePool(
		readModelsConfig(ctx.cwd),
		opts.role,
		sessionId,
	);
	const configuredModels = pool?.models ?? [];
	const configuredEfforts = pool?.efforts ?? [];
	const candidates: AuthenticatedRoleCandidate[] = [];
	for (const candidateId of configuredModels) {
		const auth = await authenticate(ctx, candidateId, opts.requireApiKey);
		if (!auth) continue;
		candidates.push({
			modelId: candidateId,
			...auth,
			supportedEfforts: intersection(
				configuredEfforts,
				supportedEfforts(auth.model),
			),
		});
	}

	const base = {
		role: opts.role,
		profile: pool?.profile,
		configuredModels,
		candidates,
		allowedEfforts: configuredEfforts,
		provenance: pool?.provenance ?? {},
	};
	const choice = opts.choice ?? {};
	if (choice.model && !configuredModels.includes(choice.model)) {
		const errors = [
			error(
				"explicit-model-not-allowed",
				`Model ${choice.model} is not in the ${opts.role} pool`,
				choice,
			),
		];
		return { ...base, selected: null, errors };
	}
	if (choice.effort && configuredEfforts.length > 0) {
		if (!configuredEfforts.includes(choice.effort)) {
			const errors = [
				error(
					"explicit-effort-not-allowed",
					`Effort ${choice.effort} is not in the ${opts.role} pool`,
					choice,
				),
			];
			return { ...base, selected: null, errors };
		}
	}

	let selectedCandidate: AuthenticatedRoleCandidate | undefined;
	if (choice.model) {
		selectedCandidate = candidates.find(
			(item) => item.modelId === choice.model,
		);
		if (!selectedCandidate) {
			const errors = [
				error(
					"explicit-model-unavailable",
					`Model ${choice.model} is unavailable or unauthenticated`,
					choice,
				),
			];
			return { ...base, selected: null, errors };
		}
	} else {
		selectedCandidate = candidates.find(
			(item) =>
				(!choice.effort && item.supportedEfforts.length > 0) ||
				(choice.effort !== undefined &&
					item.supportedEfforts.includes(choice.effort)),
		);
	}

	let selectedSource: "profile" | "session" = "profile";
	if (!selectedCandidate && !choice.model && ctx.model && sessionId) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (auth.ok && (!opts.requireApiKey || auth.apiKey)) {
			const efforts = intersection(
				configuredEfforts,
				supportedEfforts(ctx.model as Model<Api>),
			);
			if (
				(!choice.effort && efforts.length > 0) ||
				(choice.effort !== undefined && efforts.includes(choice.effort))
			) {
				selectedCandidate = {
					modelId: sessionId,
					model: ctx.model as Model<Api>,
					apiKey: auth.apiKey,
					headers: auth.headers,
					supportedEfforts: efforts,
				};
				selectedSource = "session";
			}
		}
	}

	if (!selectedCandidate) {
		const errors = choice.effort
			? [
					error(
						"explicit-effort-unsupported",
						`Effort ${choice.effort} is unsupported by the selected model candidates`,
						choice,
					),
				]
			: [
					error(
						"no-model-available",
						`No authenticated model is available for role ${opts.role}`,
					),
				];
		return { ...base, selected: null, errors };
	}

	const effort = choice.effort ?? selectedCandidate.supportedEfforts[0];
	const selected: ResolvedRoleModelFull = {
		role: opts.role,
		modelId: selectedCandidate.modelId,
		model: selectedCandidate.model,
		apiKey: selectedCandidate.apiKey,
		headers: selectedCandidate.headers,
		effort,
		source: selectedSource,
		profile: pool?.profile,
		configuredModels,
		candidates,
		allowedEfforts: selectedCandidate.supportedEfforts,
		provenance: pool?.provenance ?? {},
		validationErrors: [],
	};
	return { ...base, selected, errors: [] };
}

// ─── Deprecated compatibility facade ───────────────────────────────────────

export interface RoleResolveOptions {
	extension: string;
	role: string;
	tier?: Tier;
	explicit?: { model?: string; effort?: ThinkingLevel };
	env?: { model?: string; effort?: ThinkingLevel };
	requireApiKey?: boolean;
}

export function validateRoleModelConfig(
	raw: Record<string, unknown>,
): RoleModelConfig | undefined {
	const model =
		typeof raw.model === "string" && parseModelSpec(raw.model)
			? raw.model
			: undefined;
	const effort =
		typeof raw.effort === "string" && EFFORT_SET.has(raw.effort)
			? (raw.effort as ThinkingLevel)
			: undefined;
	return model || effort ? { model, effort } : undefined;
}

function readRoleConfig(
	merged: ExtensionConfigMap,
	extension: string,
	role: string,
): RoleModelConfig | undefined {
	const raw = getConfigObject(merged, extension, `models.${role}`);
	return raw ? validateRoleModelConfig(raw) : undefined;
}

const TIER_ROLE: Record<Tier, ModelRole> = {
	plan: "worker",
	work: "worker",
	review: "reviewer",
	fast: "research",
};

/**
 * Existing extension callers retain scalar explicit/env/config behavior. Calls
 * using a curated role directly get strict pool validation.
 */
export async function resolveRoleModel(
	ctx: ExtensionContext,
	opts: RoleResolveOptions,
): Promise<ResolvedRoleModelFull | null> {
	const directRole = ROLE_SET.has(opts.role)
		? (opts.role as ModelRole)
		: undefined;
	if (directRole) {
		const choice = opts.explicit ?? opts.env;
		return (
			await resolveRolePool(ctx, {
				role: directRole,
				choice,
				requireApiKey: opts.requireApiKey,
			})
		).selected;
	}

	const role = TIER_ROLE[opts.tier ?? "work"];
	const { merged } = readLayeredExtensionConfig(ctx.cwd);
	const scalar = readRoleConfig(merged, opts.extension, opts.role);
	const source = opts.explicit?.model
		? "explicit"
		: opts.env?.model
			? "env"
			: scalar?.model
				? "role-config"
				: undefined;
	const authored = opts.explicit ?? opts.env ?? scalar;
	if (authored?.model) {
		const auth = await authenticate(ctx, authored.model, opts.requireApiKey);
		if (auth) {
			const supported = supportedEfforts(auth.model);
			return {
				role,
				modelId: authored.model,
				...auth,
				effort: authored.effort,
				source: source ?? "role-config",
				tier: opts.tier,
				configuredModels: [authored.model],
				candidates: [{ modelId: authored.model, supportedEfforts: supported }],
				allowedEfforts: supported,
				provenance: {},
				validationErrors: [],
			};
		}
	}
	const resolved = await resolveRolePool(ctx, {
		role,
		requireApiKey: opts.requireApiKey,
	});
	return resolved.selected
		? {
				...resolved.selected,
				effort: authored?.effort ?? resolved.selected.effort,
				tier: opts.tier,
			}
		: null;
}

/** @deprecated Direct tier facade retained until spawn callers migrate. */
export async function resolveTierModel(
	ctx: ExtensionContext,
	tier: Tier,
	opts?: { effort?: ThinkingLevel; requireApiKey?: boolean },
): Promise<ResolvedRoleModelFull | null> {
	if (tier === "plan") {
		if (!ctx.model) return null;
		const id = modelId(ctx)!;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || (opts?.requireApiKey && !auth.apiKey)) return null;
		const efforts = supportedEfforts(ctx.model as Model<Api>);
		return {
			role: "worker",
			modelId: id,
			model: ctx.model as Model<Api>,
			apiKey: auth.apiKey,
			headers: auth.headers,
			effort: opts?.effort,
			source: "session",
			configuredModels: [],
			candidates: [{ modelId: id, supportedEfforts: efforts }],
			allowedEfforts: efforts,
			provenance: {},
			validationErrors: [],
		};
	}
	const selected = (
		await resolveRolePool(ctx, {
			role: TIER_ROLE[tier],
			choice: opts?.effort ? { effort: opts.effort } : undefined,
			requireApiKey: opts?.requireApiKey,
		})
	).selected;
	return selected ? { ...selected, tier } : null;
}

export async function resolveRoleModelWithin(
	ctx: ExtensionContext,
	opts: RoleResolveOptions,
	timeoutMs: number,
): Promise<ResolvedRoleModelFull | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([resolveRoleModel(ctx, opts), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
