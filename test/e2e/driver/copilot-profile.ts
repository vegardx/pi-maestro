// The GitHub Copilot live-drive profile — v2 shape.
//
// Unlike the ollama and SIT profiles this ships NO models.json: pi resolves
// `github-copilot` natively and carries its own catalog, so the isolated home
// needs only the credential plus the v2 models block below. That is also why
// this path is sturdier — pi owns token refresh during the run, instead of a
// bearer being frozen into models.json at launch.
//
// How v2 resolution actually works (this profile is written to it, not to the
// retired v1 preset/modelSet vocabulary):
//
//   • Plan nodes INHERIT the session model. resolveModel passes no tier, so a
//     worker, explorer or reviewer node runs on the maestro's own seat. There
//     is no per-node model routing — `normal` is not "the worker model".
//   • Tiers are for DELIBERATE requests: policy-table duty rows (classify,
//     compact-summarize, verify-delivery, the bash auditor, the watcher) and
//     subagents an agent spawns itself.
//   • `agents.<type>.models` is the allowlist bounding which tiers each agent
//     type may reach for — the menu an agent sees, not an assignment.
//   • Within a tier, resolution walks entries in authored order and takes the
//     first AVAILABLE one (residency + auth filtered). It is a priority chain.
//
// Seat and tiers for the drive:
//   • session seat        → claude-opus-4.8          plans, and every node
//   • fast                → mai-code-1-flash-picker  classify / summarize
//   • normal              → gpt-5.5                  general subagent work
//   • heavy               → claude-opus-4.8          reviews and verdicts

const PROVIDER = "github-copilot";

export const COPILOT_SEAT = "claude-opus-4.8";
export const COPILOT_FAST = "mai-code-1-flash-picker";
export const COPILOT_NORMAL = "gpt-5.5";
export const COPILOT_HEAVY = "claude-opus-4.8";

const SEAT = `${PROVIDER}/${COPILOT_SEAT}`;

/** Models this profile requires on the seat — checked before a drive starts. */
export const COPILOT_REQUIRED_MODELS: readonly string[] = [
	COPILOT_SEAT,
	COPILOT_FAST,
	COPILOT_NORMAL,
	COPILOT_HEAVY,
];

const MODELS_BLOCK = {
	catalogs: {
		copilot: {
			fast: [{ model: `${PROVIDER}/${COPILOT_FAST}`, effort: "low" }],
			normal: [{ model: `${PROVIDER}/${COPILOT_NORMAL}`, effort: "medium" }],
			heavy: [{ model: `${PROVIDER}/${COPILOT_HEAVY}`, effort: "high" }],
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

export interface CopilotProfile {
	readonly defaultProvider: string;
	readonly defaultModel: string;
	readonly models: Record<string, unknown>;
}

export const COPILOT_PROFILE: CopilotProfile = {
	defaultProvider: PROVIDER,
	defaultModel: COPILOT_SEAT,
	models: MODELS_BLOCK as unknown as Record<string, unknown>,
};

/** Referenced model refs (for docs / catalog checks). */
export const COPILOT_CATALOG: readonly string[] = [
	SEAT,
	`${PROVIDER}/${COPILOT_FAST}`,
	`${PROVIDER}/${COPILOT_NORMAL}`,
];
