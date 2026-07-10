// Model catalog for the general delegate: a whitelist of delegable models,
// each carrying selection guidance so the maestro picks informed, not blind.
// Notes are user opinion (extensionConfig.modes.catalog); facts (context
// window, adaptive thinking) are derived fresh from the model registry so
// they never go stale. Profile targets and pinned tier models are implicitly
// whitelisted — they are already trusted and authed.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@vegardx/pi-contracts";
import { readModelsConfig, resolveTierConfig } from "@vegardx/pi-models";
import { readLayeredExtensionConfig } from "@vegardx/pi-settings";

export interface CatalogEntry {
	readonly model: string;
	readonly note?: string;
}

/** A whitelisted model with merged guidance for the delegate tool. */
export interface DelegableModel {
	readonly id: string;
	/** User-authored guidance (what it's good at / when to avoid). */
	readonly note?: string;
	/** Registry-derived facts: "200k ctx · adaptive" (or "not in registry"). */
	readonly facts: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** User-authored catalog entries from extensionConfig.modes.catalog. */
export function readCatalog(cwd: string): CatalogEntry[] {
	try {
		const { merged } = readLayeredExtensionConfig(cwd);
		const modes = merged.modes;
		const raw = isPlainObject(modes) ? modes.catalog : undefined;
		if (!Array.isArray(raw)) return [];
		const entries: CatalogEntry[] = [];
		for (const item of raw) {
			if (!isPlainObject(item) || typeof item.model !== "string") continue;
			entries.push({
				model: item.model,
				...(typeof item.note === "string" ? { note: item.note } : {}),
			});
		}
		return entries;
	} catch {
		return [];
	}
}

function modelFacts(ctx: ExtensionContext, id: string): string {
	if (!id.includes("/")) return "not in registry";
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

/**
 * The delegable-model whitelist: user catalog entries first (they carry the
 * guidance), then profile targets and pinned tier models (implicitly
 * trusted), deduped in that order.
 */
export function delegableModels(
	ctx: ExtensionContext,
	cwd: string,
): DelegableModel[] {
	const seen = new Map<string, string | undefined>();
	for (const entry of readCatalog(cwd)) {
		if (!seen.has(entry.model)) seen.set(entry.model, entry.note);
	}
	const cfg = readModelsConfig(cwd);
	for (const profile of Object.values(cfg?.profiles ?? {})) {
		for (const target of profile.targets) {
			if (!seen.has(target)) seen.set(target, undefined);
		}
		for (const tier of ["work", "review", "fast"] as const) {
			const model = profile[tier]?.model;
			if (model && !seen.has(model)) seen.set(model, undefined);
		}
	}
	return [...seen].map(([id, note]) => ({
		id,
		...(note ? { note } : {}),
		facts: modelFacts(ctx, id),
	}));
}

/**
 * The general delegate's default spawn model: the WORK tier via the active
 * profile. When work tracks plan, returns {} — the child inherits the
 * default model with a warm cache.
 */
export function workTierDefault(
	ctx: ExtensionContext,
	cwd: string,
): { model?: string; effort?: ThinkingLevel } {
	const session = ctx.model
		? { modelId: `${ctx.model.provider}/${ctx.model.id}` }
		: undefined;
	const resolved = resolveTierConfig(readModelsConfig(cwd), "work", session);
	if (!resolved || resolved.tracksPlan) return {};
	return {
		model: resolved.modelId,
		...(resolved.effort ? { effort: resolved.effort } : {}),
	};
}
