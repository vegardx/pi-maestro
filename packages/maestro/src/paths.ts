// Where maestro keeps things.
//
// Plans and sessions hang off pi's own agent directory, so a sandboxed session
// — one with its own `PI_CODING_AGENT_DIR` — keeps them beside its own config
// rather than in the host's. That is what makes an e2e run genuinely isolated
// instead of nearly isolated.
//
// The socket is the exception, and `socketPath` says why.

import { tmpdir } from "node:os";
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
 * A Unix socket path is a fixed-size field in a struct, not a string. macOS
 * gives it 104 bytes and Linux 108, and going over does not truncate — `listen`
 * fails with EINVAL, which reads like nothing to do with length.
 */
const SUN_PATH_MAX = 100;

/**
 * The socket a session's workers dial.
 *
 * Under the system temp directory rather than the agent directory, and this is
 * the one place isolation loses an argument: an isolated agent dir is nested
 * deep enough that the path overruns `sun_path`, and the failure is an EINVAL
 * that names no length. A socket is ephemeral runtime state rather than
 * configuration, and it is the run TOKEN — not the path — that stops a worker
 * talking to the wrong maestro. So the path only has to be unique, and the pid
 * makes it unique.
 */
export function socketPath(pid: number = process.pid): string {
	const path = join(tmpdir(), `pi-maestro-${pid}.sock`);
	if (Buffer.byteLength(path) > SUN_PATH_MAX)
		throw new Error(
			`socket path is ${Buffer.byteLength(path)} bytes and the limit is ${SUN_PATH_MAX}: ${path}`,
		);
	return path;
}

/** Where a worker's pi session file lives, so a restarted maestro can re-attach. */
export function sessionFile(
	slug: string,
	deliverableId: string,
	agentDir?: string,
): string {
	return join(plansRoot(agentDir), slug, "sessions", `${deliverableId}.jsonl`);
}
