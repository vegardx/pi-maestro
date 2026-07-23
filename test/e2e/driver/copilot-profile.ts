// The GitHub Copilot live-drive profile — v2 shape, all-GPT seat.
//
// Unlike the ollama and SIT profiles this ships a models.json that carries NO
// provider auth — only `modelOverrides` (see below). pi still resolves
// `github-copilot` natively (owns oauth token refresh during the run); the
// overrides compose on top of that native provider, correcting metadata without
// freezing a bearer.
//
// How v2 resolution works (this profile is written to the families vocabulary —
// families/rosters/bindings/allowances — not the retired v1 preset/modelSet one,
// nor the interim catalogs/profiles/agents one):
//   • Plan nodes INHERIT the session model. resolveModel passes no tier only
//     when the agent has no default tier, so an inherited node runs on the
//     maestro's own seat. `standard` is NOT "the worker model" by itself.
//   • Tiers are DELIBERATE: a plan node spawns at its agent type's default tier
//     (defaultTierForAgent), and policy-table duty rows / self-spawned subagents
//     name a tier explicitly.
//   • `allowances.<type>.tiers` bounds which tiers each agent type may reach
//     (first = its default) — the menu an agent sees.
//   • Within a tier, resolution walks alias refs in authored order and takes the
//     first AVAILABLE attachment — a priority chain. The session seat is never a
//     tier entry: it is appended last as the known-good fallback (seat-to-end),
//     so a tier prefers a real alternative and lands on the seat only if all are
//     down.
//
// Seat and tiers (seat = gpt-5.5, the implicit last fallback of every tier):
//   • session seat  → gpt-5.5 @ xhigh                    plans, and every node
//   • light         → mai-code-1-flash-picker @ low      classify / summarize
//   • standard      → gpt-5.4 → gpt-5.3-codex @ medium   subagent work
//   • heavy         → claude-opus-4.8 @ xhigh            reviews and verdicts
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
/** normal tier, priority order — first available wins; seat (gpt-5.5) is the
 *  seat-to-end fallback, so it is NOT listed here. */
export const COPILOT_NORMAL = ["gpt-5.4", "gpt-5.3-codex"] as const;
/** heavy tier — Opus is the deliberate non-seat judge; the seat (gpt-5.5) is
 *  the seat-to-end fallback if Opus is unavailable. */
export const COPILOT_HEAVY = ["claude-opus-4.8"] as const;
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
	// Families are the diversity axis. GPT holds the seat and the standard-tier
	// implementers; MAI the flash picker; Anthropic the heavy judge (a different
	// family than the GPT workers — cross-family review by construction).
	families: {
		GPT: {
			aliases: {
				// The seat's own alias — not a tier entry, but gives the seat a
				// family (footer / diversity resolve through it).
				[COPILOT_SEAT]: { attach: [SEAT], effort: COPILOT_SEAT_EFFORT },
				...Object.fromEntries(
					COPILOT_NORMAL.map((model) => [
						model,
						{ attach: [ref(model)], effort: "medium" },
					]),
				),
			},
		},
		MAI: {
			aliases: {
				[COPILOT_FAST]: { attach: [ref(COPILOT_FAST)], effort: "low" },
			},
		},
		Anthropic: {
			aliases: Object.fromEntries(
				COPILOT_HEAVY.map((model) => [
					model,
					{ attach: [ref(model)], effort: "xhigh" },
				]),
			),
		},
	},
	// One roster; a tier's ordered alias refs are a priority chain (first
	// available wins). The seat (gpt-5.5) is the resolver's implicit last-resort
	// fallback of every tier, so it is never a tier entry.
	rosters: {
		copilot: {
			light: [`MAI/${COPILOT_FAST}`],
			standard: COPILOT_NORMAL.map((model) => `GPT/${model}`),
			heavy: COPILOT_HEAVY.map((model) => `Anthropic/${model}`),
		},
	},
	// A single default binding (no targets) selects the roster for the gpt-5.5
	// seat the drive runs on.
	bindings: {
		copilot: { roster: "copilot" },
	},
	// Per-agent tier allowances; the FIRST tier is the default a plan node of
	// that type spawns at. reviewer defaults to heavy so a verdict is never
	// cheaper than — nor the same family as — the work it judges.
	allowances: {
		worker: { tiers: ["standard", "heavy"] },
		explorer: { tiers: ["light", "standard"] },
		reviewer: { tiers: ["heavy", "standard"] },
		advisor: { tiers: ["heavy", "standard"] },
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
