// Typed settings for modes-owned compaction and budget telemetry. Read fresh
// so project-level overrides take effect without restarting the session. All
// knobs live under `extensionConfig.modes.compaction`. These are independent
// of pi's native `compaction.*` and of `extensionConfig.smart-compact.*`.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModesRole, ThinkingLevel, Tier } from "@vegardx/pi-contracts";
import {
	type ResolvedRoleModelFull,
	resolveRoleModel,
} from "@vegardx/pi-models";
import {
	getConfigNumber,
	getConfigString,
	getConfigStringArray,
	readLayeredExtensionConfig,
} from "@vegardx/pi-settings";

const NAME = "modes";
const SECTION = "compaction";

// ---- Centralized env var config -------------------------------------------

/**
 * All MAESTRO_* environment variables read from a single location.
 * Modules import this instead of scattered process.env reads.
 */
export const MAESTRO_ENV = {
	get analyzeModel(): string | undefined {
		return process.env.MAESTRO_ANALYZE_MODEL || undefined;
	},
	get analyzeThinking(): string | undefined {
		return process.env.MAESTRO_ANALYZE_THINKING || undefined;
	},
	get agentModel(): string | undefined {
		return process.env.MAESTRO_AGENT_MODEL || undefined;
	},
	get agentThinking(): string | undefined {
		return process.env.MAESTRO_AGENT_THINKING || undefined;
	},
	get classifierModel(): string | undefined {
		return process.env.MAESTRO_CLASSIFIER_MODEL || undefined;
	},
	get classifierThinking(): string | undefined {
		return process.env.MAESTRO_CLASSIFIER_THINKING || undefined;
	},
} as const;

// ---- Compaction settings --------------------------------------------------

export interface ModesCompactionSettings {
	/** Max output tokens per new raw-slice summary section. */
	phaseTokens: number;
	/** Budget for the working bucket (`sys + hotTail`); drives the trigger. */
	workingTokens: number;
	/** Soft warning threshold for the stable summary burden (`seed + rolling`). */
	summaryTokens: number;
	/** Deadline for a modes-triggered compaction. */
	timeoutMs: number;
	/** Optional context-window size for plan-mode footer display. Unset = off. */
	planMaxContextTokens: number | undefined;
}

function positive(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readModesCompactionSettings(
	cwd: string,
	agentDir?: string,
): ModesCompactionSettings {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const read = (key: string, fallback: number): number =>
		positive(
			getConfigNumber(merged, NAME, `${SECTION}.${key}`, fallback),
			fallback,
		);
	const planMax = getConfigNumber(
		merged,
		NAME,
		`${SECTION}.planMaxContextTokens`,
		0,
	);
	return {
		phaseTokens: read("phaseTokens", 10000),
		workingTokens: read("workingTokens", 150000),
		summaryTokens: read("summaryTokens", 100000),
		timeoutMs: read("timeoutMs", 90000),
		planMaxContextTokens: planMax > 0 ? planMax : undefined,
	};
}

// ---- Worktree provisioning settings -----------------------------------------

/** Environment setup for freshly provisioned worktrees (provisioner shape). */
export interface WorktreeSetupSettings {
	/** Gitignored files copied from the main checkout (e.g. `.env`). */
	copy?: string[];
	/** One-shot setup command run in a fresh worktree (e.g. `npm ci`). */
	setupCommand?: string;
	/** Paths symlinked from the main checkout — explicit opt-in only. */
	linkPaths?: string[];
}

/**
 * Read worktree environment settings from `extensionConfig.maestro.worktree`:
 * `copy` (string[]), `setup` (string), and `link` (string[]). Read fresh per
 * run so project-level overrides apply without restarting the session.
 */
export function readWorktreeSetupSettings(
	cwd: string,
	agentDir?: string,
): WorktreeSetupSettings {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const copy = getConfigStringArray(merged, "maestro", "worktree.copy", []);
	const setup = getConfigString(merged, "maestro", "worktree.setup", "");
	const link = getConfigStringArray(merged, "maestro", "worktree.link", []);
	return {
		...(copy.length > 0 ? { copy: [...copy] } : {}),
		...(setup.trim() !== "" ? { setupCommand: setup } : {}),
		...(link.length > 0 ? { linkPaths: [...link] } : {}),
	};
}

// ---- Role-model resolver facade -------------------------------------------

const THINKING_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
]);

