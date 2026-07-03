// Typed settings for modes-owned compaction and budget telemetry. Read fresh
// so project-level overrides take effect without restarting the session. All
// knobs live under `extensionConfig.modes.compaction`. These are independent
// of pi's native `compaction.*` and of `extensionConfig.smart-compact.*`.

import {
	getConfigNumber,
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
	get workerModel(): string | undefined {
		return process.env.MAESTRO_WORKER_MODEL || undefined;
	},
	get lensModel(): string | undefined {
		return process.env.MAESTRO_LENS_MODEL || undefined;
	},
	get classifierModel(): string | undefined {
		return process.env.MAESTRO_CLASSIFIER_MODEL || undefined;
	},
	get maxReviewCycles(): number {
		return Number(process.env.MAESTRO_MAX_REVIEW_CYCLES) || 2;
	},
	get maxWorkers(): number | undefined {
		const v = Number(process.env.MAESTRO_MAX_WORKERS);
		return Number.isFinite(v) && v > 0 ? v : undefined;
	},
	get lensDisabled(): boolean {
		return process.env.MAESTRO_LENS_DISABLED === "1";
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

const DEFAULT_MAX_WORKERS = 4;

/**
 * Read the max parallel workers setting.
 * Priority: MAESTRO_MAX_WORKERS env → extensionConfig.modes.maxWorkers → 4.
 */
export function readMaxWorkers(cwd: string, agentDir?: string): number {
	const envVal = MAESTRO_ENV.maxWorkers;
	if (envVal !== undefined) return envVal;
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const configured = getConfigNumber(
		merged,
		NAME,
		"maxWorkers",
		DEFAULT_MAX_WORKERS,
	);
	return positive(configured, DEFAULT_MAX_WORKERS);
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
