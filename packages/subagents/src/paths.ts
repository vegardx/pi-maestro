// Where run artifacts live: <agentDir>/maestro/runs/<repo>. agentDir honours
// PI_CODING_AGENT_DIR / XDG via the host's getAgentDir; repo scoping keeps one
// project's runs from colliding with another's.

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { repoNameFromPath } from "@vegardx/pi-git";

export function runsRoot(
	cwd: string,
	agentDir: string = getAgentDir(),
): string {
	const repo = repoNameFromPath(cwd) ?? "_norepo";
	return join(agentDir, "maestro", "runs", repo);
}
