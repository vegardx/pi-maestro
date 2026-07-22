// The GitHub Copilot live-drive profile — v2 shape, all-GPT seat.
//
// Unlike the ollama and SIT profiles this ships a models.json that carries NO
// provider auth — only `modelOverrides` (see below). pi still resolves
// `github-copilot` natively (owns oauth token refresh during the run); the
// overrides compose on top of that native provider, correcting metadata without
// freezing a bearer.
//
// How v2 resolution works (this profile is written to it, not the retired v1
// preset/modelSet vocabulary):
//   • Plan nodes INHERIT the session model. resolveModel passes no tier, so a
//     worker/explorer/reviewer node runs on the maestro's own seat. `normal` is
//     NOT "the worker model".
//   • Tiers are for DELIBERATE requests: policy-table duty rows (classify,
//     compact-summarize, verify-delivery, the bash auditor, the watcher) and
//     subagents an agent spawns itself.
//   • `agents.<type>.models` is the allowlist bounding which tiers each agent
//     type may reach — the menu an agent sees, not an assignment.
//   • Within a tier, resolution walks entries in authored order and takes the
//     first AVAILABLE one — a priority chain.
//
// Seat and tiers:
//   • session seat  → gpt-5.5 @ xhigh                    plans, and every node
//   • fast          → mai-code-1-flash-picker @ low      classify / summarize
//   • normal        → gpt-5.5 → gpt-5.4 → gpt-5.3-codex @ medium   subagent work
//   • heavy         → gpt-5.5 → claude-opus-4.8 @ xhigh  reviews and verdicts
//
// Why the seat is GPT, not Opus: the maestro wedged mid-structuring on the
// Copilot completion following a tool result, on claude-opus-4.8. Moving the
// seat to gpt-5.5 tests whether the hang is Opus-specific.
//
// CONTEXT WINDOWS — the modelOverrides below. pi's auto-generated Copilot
// catalog trusts GitHub's PUBLIC 1M announcement and hardcodes contextWindow
// 1_000_000 for these models. This DNB enterprise seat actually serves far
// less (its /models endpoint reports max_prompt_tokens = the real input cap).
// pi never reads that live endpoint, so it over-budgets, never compacts, and
// eventually sends a request past the seat's real input wall — which over the
// enterprise streaming proxy plausibly manifests as the mid-run hang. So we
// override contextWindow DOWN to each model's real input cap; `shouldCompact`
// compares input tokens against it, so compaction fires before the wall (the
// same shape as pi's own #3765 fix, which hardcoded 272000 for gpt-5.4/5.5).

const PROVIDER = "github-copilot";

export const COPILOT_SEAT = "gpt-5.5";
export const COPILOT_FAST = "mai-code-1-flash-picker";
/** normal tier, priority order — first available wins. */
export const COPILOT_NORMAL = ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex"] as const;
/** heavy tier — gpt-5.5 primary, Opus retained as a fallback judge. */
export const COPILOT_HEAVY = ["gpt-5.5", "claude-opus-4.8"] as const;
/** Seat thinking level (`defaultThinkingLevel`) — every inherited node's effort. */
export const COPILOT_SEAT_EFFORT = "xhigh";

const SEAT = `${PROVIDER}/${COPILOT_SEAT}`;
const ref = (model: string): string => `${PROVIDER}/${model}`;

/**
 * Real per-seat INPUT caps (max_prompt_tokens from the DNB Copilot /models
 * endpoint), NOT pi's static 1M. Keyed by bare model id — the shape
 * `composeModelProvider` matches (`config.modelOverrides[model.id]`).
 */
const REAL_INPUT_CAP: Record<string, number> = {
	"gpt-5.5": 272_000,
	"gpt-5.4": 272_000,
	"gpt-5.3-codex": 272_000,
	"claude-opus-4.8": 200_000,
	"mai-code-1-flash-picker": 128_000,
};

/** Models to accept the per-model policy for at login (deduped across slots). */
export const COPILOT_REQUIRED_MODELS: readonly string[] = [
	...new Set([COPILOT_SEAT, COPILOT_FAST, ...COPILOT_NORMAL, ...COPILOT_HEAVY]),
];

const MODELS_BLOCK = {
	catalogs: {
		copilot: {
			fast: [{ model: ref(COPILOT_FAST), effort: "low" }],
			normal: COPILOT_NORMAL.map((model) => ({
				model: ref(model),
				effort: "medium",
			})),
			heavy: COPILOT_HEAVY.map((model) => ({
				model: ref(model),
				effort: "xhigh",
			})),
		},
	},
	profiles: {
		copilot: { targets: [SEAT], catalog: "copilot" },
	},
	// Tier allowlists per agent type. Reviewers may reach `heavy` so a review
	// verdict is never cheaper than the work it judges; explorers stay off it.
	agents: {
		worker: { models: ["fast", "normal", "heavy"] },
		explorer: { models: ["fast", "normal"] },
		reviewer: { models: ["normal", "heavy"] },
	},
} as const;

/**
 * A models.json with ONLY `modelOverrides` under the native provider — no
 * providers.auth, so pi keeps its own oauth. Composes over the built-in catalog
 * to correct each contextWindow to the real input cap.
 */
export const COPILOT_MODELS_JSON = `${JSON.stringify(
	{
		providers: {
			[PROVIDER]: {
				modelOverrides: Object.fromEntries(
					Object.entries(REAL_INPUT_CAP).map(([id, contextWindow]) => [
						id,
						{ contextWindow },
					]),
				),
			},
		},
	},
	null,
	2,
)}\n`;

export interface CopilotProfile {
	readonly defaultProvider: string;
	readonly defaultModel: string;
	readonly defaultThinkingLevel: string;
	readonly models: Record<string, unknown>;
	readonly modelsJsonContent: string;
}

export const COPILOT_PROFILE: CopilotProfile = {
	defaultProvider: PROVIDER,
	defaultModel: COPILOT_SEAT,
	defaultThinkingLevel: COPILOT_SEAT_EFFORT,
	models: MODELS_BLOCK as unknown as Record<string, unknown>,
	modelsJsonContent: COPILOT_MODELS_JSON,
};
