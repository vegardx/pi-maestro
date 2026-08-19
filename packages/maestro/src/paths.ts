import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function maestroRoot(agentDir: string = getAgentDir()): string {
	return join(agentDir, "maestro");
}

/** `<agentDir>/maestro/plans/<slug>/plan.json` */
export function plansRoot(agentDir?: string): string {
	return join(maestroRoot(agentDir), "plans");
}
