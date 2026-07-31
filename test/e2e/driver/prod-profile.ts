// A radicalai PROD gateway profile for the live e2e drive: real hosted models
// through gateway.raicode.no.
//
// Unlike sit-profile (which owns a private driver credential), prod REUSES the
// developer's OWN global `radicalai` token — the "use my global config" path we
// agreed on. buildProdProfile() reads it READ-ONLY from <agentDir>/auth.json
// (see readHostProviderToken) and bakes it into a generated models.json. It
// never refreshes or writes the credential: refreshing rotates the gateway's
// refresh token and would invalidate the developer's pi login. So the token
// must be fresh — pi keeps it fresh in normal use; if it is stale the profile
// throws with "open pi and hit a radicalai model once to refresh". A short
// drive fits inside a ~1h token.
//
// Why a generated models.json rather than the real radicalai provider EXTENSION
// (`pi-extension-custom-provider-radicalai`): the same reason as sit-profile —
// the drive keeps its PLAN STORE isolated (a real PI_CODING_AGENT_DIR would
// pollute the developer's 100+ real plans), and an isolated home can't also
// carry the extension's stored credential. So models/auth come from the global
// token, the plan store stays isolated. Prod is ALL-EEA, so there is NO region
// tripwire (that is SIT-only, where the US-data-share Fable exists).
//
// v2 layout mirrors sit-profile: OpenAI/Anthropic families, one roster, a
// default binding, per-persona allowances (code-review → heavy = Opus, a
// different family than the sol workers).

import { readHostProviderToken } from "./gateway-auth.js";
import type { MultiModelProfile } from "./multi-model-profile.js";

const GATEWAY = "https://gateway.raicode.no";
/** The provider key in the developer's global auth.json holding the prod token. */
const HOST_PROVIDER = "radicalai";

// Two providers because models.json `api` is per-provider and the gateway
// serves the two models over different protocols (as on SIT).
const P_ANTHROPIC = "prod-anthropic";
const P_OPENAI = "prod-openai";

const OPUS = `${P_ANTHROPIC}/claude-opus-4-8`;
const SOL = `${P_OPENAI}/gpt-5.6-sol`;

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
	// second (the diverse reviewer family). Effort lives on the alias.
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
			},
		},
	},
	// One roster; its three fixed-meaning tiers hold ordered alias refs. The
	// session seat is the implicit last-resort fallback of every tier (the v2
	// resolver appends it), so it is never listed here. Prod is all-EEA, so
	// heavy is simply Opus (no region tripwire — that is SIT-only).
	rosters: {
		prod: {
			light: ["OpenAI/GPT 5.6 Sol"],
			standard: ["OpenAI/GPT 5.6 Sol"],
			heavy: ["Anthropic/Opus 4.8"],
		},
	},
	// A single default binding (no targets) → active for the opus seat.
	bindings: {
		prod: { roster: "prod" },
	},
	// Per-persona tier allowances; the FIRST tier is the default a spawn of
	// that persona resolves at. code-review overrides to heavy-first so reviews
	// are cross-family from the sol workers even before diversity is wired.
	allowances: {
		"deliverable-worker": { tiers: ["standard", "heavy"] },
		"codebase-research": { tiers: ["light", "standard"] },
		"code-review": { tiers: ["heavy", "standard"] },
		standby: { tiers: ["heavy", "standard"] },
	},
	// Prod is ALL-EEA — every model is EEA-legal, so the region filter strikes
	// nothing (no US-data-share tripwire exists on prod; that is SIT-only). EEA
	// lists both providers; the posture is honest without changing resolution.
	region: {
		active: "EEA",
		lists: {
			Global: [`${P_ANTHROPIC}/*`, `${P_OPENAI}/*`],
			EEA: [OPUS, SOL],
		},
	},
} as const;

/** The profile for a given token — pure; tests use this without credentials. */
export function prodProfileFromToken(token: string): MultiModelProfile {
	return {
		defaultProvider: P_ANTHROPIC,
		defaultModel: "claude-opus-4-8",
		modelsJsonContent: buildModelsJson(token),
		models: MODELS_BLOCK as unknown as Record<string, unknown>,
	};
}

/**
 * Build the PROD live profile from the developer's OWN global `radicalai`
 * token (read-only). Call at drive start, not import time. Throws with an
 * actionable message if the token is missing or stale.
 */
export function buildProdProfile(): MultiModelProfile {
	return prodProfileFromToken(readHostProviderToken(HOST_PROVIDER));
}

/** The gateway this profile authenticates against. */
export const PROD_GATEWAY = GATEWAY;

/** Referenced model refs (for docs / catalog checks). */
export const PROD_CATALOG: readonly string[] = [OPUS, SOL];
