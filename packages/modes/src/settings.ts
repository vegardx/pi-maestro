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
