// @vegardx/pi-smart-compact — work-continuity compaction.
//
// Replaces pi's default auto-compaction summary with a single context-aware
// LLM call that identifies the work in progress and writes a summary
// optimised for continuing it, rather than a neutral chronological recap.
//
// Cooperation: modes claims compactions it wants to own by prefixing the
// custom instructions with the shared marker (see @vegardx/pi-contracts).
// When we see that marker we decline (return undefined) so modes' own
// handler — which runs after us — produces the summary instead.
//
// Safety: any failure (no model/auth, empty summary, timeout, throw) falls
// back to pi's default compaction by returning undefined, so a session is
// never blocked on this extension.

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { isMaestroOwnedCompaction } from "@vegardx/pi-contracts";
import { defineExtension, redactSecrets } from "@vegardx/pi-core";
import { resolveModelWithin } from "@vegardx/pi-models";
import { assembleSummary, buildFileSections, buildPrompt } from "./prompt.js";
import { readSmartCompactSettings } from "./settings.js";

export {
	assembleSummary,
	buildFileSections,
	buildPrompt,
	escapeClosingTag,
} from "./prompt.js";
export {
	readSmartCompactSettings,
	type SmartCompactSettings,
} from "./settings.js";

/** Abort the work when either pi's signal fires or our own timeout elapses. */
function withTimeout(
	parent: AbortSignal,
	timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (parent.aborted) controller.abort();
	else parent.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent.removeEventListener("abort", onAbort);
		},
	};
}

export default defineExtension(
	{
		name: "smart-compact",
		path: "packages/smart-compact/src/index.ts",
		doc: "Replaces default compaction with a work-focused summary optimised for continuing the active task.",
	},
	(pi) => {
		// In-flight guard for the proactive compactAt trigger (see turn_end).
		let compacting = false;
		// Notify at most once per session per failure class so a missing model
		// or repeated timeout doesn't spam the UI.
		const notifiedOnce = new Set<string>();
		const notifyOnce = (
			ctx: ExtensionContext,
			key: string,
			message: string,
			level: "warning" | "error",
		) => {
			if (notifiedOnce.has(key)) return;
			notifiedOnce.add(key);
			ctx.ui.notify(message, level);
		};

		pi.on("session_start", () => {
			notifiedOnce.clear();
			compacting = false;
		});

		pi.on("session_before_compact", async (event, ctx) => {
			// Decline modes-owned compactions: modes' handler (registered after
			// ours) will produce the summary. Returning undefined leaves our
			// `result` slot untouched so the later handler wins.
			if (isMaestroOwnedCompaction(event.customInstructions)) return;

			const { preparation, signal, customInstructions } = event;
			const {
				messagesToSummarize,
				turnPrefixMessages,
				tokensBefore,
				firstKeptEntryId,
				previousSummary,
				fileOps,
			} = preparation;

			const settings = readSmartCompactSettings(ctx.cwd);

			const resolved = await resolveModelWithin(
				ctx,
				{ name: "smart-compact", tier: "normal", requireApiKey: true },
				settings.timeoutMs,
			);
			if (!resolved?.apiKey) {
				notifyOnce(
					ctx,
					"no-model",
					"smart-compact: no model/auth available, using default compaction",
					"warning",
				);
				return;
			}

			const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
			if (allMessages.length === 0) return; // nothing to summarise

			const conversationText = serializeConversation(convertToLlm(allMessages));
			const prompt = buildPrompt(
				conversationText,
				fileOps,
				previousSummary,
				customInstructions,
			);

			const { signal: callSignal, dispose } = withTimeout(
				signal,
				settings.timeoutMs,
			);
			try {
				const response = await complete(
					resolved.model,
					{
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: prompt }],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: resolved.apiKey,
						headers: resolved.headers,
						maxTokens: settings.maxSummaryTokens,
						signal: callSignal,
					},
				);

				const summary = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();

				if (!summary) {
					if (!callSignal.aborted) {
						notifyOnce(
							ctx,
							"empty",
							"smart-compact: empty summary returned, using default compaction",
							"warning",
						);
					}
					return;
				}

				// Build the new section from this slice, redact it, then reuse the
				// previous summary byte-for-byte as the prefix so the compaction
				// summary stays cache-stable (append-only) across compactions.
				const newSection = redactSecrets(
					summary + buildFileSections(fileOps, settings.maxFileListEntries),
				);
				const fullSummary = assembleSummary(newSection, previousSummary);

				return {
					compaction: { summary: fullSummary, firstKeptEntryId, tokensBefore },
				};
			} catch (error) {
				if (!callSignal.aborted) {
					const message =
						error instanceof Error ? error.message : String(error);
					notifyOnce(
						ctx,
						"failed",
						`smart-compact: failed (${message}), using default compaction`,
						"error",
					);
				}
				return; // fall back to default
			} finally {
				dispose();
			}
		});

		// Proactive trigger: read compactAt every turn so project settings take
		// effect live. Unset by default — relies on pi's native threshold. An
		// in-flight guard prevents stacking concurrent compactions if turn_end
		// fires again before the previous compaction settles.
		pi.on("turn_end", (_event, ctx) => {
			if (compacting) return;
			const { compactAt } = readSmartCompactSettings(ctx.cwd);
			if (compactAt === undefined) return;
			const usage = ctx.getContextUsage();
			if (!usage || usage.tokens === null) return;
			if (usage.tokens < compactAt) return;
			compacting = true;
			ctx.compact({
				onComplete: () => {
					compacting = false;
				},
				onError: () => {
					compacting = false;
				},
			});
		});
	},
);