function asThinking(v: string | undefined): ThinkingLevel | undefined {
	if (v && THINKING_LEVELS.has(v)) return v as ThinkingLevel;
	return undefined;
}

function envForRole(role: ModesRole): {
	model?: string;
	effort?: ThinkingLevel;
} {
	switch (role) {
		case "agent":
			return {
				model: MAESTRO_ENV.agentModel,
				effort: asThinking(MAESTRO_ENV.agentThinking),
			};
		case "analyze":
			return {
				model: MAESTRO_ENV.analyzeModel,
				effort: asThinking(MAESTRO_ENV.analyzeThinking),
			};
		case "classifier":
			return {
				model: MAESTRO_ENV.classifierModel,
				effort: asThinking(MAESTRO_ENV.classifierThinking),
			};
	}
}

/** Per-invocation overrides set by /implement --model/--effort flags. */
export interface ImplementOverrides {
	agentModel?: string;
	agentThinking?: ThinkingLevel;
	analyzeModel?: string;
	analyzeThinking?: ThinkingLevel;
}

let _implementOverrides: ImplementOverrides | undefined;

/** Set per-invocation overrides (called from /implement handler). */
export function setImplementOverrides(
	overrides: ImplementOverrides | undefined,
): void {
	_implementOverrides = overrides;
}

/** Get current per-invocation overrides. */
export function getImplementOverrides(): ImplementOverrides | undefined {
	return _implementOverrides;
}

function explicitForRole(role: ModesRole): {
	model?: string;
	effort?: ThinkingLevel;
} {
	const o = _implementOverrides;
	if (!o) return {};
	switch (role) {
		case "agent":
			return { model: o.agentModel, effort: o.agentThinking };
		case "analyze":
			return { model: o.analyzeModel, effort: o.analyzeThinking };
		default:
			return {};
	}
}

/** Fixed role → tier mapping. The tier resolves through the active profile. */
const ROLE_TIER: Record<ModesRole, Tier> = {
	agent: "work",
	analyze: "work",
	classifier: "fast",
};

/**
 * Resolve a model + effort level for a modes role.
 * Priority: CLI arg → env var → role escape hatch → the role's tier → session.
 */
export async function getModeRoleModel(
	ctx: ExtensionContext,
	role: ModesRole,
): Promise<ResolvedRoleModelFull | null> {
	const explicit = explicitForRole(role);
	const env = envForRole(role);
	return resolveRoleModel(ctx, {
		extension: NAME,
		role,
		tier: ROLE_TIER[role],
		explicit: explicit.model || explicit.effort ? explicit : undefined,
		env: env.model || env.effort ? env : undefined,
	});
}

// ---- Review policy --------------------------------------------------------

export interface ReviewPolicyRule {
	/** Slot(s) to use for review agents. */
	reviews: ("default" | "alternate")[];
	/** Whether to spawn a refine agent after reviews. */
	refine?: boolean;
	/** Whether to spawn a verify agent. */
	verify?: boolean;
	/** Effort level for review agents in this category. */
	effort?: ThinkingLevel;
}

export interface ReviewPolicy {
	[category: string]: ReviewPolicyRule;
}

/**
 * Read the review policy from extensionConfig.modes.reviewPolicy.
 * Returns empty object if not configured (meaning: let the LLM decide).
 */
export function readReviewPolicy(cwd: string, agentDir?: string): ReviewPolicy {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const modes = merged?.extensionConfig?.[NAME] as
		| Record<string, unknown>
		| undefined;
	if (!modes || typeof modes.reviewPolicy !== "object" || !modes.reviewPolicy)
		return {};
	return modes.reviewPolicy as ReviewPolicy;
}
