// Command-auditor, rung 2 of the ladder (deterministic fastpath → LLM
// verdict → human). It runs ONLY where the deterministic classifier is
// uncertain ("unknown" effects) and ONLY for child agents (the policy row's
// coarse depth scope): a fast-tier model reads the same enforced ruleset the
// agent was seeded with and issues a verdict. The rung can TIGHTEN a route to
// deny — it can never widen one: "allow" and "escalate" both defer to the
// deterministic route (isolation/confirm per settings), so a hallucinated
// blessing grants nothing. Fail-open on timeout/parse/auth-missing: the
// deterministic behavior stands, the hot path never hangs on a model.
//
// The prompt is harness-owned and ships with releases (design invariant 6:
// callers are tuned via policy rows only — tier via `tool:bash`.run.models).

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PolicyRow } from "@vegardx/pi-contracts";
import {
	type ResolvedModelAuth,
	resolveModelAuth,
	resolveV2Model,
} from "@vegardx/pi-models";
import {
	type BashActor,
	type BashEffect,
	renderBashRuleset,
} from "./bash-policy.js";

export interface CommandAuditInput {
	readonly command: string;
	readonly actor: BashActor;
	readonly mode: string;
	readonly effects: readonly BashEffect[];
}

export interface CommandAuditVerdict {
	readonly verdict: "allow" | "deny" | "escalate";
	readonly reason: string;
}

const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_TOKENS = 300;

/** The versioned rung-2 prompt. Judgment lives here, never in matchers. */
export function buildAuditorPrompt(input: CommandAuditInput): string {
	return [
		"You are the command auditor of an agent harness. A spawned agent",
		`(actor: ${input.actor}, mode: ${input.mode}) wants to run a shell`,
		"command the deterministic classifier could not place. Decide whether",
		"it clearly violates the enforced rules below or is clearly harmful to",
		"the host machine; otherwise let the harness's isolation handle it.",
		"",
		renderBashRuleset(input.actor),
		"",
		`Detected effects: ${input.effects.join(", ") || "none"}`,
		"Command:",
		"```",
		input.command,
		"```",
		"",
		"Reply with EXACTLY one JSON object, nothing else:",
		'{"verdict":"allow"|"deny"|"escalate","reason":"<one sentence>"}',
		"- deny: clear rule violation or clear harm (state which rule).",
		"- escalate: a human should look before this runs.",
		"- allow: no rule concern; normal work.",
	].join("\n");
}

/** Tolerant single-object JSON extraction; null on anything malformed. */
export function parseAuditorVerdict(text: string): CommandAuditVerdict | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const value = JSON.parse(text.slice(start, end + 1)) as {
			verdict?: unknown;
			reason?: unknown;
		};
		if (
			value.verdict !== "allow" &&
			value.verdict !== "deny" &&
			value.verdict !== "escalate"
		)
			return null;
		return {
			verdict: value.verdict,
			reason:
				typeof value.reason === "string" && value.reason.trim()
					? value.reason.trim()
					: "no reason given",
		};
	} catch {
		return null;
	}
}

export interface CommandAuditorDeps {
	/** Injectable completion seam (tests); defaults to pi-ai complete. */
	readonly completeFn?: typeof complete;
	/** Injectable tier→auth seam (tests); defaults to v2 resolver + registry. */
	readonly resolveAuth?: () => Promise<ResolvedModelAuth | null>;
	readonly timeoutMs?: number;
}

export type CommandAuditor = (
	input: CommandAuditInput,
) => Promise<CommandAuditVerdict | null>;

/**
 * Build the rung-2 auditor from its policy row: the row's tier resolves
 * through the v2 resolver (residency-filtered) to a concrete model + auth.
 * Every failure path returns null — the deterministic route stands.
 */
export function createCommandAuditor(
	ctx: ExtensionContext,
	row: PolicyRow,
	deps: CommandAuditorDeps = {},
): CommandAuditor {
	const completeFn = deps.completeFn ?? complete;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const resolveAuth =
		deps.resolveAuth ??
		(async () => {
			const resolved = await resolveV2Model(ctx, {
				agent: "explorer",
				tier: row.run.models,
			});
			return resolveModelAuth(ctx, resolved.modelId);
		});
	return async (input) => {
		try {
			const auth = await resolveAuth();
			if (!auth) return null;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			(timer as { unref?: () => void }).unref?.();
			try {
				const response = await completeFn(
					auth.model,
					{
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: buildAuditorPrompt(input) }],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: auth.apiKey,
						...(auth.headers ? { headers: auth.headers } : {}),
						maxTokens: MAX_TOKENS,
						signal: controller.signal,
					},
				);
				const text = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				return parseAuditorVerdict(text);
			} finally {
				clearTimeout(timer);
			}
		} catch {
			return null;
		}
	};
}
