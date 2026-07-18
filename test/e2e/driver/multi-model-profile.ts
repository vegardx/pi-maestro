// A multi-model ollama profile for the live e2e drive.
//
// The point is to exercise *real* role→model routing across distinct local
// models, not just the single session default: workers, utility roles, and
// reviewers each resolve to a different ollama model, proving the model-set
// machinery (presets / modelSets / availability / session-as-fallback) actually
// lands different roles on different providers end to end.
//
// v2 lineup (2026-07-18, multi-model resident serving — models pinned with
// keep-alive Forever, so no swap thrash):
//   • session / planner  → qwen3.5:27b            (newest-gen reasoning seat)
//   • normal  (workers)  → qwen3.6:27b-coding-mxfp8 → qwen3:14b
//         a real coding model with 262k context as the default worker
//   • fast    (utility)  → gemma4:e4b-mlx → qwen3:8b (classify, summarize, …)
//   • reviewpool         → gpt-oss:20b → gemma4:31b → session
//         deliberately DIFFERENT families from the qwen workers — review
//         diversity; `session` sorts to the back (session-model fallback).

import type { ThinkingLevel } from "@vegardx/pi-contracts";

const PROVIDER = "ollama";
const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

/** Every ollama model the profile references, with the summary the planner reads. */
const CATALOG = [
	{
		id: "qwen3.5:27b",
		context: 131072,
		summary: "Newest-gen reasoning generalist — the planner seat.",
	},
	{
		id: "qwen3.6:27b-coding-mxfp8",
		context: 262144,
		summary: "Strong coding model, 262k context — the worker seat.",
	},
	{
		id: "gemma4:e4b-mlx",
		context: 131072,
		summary: "Small and fast (MLX build) — classify / summarize.",
	},
	{
		id: "gpt-oss:20b",
		context: 131072,
		summary:
			"Deep reasoning, different family — adversarial / correctness review.",
	},
	{
		id: "gemma4:31b",
		context: 131072,
		summary:
			"Broad knowledge, strong prose, different family — practical / plan review.",
	},
	{
		id: "qwen3:14b",
		context: 131072,
		summary: "Solid generalist — normal-tier fallback.",
	},
	{
		id: "qwen3:8b",
		context: 131072,
		summary: "Cheap utility — fast-tier fallback.",
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
				option("gemma-e4b", "gemma4:e4b-mlx", "Small and fast — utility."),
				option("qwen8", "qwen3:8b", "Utility fallback."),
			],
		},
		normal: {
			options: [
				option(
					"qwen-coding",
					"qwen3.6:27b-coding-mxfp8",
					"Strong coding model, 262k context — default worker.",
				),
				option("qwen14", "qwen3:14b", "Generalist fallback."),
			],
		},
		reviewpool: {
			options: [
				option(
					"gptoss",
					"gpt-oss:20b",
					"Deep reasoning, different family — adversarial / correctness.",
				),
				option(
					"gemma31",
					"gemma4:31b",
					"Broad knowledge, strong prose, different family — practical / plan.",
				),
				{
					id: "own",
					model: "session",
					effort: EFFORT,
					summary: "Your own model — last-resort fallback.",
				},
			],
		},
	},
	presets: {
		"ollama-multi": {
			// Active only when the live /model session model is the planner seat.
			targets: [ref("qwen3.5:27b")],
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
	defaultModel: "qwen3.5:27b",
	modelsJsonContent: buildModelsJson(),
	models: MODELS_BLOCK as unknown as Record<string, unknown>,
};

/** The full set of ollama model ids the profile references (for docs / catalog checks). */
export const MULTI_MODEL_CATALOG: readonly string[] = CATALOG.map((e) => e.id);
