// The ONE definition of "this agent is still live".
//
// Liveness has exactly one honest meaning: a process exists that a bounded stop
// would have to shut down. `prepareStop` is the authority — it kills everything
// in this set — so every guard that asks "would this abandon running work?" must
// use the SAME set, or it will wave through work the stop then destroys.
//
// Before this module there were four copies with two different answers: the
// posture guards checked only `working|summarizing`, while prepareStop and
// /recover also counted `spawning|restarting`. A worker mid-spawn was therefore
// invisible to the guard and killed anyway.
//
// Note what is NOT liveness: `ModesState.execution.stage`. Nothing clears the
// stage when a plan settles (onAllSettled only flips the mode), so it reads
// "executing" long after the last agent is gone. Ask the executor, never the
// stage.

import type { ExecutionHandle } from "../exec/index.js";
import type { NodeAgentStatus } from "./node-executor.js";

/**
 * Statuses that mean a live process is attached. `pending` is parked (blocked,
 * awaiting resume), `done`/`failed` are terminal — none of them are live.
 */
export const LIVE_AGENT_STATUSES: readonly NodeAgentStatus[] = [
	"spawning",
	"working",
	"summarizing",
	"restarting",
];

/**
 * Is this status live? Takes a plain `string` because snapshots widen the enum
 * (`ExecutionAgentSnapshot.status`); unknown values are treated as not live.
 */
export function isLiveAgentStatus(status: string): boolean {
	return (LIVE_AGENT_STATUSES as readonly string[]).includes(status);
}

/**
 * Keys of every live agent in the execution snapshot — the predicate the
 * operator-facing guards use ("N worker(s) are running; stop them?"). Returns
 * empty when no adapter exists, which is the honest answer: nothing is running.
 */
export function liveAgentKeys(
	execution: Pick<ExecutionHandle, "snapshot"> | undefined,
): string[] {
	const snap = execution?.snapshot();
	if (!snap) return [];
	return [...snap.agents.entries()]
		.filter(([, agent]) => isLiveAgentStatus(agent.status))
		.map(([key]) => key);
}
