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

export function readSmartCompactSettings(
	cwd: string,
	agentDir?: string,
): SmartCompactSettings {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const compactAtRaw = getConfigNumber(merged, NAME, "compactAt", 0);
	return {
		maxSummaryTokens: getConfigNumber(merged, NAME, "maxSummaryTokens", 8192),
		maxFileListEntries: getConfigNumber(merged, NAME, "maxFileListEntries", 50),
		compactAt: compactAtRaw > 0 ? compactAtRaw : undefined,
		timeoutMs: getConfigNumber(merged, NAME, "timeoutMs", 60000),
	};
}
