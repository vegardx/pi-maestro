// Typed settings for modes-owned compaction and budget telemetry. Read fresh
// so project-level overrides take effect without restarting the session. All
// knobs live under `extensionConfig.modes.compaction`. These are independent
// of pi's native `compaction.*` and of `extensionConfig.smart-compact.*`.

import { existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRole, ThinkingLevel } from "@vegardx/pi-contracts";
import {
	type ResolvedRoleModelFull,
	resolveRolePool,
} from "@vegardx/pi-models";
import {
	getConfigNumber,
	getConfigString,
	getConfigStringArray,
	readLayeredExtensionConfig,
} from "@vegardx/pi-settings";

const NAME = "modes";
const SECTION = "compaction";

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
		workingTokens: read("workingTokens", 150000),
		summaryTokens: read("summaryTokens", 100000),
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

export interface ImplementOverrides {
	agentModel?: string;
	agentThinking?: ThinkingLevel;
}

let implementOverrides: ImplementOverrides | undefined;

export function setImplementOverrides(
	value: ImplementOverrides | undefined,
): void {
	implementOverrides = value;
}

export function getImplementOverrides(): ImplementOverrides | undefined {
	return implementOverrides;
}

// ---- Internal role resolver ------------------------------------------------

/** Internal operations never self-select alternates; policy defaults only. */
export async function resolveInternalRoleModel(
	ctx: ExtensionContext,
	role: Extract<ModelRole, "classifier" | "plan-summarizer" | "verifier">,
	options?: { requireApiKey?: boolean },
): Promise<ResolvedRoleModelFull> {
	const resolution = await resolveRolePool(ctx, {
		role,
		requireApiKey: options?.requireApiKey,
	});
	if (!resolution.selected) {
		throw new Error(
			`No policy-compatible ${role} model resolved: ${resolution.errors.map((item) => item.message).join("; ") || "no model available"}`,
		);
	}
	return resolution.selected;
}
