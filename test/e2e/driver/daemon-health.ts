// The two silent failures a long drive can suffer, and their remedies.
//
// A drive can die (the process exits — see launch.ts `died()`), or it can WEDGE
// (the process lives but blocks forever on a dead socket, a sleep-dropped
// connection with no timeout). One real drive spent 87 minutes wedged, reporting
// `isStreaming: true` the whole time. This module owns both the detection of the
// second kind and the macOS wake-lock that prevents its most common cause.

import { spawn } from "node:child_process";
import type { LaunchedSut } from "./launch.js";

// A live SUT that hasn't produced a model/tool event in this long while still
// "streaming" is wedged, not working. Advisory: reported with the actual age so
// the driver judges severity — a real wedge is tens of minutes, far past any
// legitimate generation gap.
export const STALL_MS = Number(process.env.PI_E2E_STALL_MS) || 180_000;

export interface StallSignal {
	readonly sinceMs: number;
	readonly thresholdMs: number;
}

/**
 * Keep the system awake for the life of the daemon, without touching the lock.
 *
 * `-i` blocks idle SYSTEM sleep only — the display still sleeps and the screen
 * still locks on its normal schedule (we deliberately never pass `-d`/`-u`,
 * which would defeat auto-lock on a managed device). `-w <pid>` ties the
 * assertion to a process: caffeinate exits when that process does, however it
 * exits — SIGKILL included, since `-w` just waits for the pid to vanish — so the
 * assertion can never leak. This is the cure for what wedged one drive: `pmset`
 * had system idle-sleep at one minute, so an unattended run slept and its
 * Copilot socket died under it. macOS only; a no-op elsewhere.
 *
 * Returns a fast-path release; `-w` already guarantees release on exit.
 */
export function keepSystemAwake(pid: number = process.pid): () => void {
	if (process.platform !== "darwin") return () => {};
	try {
		const child = spawn("caffeinate", ["-i", "-w", String(pid)], {
			stdio: "ignore",
			detached: true,
		});
		child.unref();
		return () => {
			try {
				child.kill();
			} catch {
				// -w already releases when the watched pid exits; this is just faster.
			}
		};
	} catch {
		return () => {};
	}
}

/** Resolve to null rather than hang if a wedged SUT stops answering its RPC. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
	return Promise.race([
		p,
		new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
	]);
}

/**
 * A stall is a LIVE sut, streaming, that hasn't produced an event in STALL_MS.
 * Death dominates (a corpse isn't stalled), and we confirm `isStreaming` so a
 * settled turn waiting for the next prompt is never mistaken for a wedge. The
 * activity clock is driven only by real events — command replies never reach
 * it — so the driver's own polling cannot mask a stall.
 */
export async function detectStall(
	sut: Pick<LaunchedSut, "died" | "sinceLastActivityMs" | "client">,
	stallMs: number = STALL_MS,
): Promise<StallSignal | undefined> {
	if (sut.died()) return undefined;
	const sinceMs = sut.sinceLastActivityMs();
	if (sinceMs < stallMs) return undefined;
	const state = await withTimeout(sut.client.getState(), 5_000);
	if (!state?.isStreaming) return undefined;
	return { sinceMs, thresholdMs: stallMs };
}
