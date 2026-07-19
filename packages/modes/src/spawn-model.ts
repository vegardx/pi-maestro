// Spawn-time exact model selection for non-workflow internal operations.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRole, ThinkingLevel } from "@vegardx/pi-contracts";
import {
	type AuthenticatedExactModelSelection,
	resolveExactModelSelection,
} from "@vegardx/pi-models";

export interface SpawnModelRequest {
	role: ModelRole;
	model?: string;
	effort?: ThinkingLevel;
	requireApiKey?: boolean;
}

export interface ResolvedSpawnModel {
	modelId: string;
	effort?: ThinkingLevel;
	apiKey?: string;
	headers?: Record<string, string>;
	resolved: AuthenticatedExactModelSelection;
}

export class SpawnModelResolutionError extends Error {
	constructor(
		readonly request: SpawnModelRequest,
		readonly reasons: readonly string[],
	) {
		super(
			`No exact ${request.role} model resolved: ${reasons.join("; ") || "no model available"}`,
		);
		this.name = "SpawnModelResolutionError";
	}
}

export async function resolveSpawnModel(
	ctx: ExtensionContext,
	request: SpawnModelRequest,
): Promise<ResolvedSpawnModel> {
	const initial = await resolveExactModelSelection(ctx, {
		role: request.role,
		requireApiKey: request.requireApiKey,
	});
	let selected = initial.selected;
	if (selected && (request.model || request.effort)) {
		const candidate = initial.candidates.find(
			(fact) =>
				fact.available &&
				(!request.model || fact.modelId === request.model) &&
				(!request.effort || fact.effort === request.effort),
		);
		if (!candidate?.modelId) selected = null;
		else {
			const exact = await resolveExactModelSelection(ctx, {
				role: request.role,
				requireApiKey: request.requireApiKey,
				assignment: {
					presetId: initial.presetId ?? "session",
					modelSetId: initial.modelSetId ?? "session",
					optionId: candidate.optionId,
					modelId: candidate.modelId,
					// "auto" options carry no fixed effort — resolution picks it.
					effort: candidate.effort === "auto" ? undefined : candidate.effort,
				},
			});
			selected = exact.selected;
		}
	}
	if (!selected) {
		throw new SpawnModelResolutionError(
			request,
			initial.errors
				.map((error) => error.message)
				.concat(
					request.model || request.effort
						? [
								`No configured option matches ${request.model ?? "default model"} @ ${request.effort ?? "default effort"}`,
							]
						: [],
				),
		);
	}
	return {
		modelId: selected.modelId,
		effort: selected.effort,
		apiKey: selected.apiKey,
		headers: selected.headers,
		resolved: selected,
	};
}

/** Resolve with a hard 5s timeout while preserving visible policy failures. */
export async function resolveSpawnModelSafe(
	ctx: ExtensionContext,
	request: SpawnModelRequest,
): Promise<ResolvedSpawnModel> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new SpawnModelResolutionError(request, [
						"resolution timed out after 5s",
					]),
				),
			5_000,
		);
		timer.unref?.();
	});
	try {
		return await Promise.race([resolveSpawnModel(ctx, request), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
