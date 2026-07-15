// Delegate role policy presentation and exact-choice resolution.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@vegardx/pi-contracts";
import { resolveRolePool, resolveSentinelPool } from "@vegardx/pi-models";
import { readLayeredExtensionConfig } from "@vegardx/pi-settings";

export interface CatalogEntry {
	readonly model: string;
	readonly note?: string;
}

/** An allowed delegate model with policy order and registry-derived facts. */
export interface DelegableModel {
	readonly id: string;
	readonly note?: string;
	readonly facts: string;
	readonly efforts: readonly ThinkingLevel[];
	readonly default: boolean;
	readonly available: boolean;
}

export interface DelegateSelection {
	readonly model: string;
	readonly effort?: ThinkingLevel;
	readonly models: readonly DelegableModel[];
	readonly allowedEfforts: readonly ThinkingLevel[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Optional notes remain presentation-only; they never widen role policy. */
export function readCatalog(cwd: string): CatalogEntry[] {
	try {
		const { merged } = readLayeredExtensionConfig(cwd);
		const modes = merged.modes;
		const raw = isPlainObject(modes) ? modes.catalog : undefined;
		if (!Array.isArray(raw)) return [];
		return raw.flatMap((item) =>
			isPlainObject(item) && typeof item.model === "string"
				? [
						{
							model: item.model,
							...(typeof item.note === "string" ? { note: item.note } : {}),
						},
					]
				: [],
		);
	} catch {
		return [];
	}
}

function modelFacts(ctx: ExtensionContext, id: string): string {
	const [provider, ...rest] = id.split("/");
	const model = ctx.modelRegistry.find(provider, rest.join("/")) as
		| {
				contextWindow?: number;
				compat?: { forceAdaptiveThinking?: boolean };
				reasoning?: boolean;
		  }
		| undefined;
	if (!model) return "not in registry";
	const parts: string[] = [];
	if (model.contextWindow)
		parts.push(`${Math.round(model.contextWindow / 1000)}k ctx`);
	if (model.compat?.forceAdaptiveThinking) parts.push("adaptive");
	else if (model.reasoning === false) parts.push("no thinking");
	else parts.push("fixed thinking");
	return parts.join(" · ");
}

export async function resolveDelegateSelection(
	ctx: ExtensionContext,
	choice?: { model?: string; effort?: ThinkingLevel },
): Promise<DelegateSelection> {
	const resolution = await resolveRolePool(ctx, {
		role: "delegate",
		choice,
	});
	const selected = resolution.selected;
	if (!selected) {
		throw new Error(
			`No policy-compatible delegate model resolved: ${resolution.errors.map((item) => item.message).join("; ") || "no model available"}`,
		);
	}
	const notes = new Map(
		readCatalog(ctx.cwd).map((entry) => [entry.model, entry.note]),
	);
	const candidateById = new Map(
		resolution.candidates.map((candidate) => [candidate.modelId, candidate]),
	);
	// Spawners must see concrete model ids: the "session" pool sentinel is
	// rendered resolved (deduplicated against explicit pool entries).
	const ids =
		resolution.configuredModels.length > 0
			? resolveSentinelPool(ctx, resolution.configuredModels)
			: [selected.modelId];
	const models = ids.map((id, index) => {
		const candidate = candidateById.get(id);
		return {
			id,
			...(notes.get(id) ? { note: notes.get(id) } : {}),
			facts: modelFacts(ctx, id),
			efforts: candidate?.supportedEfforts ?? [],
			default: index === 0,
			available: Boolean(candidate) || id === selected.modelId,
		};
	});
	return {
		model: selected.modelId,
		effort: selected.effort,
		models,
		allowedEfforts: resolution.allowedEfforts,
	};
}
