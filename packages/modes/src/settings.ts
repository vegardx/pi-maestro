// Typed settings for modes-owned compaction and budget telemetry. Read fresh
// so project-level overrides take effect without restarting the session. All
// knobs live under `extensionConfig.modes.compaction`. These are independent
// of pi's native `compaction.*` and of `extensionConfig.smart-compact.*`.

import { existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@vegardx/pi-contracts";
import {
	getConfigNumber,
	getConfigString,
	getConfigStringArray,
	readLayeredExtensionConfig,
	readPath,
} from "@vegardx/pi-settings";

const NAME = "modes";
const SECTION = "compaction";

// ---- Compaction settings --------------------------------------------------

export interface ModesCompactionSettings {
	/** Max output tokens per new raw-slice summary section. */
	phaseTokens: number;
	/** Deadline for the summariser (distill compactions, ship-time carry-forward). */
	timeoutMs: number;
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
	return {
		phaseTokens: read("phaseTokens", 10000),
		timeoutMs: read("timeoutMs", 90000),
	};
}

// ---- Distill threshold ladder -------------------------------------------------

/**
 * The /distill threshold ladder (extensionConfig.modes.distill). Fractions of
 * context fill: at `nudgeAt` a non-blocking question suggests /distill; at
 * `forceAt` a self-curated distill runs (never blocking on an absent human).
 * `forceAt: 0` disables the force for users who prefer to ride the cache.
 */
export interface DistillSettings {
	nudgeAt: number;
	forceAt: number;
}

export function readDistillSettings(
	cwd: string,
	agentDir?: string,
): DistillSettings {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const fraction = (key: string, fallback: number): number => {
		const v = getConfigNumber(merged, NAME, `distill.${key}`, fallback);
		return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
	};
	return {
		nudgeAt: fraction("nudgeAt", 0.3),
		forceAt: fraction("forceAt", 0.5),
	};
}

// ---- Research watchdog settings ---------------------------------------------

/**
 * Watchdog thresholds for research children (extensionConfig.modes.research).
 * Replaces the old flat timeout: stalls (event silence) die fast, slow-but-
 * productive runs get steered to wrap up, and the hard cap only backstops
 * truly unbounded runs.
 */
export interface ResearchWatchdogSettings {
	/** Event silence that counts as wedged. Must exceed the longest legitimately silent tool call (a deep web search). */
	stallMs: number;
	/** Elapsed time after which the child is steered once to write its report now. */
	softMs: number;
	/** Absolute wall-clock backstop; the run is stopped and partial output salvaged. */
	hardMs: number;
}

export function readResearchWatchdogSettings(
	cwd: string,
	agentDir?: string,
): ResearchWatchdogSettings {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const read = (key: string, fallback: number): number =>
		positive(
			getConfigNumber(merged, NAME, `research.${key}`, fallback),
			fallback,
		);
	return {
		stallMs: read("stallMs", 120_000),
		softMs: read("softMs", 240_000),
		hardMs: read("hardMs", 600_000),
	};
}

// ---- Child extension passthrough ---------------------------------------------

/**
 * Extension/package paths that maestro children (research subagents, workers)
 * load via `-e` despite spawning with `-ne`. Children isolate extensions
 * because global ones collide with maestro's tool names — but that also
 * suppresses tool-less infra extensions like custom model providers, without
 * which a child can't resolve models such as `radicalai/...`. Toggled in the
 * /maestro menu; stored at `extensionConfig.modes.childExtensions`.
 */
export function readChildExtensions(cwd: string, agentDir?: string): string[] {
	if (!cwd) return [];
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const paths = getConfigStringArray(merged, NAME, "childExtensions", []);
	// A vanished path would make every child die at startup — drop it.
	return paths.filter((p) => existsSync(p));
}

// ---- Execution policy -------------------------------------------------------

export type ExecutionPolicyPreset = "guided" | "strict" | "permissive";
export type IsolationTier = "lightweight" | "strong" | "none";

export interface ExecutionPolicySettings {
	preset: ExecutionPolicyPreset | "custom";
	toolGuidance: "mode-aware" | "advisory" | "off";
	modeRoutes: "protected-research" | "direct";
	isolation: IsolationTier;
	delivery: "dedicated-tools";
	consequential: "confirm" | "confirm-mutations" | "allow";
	privilegedRemote: "hack-only" | "confirm" | "deny";
	githubReads: "allow-apparent-reads" | "confirm";
	unknowns: "isolate" | "confirm" | "deny";
	fallback: "fail-closed" | "confirm";
}

const POLICY_PRESETS: Record<
	ExecutionPolicyPreset,
	Omit<ExecutionPolicySettings, "preset">
> = {
	guided: {
		toolGuidance: "mode-aware",
		modeRoutes: "protected-research",
		isolation: "lightweight",
		delivery: "dedicated-tools",
		consequential: "confirm",
		privilegedRemote: "hack-only",
		githubReads: "allow-apparent-reads",
		unknowns: "isolate",
		fallback: "fail-closed",
	},
	strict: {
		toolGuidance: "mode-aware",
		modeRoutes: "protected-research",
		isolation: "strong",
		delivery: "dedicated-tools",
		consequential: "confirm-mutations",
		privilegedRemote: "confirm",
		githubReads: "confirm",
		unknowns: "deny",
		fallback: "fail-closed",
	},
	permissive: {
		toolGuidance: "advisory",
		modeRoutes: "direct",
		isolation: "none",
		delivery: "dedicated-tools",
		consequential: "allow",
		privilegedRemote: "hack-only",
		githubReads: "allow-apparent-reads",
		unknowns: "confirm",
		fallback: "confirm",
	},
};

function choice<T extends string>(
	raw: unknown,
	allowed: readonly T[],
	fallback: T,
): T {
	return typeof raw === "string" && allowed.includes(raw as T)
		? (raw as T)
		: fallback;
}

/** Validated layered policy. Invalid values fall back to the selected preset. */
export function readExecutionPolicySettings(
	cwd: string,
	agentDir?: string,
): ExecutionPolicySettings {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const config = merged.modes;
	const preset = choice(
		readPath(config, "execution.preset"),
		["guided", "strict", "permissive"] as const,
		"guided",
	);
	const defaults = POLICY_PRESETS[preset];
	const read = <T extends string>(
		key: string,
		allowed: readonly T[],
		fallback: T,
	) => choice(readPath(config, `execution.${key}`), allowed, fallback);
	const resolved = {
		toolGuidance: read(
			"toolGuidance",
			["mode-aware", "advisory", "off"],
			defaults.toolGuidance,
		),
		modeRoutes: read(
			"modeRoutes",
			["protected-research", "direct"],
			defaults.modeRoutes,
		),
		isolation: read(
			"isolation",
			["lightweight", "strong", "none"],
			defaults.isolation,
		),
		delivery: read("delivery", ["dedicated-tools"], defaults.delivery),
		consequential: read(
			"consequential",
			["confirm", "confirm-mutations", "allow"],
			defaults.consequential,
		),
		privilegedRemote: read(
			"privilegedRemote",
			["hack-only", "confirm", "deny"],
			defaults.privilegedRemote,
		),
		githubReads: read(
			"githubReads",
			["allow-apparent-reads", "confirm"],
			defaults.githubReads,
		),
		unknowns: read(
			"unknowns",
			["isolate", "confirm", "deny"],
			defaults.unknowns,
		),
		fallback: read("fallback", ["fail-closed", "confirm"], defaults.fallback),
	};
	const custom = Object.keys(resolved).some((key) => {
		const raw = readPath(config, `execution.${key}`);
		return raw !== undefined && raw === resolved[key as keyof typeof resolved];
	});
	return { preset: custom ? "custom" : preset, ...resolved };
}

export interface ExecutionLifecycleSettings {
	stopGraceMs: number;
}

/** Fleet-wide cooperative shutdown grace, bounded to avoid infinite teardown. */
export function readExecutionLifecycleSettings(
	cwd: string,
	agentDir?: string,
): ExecutionLifecycleSettings {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const raw = getConfigNumber(merged, NAME, "execution.stopGraceMs", 5000);
	return {
		stopGraceMs:
			Number.isFinite(raw) && raw >= 0 && raw <= 60_000 ? raw : 5000,
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
