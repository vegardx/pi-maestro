// Where maestro keeps things.
//
// Everything hangs off pi's own agent directory, so a sandboxed session — one
// with its own `PI_CODING_AGENT_DIR` — keeps its plans, sessions and sockets
// beside its own config rather than in the host's. That is what makes an e2e
// run genuinely isolated instead of nearly isolated.

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function maestroRoot(agentDir: string = getAgentDir()): string {
	return join(agentDir, "maestro");
}

/** `<agentDir>/maestro/plans/<slug>/{plan,run}.json` */
export function plansRoot(agentDir?: string): string {
	return join(maestroRoot(agentDir), "plans");
}

/**
 * The socket a session's workers dial.
 *
 * Named for the process, not the plan. Two maestros on one machine must not
 * collide, and a session outlives any one plan it runs — while the run token
 * is what stops a worker from talking to the wrong maestro even if a path is
 * somehow reused.
 */
export function socketPath(
	pid: number = process.pid,
	agentDir?: string,
): string {
	return join(maestroRoot(agentDir), "run", `maestro-${pid}.sock`);
}

/** Where a worker's pi session file lives, so a restarted maestro can re-attach. */
export function sessionFile(
	slug: string,
	deliverableId: string,
	agentDir?: string,
): string {
	return join(plansRoot(agentDir), slug, "sessions", `${deliverableId}.jsonl`);
}
