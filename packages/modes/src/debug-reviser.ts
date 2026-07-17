import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveExactModelSelection } from "@vegardx/pi-models";
import type {
	DebugIssueReviser,
	DebugIssueReviserInput,
} from "./debug-issue.js";

function extractJson(text: string): unknown {
	const trimmed = text.trim();
	const candidate = trimmed.startsWith("```")
		? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
		: trimmed;
	return JSON.parse(candidate);
}

/** The prompt deliberately contains no transcript, environment, or source. */
export function buildDebugIssueRevisionPrompt(
	input: DebugIssueReviserInput,
): string {
	return [
		"You revise a structured pi-maestro diagnostic issue.",
		"Return ONLY one complete JSON object with the same schema as currentDraft.",
		"You may edit only currentDraft.model. Copy currentDraft.mechanical byte-for-byte.",
		"Do not add keys, attachments, raw transcripts, environments, source trees, or logs.",
		"Do not invent observed facts. Use only frozenEvidence.",
		"Every required model section must remain non-empty.",
		"",
		`Revision instruction:\n${input.instruction}`,
		"",
		`Current structured draft:\n${JSON.stringify(input.currentDraft)}`,
		"",
		`Frozen bounded evidence and recovery result:\n${JSON.stringify(input.frozenEvidence)}`,
	].join("\n");
}

export function createDebugIssueReviser(
	ctx: ExtensionContext,
): DebugIssueReviser {
	return {
		async revise(input) {
			const resolution = await resolveExactModelSelection(ctx, {
				role: "plan-summarizer",
				requireApiKey: true,
			});
			const resolved = resolution.selected;
			if (!resolved?.apiKey)
				throw new Error("No model is available for issue revision");
			const response = await complete(
				resolved.model,
				{
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: buildDebugIssueRevisionPrompt(input),
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: resolved.apiKey,
					headers: resolved.headers,
					maxTokens: 4_096,
				},
			);
			const text = response.content
				.filter(
					(part): part is { type: "text"; text: string } =>
						part.type === "text",
				)
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (!text) throw new Error("Issue reviser returned an empty response");
			return extractJson(text);
		},
	};
}
