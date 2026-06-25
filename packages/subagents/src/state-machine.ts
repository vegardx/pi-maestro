// Run state machine. Single source of truth for which RunStatus transitions
// are legal and which runs may never be pruned. Pure — no IO.

import type { RunStatus, TerminalRunStatus } from "@vegardx/pi-contracts";

const TERMINAL: ReadonlySet<RunStatus> = new Set<TerminalRunStatus>([
	"succeeded",
	"failed",
	"stopped",
	"canceled",
]);

// Allowed forward transitions. A run starts queued, runs, may block and
// resume, and settles in exactly one terminal state.
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
	queued: ["running", "stopped", "canceled"],
	running: ["blocked", "succeeded", "failed", "stopped", "canceled"],
	blocked: ["running", "failed", "stopped", "canceled"],
	succeeded: [],
	failed: [],
	stopped: [],
	canceled: [],
};

export function isTerminal(status: RunStatus): boolean {
	return TERMINAL.has(status);
}

/** A run that is still alive — must never be pruned by retention. */
export function isActive(status: RunStatus): boolean {
	return !TERMINAL.has(status);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
	return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throwing variant for the store, which must reject illegal transitions. */
export function assertTransition(from: RunStatus, to: RunStatus): void {
	if (from === to) return;
	if (!canTransition(from, to)) {
		throw new Error(`illegal run transition: ${from} → ${to}`);
	}
}
