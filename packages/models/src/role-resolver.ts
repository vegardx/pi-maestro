// Role-pool model resolution. Runtime consumers resolve curated roles directly.

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ModelRole,
	ResolvedRoleCandidate,
	ResolvedRoleModel,
	RolePoolSource,
	RoleResolutionError,
	ThinkingLevel,
} from "@vegardx/pi-contracts";
import { parseModelSpec } from "./model-spec.js";
import { effectiveRolePool, readModelsConfig } from "./profiles.js";

const EFFORTS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];
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
		if (
			choice.effort === undefined &&
			configuredEfforts.length > 0 &&
			selectedCandidate.supportedEfforts.length === 0
		) {
			const errors = [
				error(
					"explicit-effort-unsupported",
					`Model ${choice.model} supports none of the allowed ${opts.role} efforts`,
					choice,
				),
			];
			return { ...base, selected: null, errors };
		}
		if (
			choice.effort !== undefined &&
			!selectedCandidate.supportedEfforts.includes(choice.effort)
		) {
			const errors = [
				error(
					"explicit-effort-unsupported",
					`Effort ${choice.effort} is unsupported by model ${choice.model}`,
					choice,
				),
			];
			return { ...base, selected: null, errors };
		}
	} else {
		selectedCandidate = candidates.find(
			(item) =>
				(!choice.effort &&
					(configuredEfforts.length === 0 ||
						item.supportedEfforts.length > 0)) ||
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
				(!choice.effort &&
					(configuredEfforts.length === 0 || efforts.length > 0)) ||
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

	const effort =
		choice.effort ??
		(configuredEfforts.length > 0
			? selectedCandidate.supportedEfforts[0]
			: undefined);
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

export async function resolveRolePoolWithin(
	ctx: ExtensionContext,
	opts: RolePoolResolveOptions,
	timeoutMs: number,
): Promise<RolePoolResolution> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<RolePoolResolution>((resolve) => {
		timer = setTimeout(
			() =>
				resolve({
					role: opts.role,
					configuredModels: [],
					candidates: [],
					allowedEfforts: [],
					provenance: {},
					selected: null,
					errors: [
						{
							code: "no-model-available",
							message: `${opts.role} model resolution timed out after ${timeoutMs}ms`,
						},
					],
				}),
			timeoutMs,
		);
		timer.unref?.();
	});
	try {
		return await Promise.race([resolveRolePool(ctx, opts), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
