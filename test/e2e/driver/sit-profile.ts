// A radicalai-sit gateway profile for the live e2e drive: real hosted models
// through gateway.sit.raicode.no, no provider extension required.
//
// The bundled radicalai provider extension needs a newer host pi than the CLI
// carries (readStoredCredential, pi >=0.80.8), so this profile does what the
// ollama profile does: generate a self-contained models.json against the
// gateway. Auth is the DRIVER'S OWN gateway credential (see gateway-auth.ts) —
// its own OAuth login, its own store, its own refresh cycle, never the
// developer's pi credential. The access token is written into the isolated
// home as a static provider key; the gateway accepts it on both `x-api-key`
// (anthropic-messages) and `Authorization: Bearer` (openai-responses).
//
// Tokens live ~1h and the key is baked into models.json at launch, so a drive
// running longer than the token's remaining life will still lose auth
// mid-flight. buildSitProfile() refreshes immediately before launch, which
// buys a full hour; a drive that needs more wants a refreshing local proxy
// (models.json has no key indirection to hook).
//
// v2 layout (families → rosters → bindings → allowances). Two ranked families
// are the diversity axis; a roster's three tiers hold the alias refs; a single
// default binding activates the roster for the opus seat; per-agent allowances
// route each agent type to a tier — reviewer defaults to `heavy` so a review
// lands on a DIFFERENT family than the sol workers (cross-family by
// construction, without leaning on the still-deferred diversity walk):
//   • session / planner  → claude-opus-4-8   (careful judge: the seat)
//   • standard (workers) → OpenAI/GPT 5.6 Sol → seat   (strongest implementer)
//   • light  (utility)   → OpenAI/GPT 5.6 Sol → seat   (explorer/classify)
//   • heavy  (reviewers) → Anthropic/Opus 4.8 → seat   (cross-family judge)

import { liveAccessToken } from "./gateway-auth.js";
import type { MultiModelProfile } from "./multi-model-profile.js";

const GATEWAY = "https://gateway.sit.raicode.no";
// Two providers because models.json api is per-provider and the gateway
// serves the two models over different protocols.
const P_ANTHROPIC = "sit-anthropic";
const P_OPENAI = "sit-openai";

const OPUS = `${P_ANTHROPIC}/claude-opus-4-8`;
const SOL = `${P_OPENAI}/gpt-5.6-sol`;
// The region tripwire: the ONLY functional SIT Fable, but US-data-share, so
// NON-EEA (reference-gateway-region-models). It leads the heavy tier; under the
// active EEA region it is struck and reviews fall to Opus (EEA-legal) — a live
// proof of the region hard-filter. Under Global it would resolve and serve.
const FABLE = `${P_ANTHROPIC}/us-n-virginia-data-share/anthropic.claude-fable-5`;

function buildModelsJson(token: string): string {
	return `${JSON.stringify(
		{
			providers: {
				[P_ANTHROPIC]: {
					api: "anthropic-messages",
					apiKey: token,
					baseUrl: GATEWAY,
					models: [
						{
							id: "claude-opus-4-8",
							name: "Claude Opus 4.8 (EU)",
							contextWindow: 1_000_000,
							maxTokens: 128_000,
							input: ["text", "image"],
							reasoning: true,
						},
						{
							// The region tripwire — functional but US-data-share (non-EEA).
							id: "us-n-virginia-data-share/anthropic.claude-fable-5",
							name: "Claude Fable 5 (US data-share)",
							contextWindow: 1_000_000,
							maxTokens: 128_000,
							input: ["text", "image"],
							reasoning: true,
						},
					],
				},
				[P_OPENAI]: {
					api: "openai-responses",
					apiKey: token,
					baseUrl: `${GATEWAY}/v1`,
					models: [
						{
							id: "gpt-5.6-sol",
							name: "GPT 5.6 Sol (EU)",
							contextWindow: 1_050_000,
							maxTokens: 128_000,
							input: ["text", "image"],
							reasoning: true,
						},
					],
				},
			},
		},
		null,
		2,
	)}\n`;
}

