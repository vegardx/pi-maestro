// Built-in spawn profiles and the rules that distinguish them. A profile is
// policy: what the child may do (tools/mode), how deep it may recurse, and
// which extensions/features are forced off in the child. The SpawnProfile a
// caller passes (from contracts) selects a built-in by name and may override
// individual fields.

import type {
	FeatureFlagOverrides,
	ModeName,
	SpawnProfile,
	ThinkingLevel,
	ToolPolicy,
} from "@vegardx/pi-contracts";

/** The policy defaults a named profile carries. */
export interface ProfileDefaults {
	readonly tools?: ToolPolicy;
	readonly mode?: ModeName;
	readonly thinking?: ThinkingLevel;
	/** `false` => spawn the child with --no-session. */
	readonly session: boolean;
	/** Extensions forced off in the child (→ PI_EXT_<NAME>=off). */
	readonly disableExtensions: readonly string[];
	/** Feature-flag overrides forced in the child (→ PI_DISABLE/PI_ENABLE). */
	readonly featureFlags?: FeatureFlagOverrides;
}

const READ_ONLY_TOOLS: ToolPolicy = {
	allow: ["read", "grep", "find", "ls", "websearch", "webfetch"],
};

// restricted: read-only explore/review. No modes and no subagents (so it
// cannot orchestrate or spawn), no session file. The child can look but not
// change the repo, orchestrate, or recurse.
const RESTRICTED: ProfileDefaults = {
	tools: READ_ONLY_TOOLS,
	mode: "plan",
	session: false,
	disableExtensions: ["modes", "subagents"],
};

// deliverable-worker: implements a single deliverable in a worktree. Can read,
// edit, and run tests, but cannot commit/push/create PRs — that's the
// orchestrator's job at ship time. Commit extension disabled.
const DELIVERABLE_WORKER: ProfileDefaults = {
	mode: "auto",
	session: true,
	disableExtensions: ["commit"],
};

export const BUILTIN_PROFILES: Readonly<Record<string, ProfileDefaults>> = {
	restricted: RESTRICTED,
	"deliverable-worker": DELIVERABLE_WORKER,
};

/** A SpawnProfile resolved against its named built-in. */
export interface ResolvedProfile {
	readonly name: string;
	readonly cwd?: string;
	readonly model?: string;
	readonly tools?: ToolPolicy;
	readonly mode?: ModeName;
	readonly thinking?: ThinkingLevel;
	readonly appendSystemPrompt?: string;
	readonly session: boolean;
	readonly disableExtensions: readonly string[];
	readonly featureFlags?: FeatureFlagOverrides;
}

export function resolveProfile(profile: SpawnProfile): ResolvedProfile {
	const defaults = BUILTIN_PROFILES[profile.profile];
	if (!defaults) {
		throw new Error(`unknown spawn profile: ${profile.profile}`);
	}
	return {
		name: profile.profile,
		cwd: profile.cwd,
		model: profile.model,
		tools: profile.tools ?? defaults.tools,
		mode: profile.mode ?? defaults.mode,
		thinking: profile.thinking ?? defaults.thinking,
		appendSystemPrompt: profile.appendSystemPrompt,
		session: profile.session ?? defaults.session,
		disableExtensions: defaults.disableExtensions,
		featureFlags: mergeFlags(defaults.featureFlags, profile.featureFlags),
	};
}

function mergeFlags(
	base: FeatureFlagOverrides | undefined,
	over: FeatureFlagOverrides | undefined,
): FeatureFlagOverrides | undefined {
	if (!base && !over) return undefined;
	return {
		enable: dedupe([...(base?.enable ?? []), ...(over?.enable ?? [])]),
		disable: dedupe([...(base?.disable ?? []), ...(over?.disable ?? [])]),
	};
}

function dedupe(xs: readonly string[]): string[] {
	return [...new Set(xs)];
}
