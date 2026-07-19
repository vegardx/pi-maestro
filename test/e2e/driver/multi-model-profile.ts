// A multi-model ollama profile for the live e2e drive.
//
// The point is to exercise *real* role→model routing across distinct local
// models, not just the single session default: workers, utility roles, and
// reviewers each resolve to a different ollama model, proving the model-set
// machinery (presets / modelSets / availability / session-as-fallback) actually
// lands different roles on different providers end to end.
//
// v3 lineup (2026-07-19, three-model MoE refresh; ollama runs as a service
// with a 5-min keepalive, OLLAMA_CONTEXT_LENGTH=65536, and loads models on
// demand. context below MUST match the ollama cap: if pi believes the
// window is larger than ollama allocates, prompts get silently truncated
// mid-context; matched, pi compacts before the edge instead):
//   • session / planner  → gemma4:31b-mlx (strong generalist, cross-family)
//   • normal  (workers)  → qwen3.6:35b-a3b-coding-mxfp8 → session
//         MoE coder (~3B active params) — fast decode on this hardware
//   • fast    (utility)  → gpt-oss:20b → session (classify, summarize, …)
//   • reviewpool         → gpt-oss:20b → session
//         both review options are NON-qwen families (gpt-oss + the gemma
//         session seat) — review diversity against the qwen workers;
//         `session` sorts to the back (session-model fallback).

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

function option(optionId: string, modelId: string, summary: string) {
	return { id: optionId, model: ref(modelId), effort: EFFORT, summary };
}

/** The `models` settings block: pooled sets + a preset targeting the session model. */
const MODELS_BLOCK = {
	modelSets: {
		fast: {
			options: [
				option(
					"gptoss-fast",
					"gpt-oss:20b",
					"Fast utility — classify / summarize.",
				),
				{
					id: "own",
					model: "session",
					effort: EFFORT,
					summary: "Your own model — last-resort fallback.",
				},
			],
		},
		normal: {
			options: [
				option(
					"qwen-moe",
					"qwen3.6:35b-a3b-coding-mxfp8",
					"MoE coding model — fast decode — default worker.",
				),
				{
					id: "own",
					model: "session",
					effort: EFFORT,
					summary: "Your own model — last-resort fallback.",
				},
			],
		},
		reviewpool: {
			options: [
				option(
					"gptoss",
					"gpt-oss:20b",
					"Deep reasoning, different family — adversarial / correctness.",
				),
				{
					id: "own",
					model: "session",
					effort: EFFORT,
					summary:
						"Your own (gemma) model — broad knowledge, strong prose — practical / plan.",
				},
			],
		},
	},
	presets: {
		"ollama-multi": {
			// Active only when the live /model session model is the planner seat.
			targets: [ref("gemma4:31b-mlx")],
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
	/** The `models` settings block (presets + modelSets) for settings.json. */
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
