// A radicalai-sit gateway profile for the live e2e drive: real hosted models
// through gateway.sit.raicode.no, no provider extension required.
//
// The bundled radicalai provider extension needs a newer host pi than the CLI
// carries (readStoredCredential, pi >=0.80.8), so this profile does what the
// ollama profile does: generate a self-contained models.json against the
// gateway. Auth is the developer's live radicalai-sit OAuth access token,
// copied into the isolated home as a static provider key — the gateway
// accepts it on both `x-api-key` (anthropic-messages) and `Authorization:
// Bearer` (openai-responses). Tokens live ~1h; buildSitProfile() refuses to
// start a drive on one about to expire.
//
// Role layout (per the review-diversity principle — reviewer ≠ author family):
//   • session / planner  → claude-opus-4-8  (careful judge: plans + reviews)
//   • normal  (workers)  → gpt-5.6-sol → session   (strongest implementer)
//   • reviewpool         → claude-opus-4-8 → session
//         opus reviews sol's work — cross-family by construction
//   • fast    (utility)  → gpt-5.6-sol @low → session

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MultiModelProfile } from "./multi-model-profile.js";

const GATEWAY = "https://gateway.sit.raicode.no";
// Two providers because models.json api is per-provider and the gateway
// serves the two models over different protocols.
const P_ANTHROPIC = "sit-anthropic";
const P_OPENAI = "sit-openai";

const OPUS = `${P_ANTHROPIC}/claude-opus-4-8`;
const SOL = `${P_OPENAI}/gpt-5.6-sol`;

/** Minimum token life for a drive: model pulls + a full plan lifecycle. */
const MIN_TOKEN_LIFE_MS = 45 * 60_000;

interface StoredOauth {
	readonly access?: string;
	readonly expires?: number;
}

function liveSitToken(): string {
	const authPath = join(homedir(), ".config", "pi", "agent", "auth.json");
	let auth: Record<string, StoredOauth>;
	try {
		auth = JSON.parse(readFileSync(authPath, "utf8"));
	} catch (err) {
		throw new Error(
			`cannot read ${authPath} for the radicalai-sit token: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const entry = auth["radicalai-sit"];
	if (!entry?.access)
		throw new Error("no radicalai-sit credential in auth.json — log in via pi");
	if (entry.expires && entry.expires < Date.now() + MIN_TOKEN_LIFE_MS) {
		throw new Error(
			`radicalai-sit token expires ${new Date(entry.expires).toISOString()} — ` +
				`less than ${MIN_TOKEN_LIFE_MS / 60000}m of life for a full drive. ` +
				"Open pi on a radicalai model once to refresh, then re-run.",
		);
	}
	return entry.access;
}

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
	modelSets: {
		fast: {
			options: [
				{
					id: "sol-fast",
					model: SOL,
					effort: "low",
					summary: "Sol at low effort — classify / summarize.",
				},
				{
					id: "own",
					model: "session",
					effort: "low",
					summary: "Your own (opus) model — last-resort fallback.",
				},
			],
		},
		normal: {
			options: [
				{
					id: "sol",
					model: SOL,
					effort: "medium",
					summary: "GPT 5.6 Sol — strongest implementer — the worker seat.",
				},
				{
					id: "own",
					model: "session",
					effort: "medium",
					summary: "Your own (opus) model — last-resort fallback.",
				},
			],
		},
		reviewpool: {
			options: [
				{
					id: "opus",
					model: OPUS,
					effort: "medium",
					summary:
						"Opus 4.8 — careful judge, different family from the sol workers.",
				},
				{
					id: "own",
					model: "session",
					effort: "medium",
					summary: "Session seat fallback.",
				},
			],
		},
	},
	presets: {
		"sit-multi": {
			targets: [OPUS],
			modelSets: {
				worker: "normal",
				verifier: "normal",
				"codebase-research": "normal",
				classifier: "fast",
				"plan-summarizer": "fast",
				"compact-summarizer": "fast",
				general: "fast",
				"web-research": "fast",
				"plan-review": "reviewpool",
				"practical-review": "reviewpool",
				"adversarial-review": "reviewpool",
				"correctness-review": "reviewpool",
				"security-review": "reviewpool",
				"test-review": "reviewpool",
				"simplification-review": "reviewpool",
			},
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
 * Build the SIT live profile. Reads the developer's live radicalai-sit token
 * (throws when missing or expiring) — call at drive start, not import time.
 */
export function buildSitProfile(): MultiModelProfile {
	return sitProfileFromToken(liveSitToken());
}

/** Referenced model refs (for docs / catalog checks). */
export const SIT_CATALOG: readonly string[] = [OPUS, SOL];
