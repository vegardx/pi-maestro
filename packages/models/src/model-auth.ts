// In-process model auth: resolve a "provider/model" id to a registered model
// plus its credentials, for harness callers that complete() directly instead
// of spawning a pi child (command-auditor verdicts, summarisers). Same
// registry surface exact-selection uses; null on anything missing — callers
// fail open to their deterministic behavior.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModelSpec } from "./model-spec.js";

export interface ResolvedModelAuth {
	readonly model: Model<Api>;
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
}

export async function resolveModelAuth(
	ctx: ExtensionContext,
	modelId: string,
): Promise<ResolvedModelAuth | null> {
	const parsed = parseModelSpec(modelId);
	const model = parsed
		? (ctx.modelRegistry.find(parsed.provider, parsed.modelId) as
				| Model<Api>
				| undefined)
		: undefined;
	if (!model) return null;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return null;
	return {
		model,
		apiKey: auth.apiKey,
		...(auth.headers ? { headers: auth.headers } : {}),
	};
}
