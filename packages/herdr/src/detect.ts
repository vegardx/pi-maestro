// Detection: is herdr available in this environment?

import { existsSync } from "node:fs";
import { resolveSocketPath } from "./events.js";

/**
 * Check whether herdr is available for multi-agent orchestration.
 * Returns true when HERDR_ENV=1 and the socket path exists.
 */
export function isHerdrAvailable(): boolean {
	if (process.env.HERDR_ENV !== "1") return false;
	const socketPath = resolveSocketPath();
	return socketPath !== undefined && existsSync(socketPath);
}