const MODELS_BLOCK = {
	// Ranked diversity axis: OpenAI first (the implementer family), Anthropic
	// second (the diverse reviewer family). The alias effort lives on the alias
	// and is shared everywhere it is used.
	families: {
		OpenAI: {
			aliases: {
				"GPT 5.6 Sol": {
					attach: [SOL],
					effort: "medium",
					notes: "Strongest implementer — the worker and utility seat.",
				},
			},
		},
		Anthropic: {
			aliases: {
				"Opus 4.8": {
					attach: [OPUS],
					effort: "medium",
					notes: "Careful judge — reviews sol's work, a different family.",
				},
				"Fable 5": {
					attach: [FABLE],
					effort: "medium",
					notes: "Region tripwire — functional but US-data-share (non-EEA).",
				},
			},
		},
	},
	// One roster; its three fixed-meaning tiers hold ordered alias refs. The
	// session seat is the implicit last-resort fallback of every tier (the v2
	// resolver appends it), so it is never listed here.
	rosters: {
		sit: {
			light: ["OpenAI/GPT 5.6 Sol"],
			standard: ["OpenAI/GPT 5.6 Sol"],
			// Fable leads heavy as the region tripwire: EEA strikes it (US-data-share)
			// so reviews resolve to Opus (EEA-legal); Global would resolve Fable.
			heavy: ["Anthropic/Fable 5", "Anthropic/Opus 4.8"],
		},
	},
	// A single default binding (no targets) → active for the opus seat the drive
	// runs on (and any seat), selecting the `sit` roster.
	bindings: {
		sit: { roster: "sit" },
	},
	// Per-agent tier allowances; the FIRST tier is the default a plan node of
	// that type spawns at (defaultTierForAgent). reviewer overrides the shipped
	// default (standard-first) to heavy-first so reviews are cross-family from
	// the sol workers even before diversity is wired.
	allowances: {
		worker: { tiers: ["standard", "heavy"] },
		explorer: { tiers: ["light", "standard"] },
		reviewer: { tiers: ["heavy", "standard"] },
		advisor: { tiers: ["heavy", "standard"] },
	},
	// The active region is the only hard filter. EEA is the real posture and the
	// SIT-only observable one (copilot/prod are all-EEA): it lists the EEA-legal
	// models and OMITS the US-data-share Fable, so the heavy tripwire is struck.
	// Global lists everything, so flipping active there resolves Fable instead.
	region: {
		active: "EEA",
		lists: {
			Global: [`${P_ANTHROPIC}/*`, `${P_OPENAI}/*`],
			EEA: [OPUS, SOL],
		},
	},
} as const;

/** The profile for a given token — pure; tests use this without credentials. */
export function sitProfileFromToken(token: string): MultiModelProfile {
	return {
		defaultProvider: P_ANTHROPIC,
		defaultModel: "claude-opus-4-8",
		modelsJsonContent: buildModelsJson(token),
		models: MODELS_BLOCK as unknown as Record<string, unknown>,
	};
}

/**
 * Build the SIT live profile against the DRIVER'S OWN gateway credential,
 * refreshing it if needed. Call at drive start, not import time.
 *
 * Previously this read the developer's pi credential and threw when it had
 * under 45m of life ("open pi on a radicalai model once to refresh"). That
 * guard existed only because the driver could not refresh; worse, refreshing
 * with pi's credential would have rotated its refresh token out from under it.
 */
export async function buildSitProfile(): Promise<MultiModelProfile> {
	return sitProfileFromToken(await liveAccessToken(GATEWAY));
}

/** The gateway this profile authenticates against (for the auth command). */
export const SIT_GATEWAY = GATEWAY;

/** Referenced model refs (for docs / catalog checks). */
export const SIT_CATALOG: readonly string[] = [OPUS, SOL, FABLE];
