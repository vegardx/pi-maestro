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
	/** `true` => spawn with --no-extensions (child loads only extraExtensions). */
	readonly isolateExtensions?: boolean;
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

// research: a plan-mode research agent. Spawns with --no-extensions so the
// tool namespace is deterministic — the caller passes the research-tools
// extension (websearch/webfetch/context7 via direct APIs) through
// extraExtensions. Read-only over the codebase, web-capable, no session,
// cannot recurse (nothing that spawns is loaded).
const RESEARCH: ProfileDefaults = {
	tools: {
		allow: ["read", "grep", "find", "ls", "websearch", "webfetch", "context7"],
	},
	mode: "plan",
	session: false,
	disableExtensions: ["modes", "subagents"],
	isolateExtensions: true,
};

// deliverable-agent: implements a single deliverable in a worktree. Can read,
// edit, and run tests, but cannot commit/push/create PRs — that's the
// maestro's job at ship time. Commit extension disabled.
const DELIVERABLE_WORKER: ProfileDefaults = {
	mode: "auto",
	session: true,
	disableExtensions: ["commit"],
};

// general: the ad-hoc delegate for tasks with no specialized agent. Read-only
// and isolated (-ne) so its tool namespace is deterministic; the caller picks
// model/effort per spawn and opts into web tools (research-tools extension)
// when the task needs them.
const GENERAL: ProfileDefaults = {
	tools: { allow: ["read", "grep", "find", "ls"] },
	mode: "plan",
	session: false,
	disableExtensions: ["modes", "subagents"],
	isolateExtensions: true,
};

export const BUILTIN_PROFILES: Readonly<Record<string, ProfileDefaults>> = {
	restricted: RESTRICTED,
	research: RESEARCH,
	"deliverable-agent": DELIVERABLE_WORKER,
	general: GENERAL,
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
	readonly sessionDir?: string;
	readonly sessionFile?: string;
	readonly disableExtensions: readonly string[];
	readonly isolateExtensions: boolean;
	readonly extraExtensions: readonly string[];
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
		sessionDir: profile.sessionDir,
		sessionFile: profile.sessionFile,
		disableExtensions: defaults.disableExtensions,
		isolateExtensions:
			profile.isolateExtensions ?? defaults.isolateExtensions ?? false,
		extraExtensions: profile.extraExtensions ?? [],
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
