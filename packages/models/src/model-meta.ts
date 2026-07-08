// Display metadata for a resolved model id — the short name and whether the
// model uses adaptive thinking. Resolved once at spawn time (where a live
// ExtensionContext / ModelRegistry is available) and stored on the run/agent
// view, so the pure telemetry renderers can show `A/<level>` without a ctx.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ModelMeta {
	/** Compact label for tables/cards, e.g. "fable-5", "opus-4-8". */
	readonly shortName: string;
	/**
	 * True when the model uses adaptive thinking (decides its own depth) rather
	 * than a fixed reasoning budget. Anthropic exposes this as
	 * `model.compat.forceAdaptiveThinking`; telemetry renders `A/<level>`.
	 */
	readonly adaptive: boolean;
}

/** Strip provider, the `claude-` prefix, and a trailing `-YYYYMMDD` date. */
export function shortModelName(modelId: string): string {
	const id = modelId.split("/").pop() ?? modelId;
	return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

interface RegistryLike {
	find?: (
		provider: string,
		id: string,
	) => { compat?: { forceAdaptiveThinking?: boolean } } | undefined;
}

/** Resolve display metadata for a `"provider/id"` model spec. */
export function getModelMeta(
	ctx: ExtensionContext,
	modelId: string,
): ModelMeta {
	const [provider, ...rest] = modelId.split("/");
	const id = rest.join("/");
	const registry = (ctx as unknown as { modelRegistry?: RegistryLike })
		.modelRegistry;
	const model = registry?.find?.(provider, id);
	return {
		shortName: shortModelName(modelId),
		adaptive: Boolean(model?.compat?.forceAdaptiveThinking),
	};
}
