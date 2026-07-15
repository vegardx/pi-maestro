// Run state machine. Single source of truth for which RunStatus transitions
// are legal and which runs may never be pruned. Pure — no IO.

import type { RunStatus, TerminalRunStatus } from "@vegardx/pi-contracts";

const TERMINAL: ReadonlySet<RunStatus> = new Set<TerminalRunStatus>([
	"succeeded",
	"failed",
	"stopped",
	"canceled",
	"timed-out",
]);

// Allowed forward transitions. Monotonic: a run starts queued, acquires its
// slot and transport (starting), runs (may block and resume), may enter
// interrupting exactly once, and settles in exactly one terminal state.
// Terminal states have no exits — settle-once is enforced here, not by
// caller discipline. "running" straight from queued stays legal for runners
// that have no distinct startup phase (fakes, remote transports).
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
	queued: ["starting", "running", "failed", "stopped", "canceled", "timed-out"],
	starting: [
		"running",
		"interrupting",
		"failed",
		"stopped",
		"canceled",
		"timed-out",
	],
	running: [
		"blocked",
		"interrupting",
		"succeeded",
		"failed",
		"stopped",
		"canceled",
		"timed-out",
	],
	blocked: [
		"running",
		"interrupting",
		"failed",
		"stopped",
		"canceled",
		"timed-out",
	],
	// An interrupt can lose the race to a natural finish or a child death —
	// any terminal state may follow, but nothing non-terminal ever does.
	interrupting: ["succeeded", "failed", "stopped", "canceled", "timed-out"],
	succeeded: [],
	failed: [],
	stopped: [],
	canceled: [],
	"timed-out": [],
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
