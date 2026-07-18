// Planning-time exact model-set selection.

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	AgentKind,
	AgentRuntimePolicy,
	ExactModelCandidateFact,
	ExactModelOption,
	ExactModelSelection,
	ModelRole,
	ModelSelectionError,
	ModelsConfig,
	ResolvedAgentAssignment,
	ThinkingLevel,
} from "@vegardx/pi-contracts";
import { supportedEfforts } from "./efforts.js";
import { parseModelSpec } from "./model-spec.js";
import {
	activePreset,
	readModelsConfig,
	SESSION_MODEL_SENTINEL,
} from "./profiles.js";

export interface PersistedExactAssignment {
	readonly presetId: string;
	readonly modelSetId: string;
	readonly optionId: string;
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
}

export interface ExactSelectionOptions {
	readonly role: ModelRole;
	/** A persisted assignment is exact. It is validated and never substituted. */
	readonly assignment?: PersistedExactAssignment;
	readonly requireApiKey?: boolean;
}

export interface AuthenticatedExactModelSelection extends ExactModelSelection {
	readonly model: Model<Api>;
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
}

export interface ExactSelectionResolution {
	readonly presetId?: string;
	readonly modelSetId?: string;
	readonly candidates: readonly ExactModelCandidateFact[];
	readonly selected: AuthenticatedExactModelSelection | null;
	readonly errors: readonly ModelSelectionError[];
}

interface CheckedOption {
	readonly fact: ExactModelCandidateFact;
	readonly option: ExactModelOption;
	readonly model?: Model<Api>;
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
}

function sessionModelId(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function selectionError(
	code: ModelSelectionError["code"],
	message: string,
	ids: Partial<
		Pick<ModelSelectionError, "presetId" | "modelSetId" | "optionId">
	> = {},
): ModelSelectionError {
	return { code, message, ...ids };
}

async function checkOption(
	ctx: ExtensionContext,
	option: ExactModelOption,
	requireApiKey: boolean,
): Promise<CheckedOption> {
	const authoredModel = option.model;
	const modelId =
		authoredModel === SESSION_MODEL_SENTINEL
			? sessionModelId(ctx)
			: authoredModel;
	let model: Model<Api> | undefined;
	if (authoredModel === SESSION_MODEL_SENTINEL) {
		model = ctx.model as Model<Api> | undefined;
	} else {
		const parsed = parseModelSpec(authoredModel);
		model = parsed
			? ctx.modelRegistry.find(parsed.provider, parsed.modelId)
			: undefined;
	}
	let authenticated = false;
	let apiKey: string | undefined;
	let headers: Record<string, string> | undefined;
	if (model) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) {
			authenticated = !requireApiKey || Boolean(auth.apiKey);
			if (authenticated) {
				apiKey = auth.apiKey;
				headers = auth.headers;
			}
		}
	}
	const effortSupported = Boolean(
		model && supportedEfforts(model).includes(option.effort),
	);
	const registered = Boolean(model);
	const available = Boolean(
		modelId && registered && authenticated && effortSupported,
	);
	const reason = !modelId
		? "no live session model"
		: !registered
			? "not in registry"
			: !authenticated
				? "not authenticated"
				: !effortSupported
					? `effort ${option.effort} is unsupported`
					: undefined;
	return {
		option,
		fact: {
			optionId: option.id,
			authoredModel,
			...(modelId ? { modelId } : {}),
			effort: option.effort,
			summary: option.summary,
			registered,
			authenticated,
			effortSupported,
			available,
			...(reason ? { reason } : {}),
		},
		model,
		apiKey,
		headers,
	};
}

