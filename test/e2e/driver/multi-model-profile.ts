// A multi-model ollama profile for the live e2e drive.
//
// The point is to exercise *real* role→model routing across distinct local
// models, not just the single session default: workers, utility roles, and
// reviewers each resolve to a different ollama model, proving the model-set
// machinery (presets / modelSets / availability / session-as-fallback) actually
// lands different roles on different providers end to end.
//
// Shape (see docs/e2e-testing.md and the drive-maestro-e2e skill):
//   • session / planner  → gpt-oss:20b   (the "most capable" reasoning seat; the
//                                          preset target, so the maestro plans here)
//   • fast    (utility)  → qwen3:8b   → gemma4:latest   (classify, summarize, …)
//   • normal  (default)  → qwen3:14b  → gemma4:26b      (worker, verify, research)
//   • reviewpool         → qwen3:14b → gpt-oss:20b → gemma4:31b → session
//         a *described* pool the planner can pick from by summary; `session`
//         sorts to the back (feat/session-model-fallback) so it's the last resort.
//
// Only the chosen option in a set loads, so steady-state RAM is ~28 GB; the one
// case that stacks heavies is the planner escalating several reviews at once.

import type { ThinkingLevel } from "@vegardx/pi-contracts";

const PROVIDER = "ollama";
const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

/** Every ollama model the profile references, with the summary the planner reads. */
const CATALOG = [
	{
		id: "gpt-oss:20b",
		summary: "Deepest reasoning — adversarial / correctness review.",
	},
	{
		id: "qwen3:14b",
		summary: "Solid fast generalist — the default worker/reviewer.",
	},
	{
		id: "qwen3:8b",
		summary: "Cheap, high-volume utility — classify / summarize.",
	},
	{
		id: "gemma4:31b",
		summary: "Broad knowledge, strong prose — practical / plan review.",
	},
	{
		id: "gemma4:26b",
		summary: "Larger generalist — the normal-tier fallback.",
	},
	{ id: "gemma4:latest", summary: "Cheap, fast — the utility-tier fallback." },
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
				option("qwen8", "qwen3:8b", "Cheap, high-volume utility."),
				option("gemma", "gemma4:latest", "Cheap fallback."),
			],
		},
		normal: {
			options: [
				option("qwen14", "qwen3:14b", "Solid fast generalist — default."),
				option("gemma26", "gemma4:26b", "Larger generalist fallback."),
			],
		},
		reviewpool: {
			options: [
				option("qwen14", "qwen3:14b", "Fast generalist reviewer — default."),
				option(
					"gptoss",
					"gpt-oss:20b",
					"Deepest reasoning — adversarial / correctness.",
				),
				option(
					"gemma31",
					"gemma4:31b",
					"Broad knowledge, strong prose — practical / plan.",
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
			targets: [ref("gpt-oss:20b")],
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
						contextWindow: 131072,
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
	defaultModel: "gpt-oss:20b",
	modelsJsonContent: buildModelsJson(),
	models: MODELS_BLOCK as unknown as Record<string, unknown>,
};

/** The full set of ollama model ids the profile references (for docs / catalog checks). */
export const MULTI_MODEL_CATALOG: readonly string[] = CATALOG.map((e) => e.id);
