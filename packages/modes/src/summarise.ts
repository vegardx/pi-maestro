// Modes-local summariser: wires the plan-summarizer role default + pi-ai's
// `complete` into the pure `SummariseFn` the compaction builder consumes.
//
// Soft-failing by contract: returns null on no model/auth, abort, empty
// output, or any runtime error. The caller cancels only the modes-triggered
// compaction on null and lets native/smart compaction handle future overflows.

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { resolveExactModelSelection } from "@vegardx/pi-models";
import type { SummariseFn } from "./compaction.js";

/** Abort the call when pi's signal fires OR our own timeout elapses. */
function withTimeout(
	parent: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (parent?.aborted) controller.abort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}

/**
 * Build a {@link SummariseFn} bound to `ctx`. Resolves the plan-summarizer
 * policy default once per call so project settings take effect live.
 */
export function createModesSummariser(
	ctx: ExtensionContext,
	timeoutMs: number,
): SummariseFn {
	return async ({ messages, preamble, maxTokens, signal }) => {
		const resolution = await resolveExactModelSelection(ctx, {
			role: "plan-summarizer",
			requireApiKey: true,
		});
		const resolved = resolution.selected;
		if (!resolved?.apiKey) return null;
		if (messages.length === 0) return null;

		const conversationText = serializeConversation(convertToLlm(messages));
		const promptText = `${preamble}\n\n<conversation>\n${conversationText}\n</conversation>`;

		const { signal: callSignal, dispose } = withTimeout(signal, timeoutMs);
		try {
			const response = await complete(
				resolved.model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: promptText }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: resolved.apiKey,
					headers: resolved.headers,
					maxTokens,
					signal: callSignal,
				},
			);
			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();
			if (!text) return null;
			return { text };
		} catch {
			return null;
		} finally {
			dispose();
		}
	};
}
