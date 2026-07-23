// A multi-model ollama profile for the live e2e drive.
//
// The point is to exercise *real* role→model routing across distinct local
// models, not just the single session default: workers, utility roles, and
// reviewers each resolve to a different ollama model, proving the v2 resolver
// (families / rosters / bindings / allowances / seat-as-fallback) actually lands
// different agent types on different models end to end.
//
// v3 lineup (2026-07-19, three-model MoE refresh; ollama runs as a service
// with a 5-min keepalive, OLLAMA_CONTEXT_LENGTH=65536, and loads models on
// demand. context below MUST match the ollama cap: if pi believes the
// window is larger than ollama allocates, prompts get silently truncated
// mid-context; matched, pi compacts before the edge instead). v2 layout — three
// ranked families, one roster, a default binding, per-agent tier allowances:
//   • session / planner  → Gemma/Gemma4 31B (strong generalist — the seat)
//   • standard (workers) → Qwen/Qwen3.6 Coder → seat  (MoE coder, ~3B active)
//   • light  (utility)   → GptOss/GPT-OSS 20B → seat  (classify, summarize, …)
//   • heavy  (reviewers) → GptOss/GPT-OSS 20B → seat  (non-qwen — cross-family;
//         the gemma seat is the last-resort fallback the resolver appends)

import type { ThinkingLevel } from "@vegardx/pi-contracts";

const PROVIDER = "ollama";
const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

/** Every ollama model the profile references, with the summary the planner reads. */
const CATALOG = [
	{
		id: "gemma4:31b-mlx",
		context: 65536,
		summary:
			"Broad knowledge, strong prose generalist — the planner seat; also the cross-family review fallback.",
	},
	{
		id: "qwen3.6:35b-a3b-coding-mxfp8",
		context: 65536,
		summary: "MoE coding model (~3B active) — fast decode — the worker seat.",
	},
	{
		id: "gpt-oss:20b",
		context: 65536,
		summary:
			"Deep reasoning, different family — utility and adversarial / correctness review.",
	},
] as const;

const EFFORT: ThinkingLevel = "medium";

function ref(id: string): string {
	return `${PROVIDER}/${id}`;
}

/** The `models` settings block: v2 families → roster → binding → allowances. */
const MODELS_BLOCK = {
	// Ranked diversity axis: the qwen coder first (workers), gpt-oss second
	// (utility + the cross-family reviewer), gemma last (the planner seat's
	// family). Each alias carries the shared effort.
	families: {
		Qwen: {
			aliases: {
				"Qwen3.6 Coder": {
					attach: [ref("qwen3.6:35b-a3b-coding-mxfp8")],
					effort: EFFORT,
					notes: "MoE coding model (~3B active) — fast decode — worker seat.",
				},
			},
		},
		GptOss: {
			aliases: {
				"GPT-OSS 20B": {
					attach: [ref("gpt-oss:20b")],
					effort: EFFORT,
					notes: "Deep reasoning, a different family — utility and review.",
				},
			},
		},
		Gemma: {
			aliases: {
				"Gemma4 31B": {
					attach: [ref("gemma4:31b-mlx")],
					effort: EFFORT,
					notes: "Broad knowledge, strong prose — the planner seat.",
				},
			},
		},
	},
	// One roster; its three fixed-meaning tiers hold ordered alias refs. The
	// session seat (gemma) is the resolver's implicit last-resort fallback of
	// every tier, so it is never listed here.
	rosters: {
		ollama: {
			light: ["GptOss/GPT-OSS 20B"],
			standard: ["Qwen/Qwen3.6 Coder"],
			heavy: ["GptOss/GPT-OSS 20B"],
		},
	},
	// A single default binding (no targets) → active for the gemma seat (and any
	// seat), selecting the `ollama` roster.
	bindings: {
		ollama: { roster: "ollama" },
	},
	// Per-agent tier allowances; the FIRST tier is the default a plan node of
	// that type spawns at. reviewer overrides the shipped default to heavy-first
	// so a review lands on gpt-oss — a different family than the qwen workers.
	allowances: {
		worker: { tiers: ["standard", "heavy"] },
		explorer: { tiers: ["light", "standard"] },
		reviewer: { tiers: ["heavy", "standard"] },
		advisor: { tiers: ["heavy", "standard"] },
	},
} as const;

/** A models.json catalog defining the ollama provider + every referenced model. */
function buildModelsJson(): string {
	return `${JSON.stringify(
		{
			providers: {
				[PROVIDER]: {
					api: "openai-completions",
					apiKey: "ollama",
					baseUrl: OLLAMA_BASE_URL,
					models: CATALOG.map((entry) => ({
						id: entry.id,
						contextWindow: entry.context,
						input: ["text"],
						reasoning: true,
					})),
				},
			},
		},
		null,
		2,
	)}\n`;
}

export interface MultiModelProfile {
	readonly defaultProvider: string;
	/** The planner/session seat — the preset target. */
	readonly defaultModel: string;
	/** models.json content installed into the isolated agent dir. */
	readonly modelsJsonContent: string;
	/** The `models` settings block (v2 families/rosters/bindings/allowances). */
	readonly models: Record<string, unknown>;
}

/** The ready-made ollama multi-model profile the `--multi-model` live drive uses. */
export const MULTI_MODEL_OLLAMA: MultiModelProfile = {
	defaultProvider: PROVIDER,
	defaultModel: "gemma4:31b-mlx",
	modelsJsonContent: buildModelsJson(),
	models: MODELS_BLOCK as unknown as Record<string, unknown>,
};

/** The full set of ollama model ids the profile references (for docs / catalog checks). */
export const MULTI_MODEL_CATALOG: readonly string[] = CATALOG.map((e) => e.id);
