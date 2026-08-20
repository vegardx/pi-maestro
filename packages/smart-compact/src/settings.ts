// Typed settings for smart-compact. Read on every compaction/turn so
// project-level overrides take effect without restarting the session. All
// knobs live under `extensionConfig.smart-compact`.

import {
	getConfigNumber,
	readLayeredExtensionConfig,
} from "@vegardx/pi-settings";

const NAME = "smart-compact";

export interface SmartCompactSettings {
	/** Max tokens the summariser may emit. */
	maxSummaryTokens: number;
	/** Cap on entries shown per file list so large sessions stay bounded. */
	maxFileListEntries: number;
	/**
	 * Context-token count at which to proactively compact at turn end.
	 * `undefined` (unset / non-positive) leaves proactive compaction off and
	 * relies on pi's native reserveTokens threshold.
	 */
	compactAt: number | undefined;
	/** Hard ceiling for model resolution + the summarisation call. */
	timeoutMs: number;
}

function bounded(
	value: number,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	return value >= minimum && value <= maximum ? Math.floor(value) : fallback;
}

export function readSmartCompactSettings(
	cwd: string,
	agentDir?: string,
): SmartCompactSettings {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const compactAtRaw = getConfigNumber(merged, NAME, "compactAt", 0);
	return {
		maxSummaryTokens: bounded(
			getConfigNumber(merged, NAME, "maxSummaryTokens", 8192),
			8192,
			256,
			100_000,
		),
		maxFileListEntries: bounded(
			getConfigNumber(merged, NAME, "maxFileListEntries", 50),
			50,
			1,
			1_000,
		),
		compactAt: compactAtRaw > 0 ? Math.floor(compactAtRaw) : undefined,
		timeoutMs: bounded(
			getConfigNumber(merged, NAME, "timeoutMs", 60_000),
			60_000,
			1_000,
			600_000,
		),
	};
}