function dedupeConcretePairs(
	options: readonly CheckedOption[],
): CheckedOption[] {
	const seen = new Set<string>();
	return options.filter((checked) => {
		const modelId = checked.fact.modelId;
		if (!modelId) return true;
		const key = JSON.stringify([modelId, checked.option.effort]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * The default (unassigned) pick prefers a concrete option over the `session`
 * sentinel: within a set the session model is the *fallback*, not a front-runner,
 * so a review pool can list `session` among real alternatives and only land on it
 * when nothing else is available. Authored order is preserved within each group,
 * so among concretes the first available still wins.
 */
function firstAvailableOption(
	checked: readonly CheckedOption[],
): CheckedOption | undefined {
	const isSession = (candidate: CheckedOption) =>
		candidate.fact.authoredModel === SESSION_MODEL_SENTINEL;
	return (
		checked.find(
			(candidate) => candidate.fact.available && !isSession(candidate),
		) ??
		checked.find(
			(candidate) => candidate.fact.available && isSession(candidate),
		)
	);
}

function builtInSessionOption(role: ModelRole): ExactModelOption {
	return {
		id: "session",
		model: SESSION_MODEL_SENTINEL,
		effort: "medium",
		summary: `${role} · current session model`,
	};
}

/**
 * Resolve deterministic candidate facts and one exact planning-time selection.
 * Configured sets never gain an implicit session fallback. An absent preset/set
 * uses one built-in session option so unconfigured installations keep working.
 */
export async function resolveExactModelSelection(
	ctx: ExtensionContext,
	opts: ExactSelectionOptions,
): Promise<ExactSelectionResolution> {
	let config: ModelsConfig | undefined;
	try {
		config = readModelsConfig(ctx.cwd);
	} catch (cause) {
		return {
			candidates: [],
			selected: null,
			errors: [
				selectionError(
					"overlapping-preset-target",
					cause instanceof Error ? cause.message : String(cause),
				),
			],
		};
	}
	const active = activePreset(config, sessionModelId(ctx));
	const configuredSetId = active?.preset.modelSets[opts.role];
	const set = configuredSetId ? config?.modelSets[configuredSetId] : undefined;
	const fallback = !active || !configuredSetId;
	const presetId = active?.id ?? "session";
	const modelSetId = configuredSetId ?? "session";

	if (configuredSetId && !set) {
		return {
			presetId,
			modelSetId,
			candidates: [],
			selected: null,
			errors: [
				selectionError(
					"model-set-not-found",
					`Preset ${presetId} references unknown model set ${modelSetId}`,
					{ presetId, modelSetId },
				),
			],
		};
	}

	if (opts.assignment) {
		const exact = opts.assignment;
		if (exact.presetId !== presetId || exact.modelSetId !== modelSetId) {
			return {
				presetId,
				modelSetId,
				candidates: [],
				selected: null,
				errors: [
					selectionError(
						"explicit-assignment-mismatch",
						`Persisted assignment ${exact.presetId}/${exact.modelSetId} does not match active ${presetId}/${modelSetId}`,
						{
							presetId: exact.presetId,
							modelSetId: exact.modelSetId,
							optionId: exact.optionId,
						},
					),
				],
			};
		}
	}

	const options = set?.options ?? [builtInSessionOption(opts.role)];
	const checked = dedupeConcretePairs(
		await Promise.all(
			options.map((option) =>
				checkOption(ctx, option, opts.requireApiKey ?? false),
			),
		),
	);
	const candidates = checked.map((candidate) => candidate.fact);
	let chosen: CheckedOption | undefined;
	if (opts.assignment) {
		chosen = checked.find(
			(candidate) => candidate.option.id === opts.assignment?.optionId,
		);
		if (!chosen) {
			return {
				presetId,
				modelSetId,
				candidates,
				selected: null,
				errors: [
					selectionError(
						"explicit-option-not-found",
						`Persisted option ${opts.assignment.optionId} is not in model set ${modelSetId}`,
						{ presetId, modelSetId, optionId: opts.assignment.optionId },
					),
				],
			};
		}
		if (
			chosen.fact.modelId !== opts.assignment.modelId ||
			(opts.assignment.effort !== undefined &&
				chosen.option.effort !== opts.assignment.effort)
		) {
			return {
				presetId,
				modelSetId,
				candidates,
				selected: null,
				errors: [
					selectionError(
						"explicit-assignment-mismatch",
						`Persisted assignment no longer matches option ${opts.assignment.optionId}`,
						{ presetId, modelSetId, optionId: opts.assignment.optionId },
					),
				],
			};
		}
	} else {
		chosen = firstAvailableOption(checked);
	}

	if (!chosen?.fact.available || !chosen.model || !chosen.fact.modelId) {
		const explicit = Boolean(opts.assignment);
		const optionId = opts.assignment?.optionId ?? chosen?.option.id;
		return {
			presetId,
			modelSetId,
			candidates,
			selected: null,
			errors: [
				selectionError(
					explicit
						? "explicit-option-unavailable"
						: fallback && !ctx.model
							? "no-session-model"
							: "no-model-available",
					explicit
						? `Persisted option ${optionId} is unavailable and will not be substituted`
						: `No compatible option is available in model set ${modelSetId}`,
					{ presetId, modelSetId, ...(optionId ? { optionId } : {}) },
				),
			],
		};
	}

	return {
		presetId,
		modelSetId,
		candidates,
		selected: {
			presetId,
			modelSetId,
			optionId: chosen.option.id,
			modelId: chosen.fact.modelId,
			effort: chosen.option.effort,
			summary: chosen.option.summary,
			source: opts.assignment ? "explicit" : fallback ? "session" : "preset",
			candidates,
			model: chosen.model,
			apiKey: chosen.apiKey,
			headers: chosen.headers,
		},
		errors: [],
	};
}

export interface AssignmentSelectionOptions extends ExactSelectionOptions {
	readonly agentId: string;
	readonly kind: AgentKind;
	readonly runtime: AgentRuntimePolicy;
	readonly focus: string;
	readonly rationale: string;
	readonly inputContracts: readonly string[];
	readonly outputContracts: readonly string[];
	readonly now?: () => Date;
}

/** Persistable immutable assignment builder for planning/execution handoff. */
export async function resolveAgentAssignment(
	ctx: ExtensionContext,
	opts: AssignmentSelectionOptions,
): Promise<
	| {
			readonly assignment: ResolvedAgentAssignment;
			readonly selection: AuthenticatedExactModelSelection;
	  }
	| {
			readonly assignment: null;
			readonly errors: readonly ModelSelectionError[];
	  }
> {
	const resolution = await resolveExactModelSelection(ctx, opts);
	if (!resolution.selected)
		return { assignment: null, errors: resolution.errors };
	const selected = resolution.selected;
	const resolvedAt = (opts.now?.() ?? new Date()).toISOString();
	return {
		assignment: {
			agentId: opts.agentId,
			kind: opts.kind,
			presetId: selected.presetId,
			modelSetId: selected.modelSetId,
			optionId: selected.optionId,
			modelId: selected.modelId,
			effort: selected.effort,
			runtime: opts.runtime,
			focus: opts.focus,
			rationale: opts.rationale,
			inputContracts: opts.inputContracts,
			outputContracts: opts.outputContracts,
			provenance: {
				source: selected.source,
				presetId: selected.presetId,
				modelSetId: selected.modelSetId,
				optionId: selected.optionId,
				resolvedAt,
			},
			resolvedAt,
			source: selected.source,
		},
		selection: selected,
	};
}
