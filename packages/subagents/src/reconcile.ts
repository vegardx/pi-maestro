// Orphan reconciler — cross-process GC for run records stuck in active states.
//
// Supervision is process-local: the spawning process owns the watchdogs and
// pending RPC maps. When an intermediate agent dies, its child runs keep
// running with records stuck non-terminal and live tmux sessions — and
// retention never prunes active runs, so nobody ever reaps them. This runs at
// extension startup, before the retention prune, and settles provably
// orphaned runs failed.
//
// Conservative by design: a run whose recorded process group is ALIVE is
// never an orphan — not even under a terminal parent — because the owning
// supervisor may be mid-cleanup. A run with no process facts at all is reaped
// only once its record has gone stale, so a supervisor that announced a run
// but has not yet published pid/session metadata keeps it.

import { spawnSync } from "node:child_process";
import type { RunId, RunRecord } from "@vegardx/pi-contracts";
import { isTerminal } from "./state-machine.js";
import type { RunStore } from "./store.js";

/** No-owner grace: only records this stale with no process facts are reaped. */
const DEFAULT_STALE_MS = 10 * 60 * 1000;

export interface ReconcileOptions {
	readonly now?: number;
	/** Age past which an ownerless (no processGroup/pid) record is orphaned. */
	readonly staleMs?: number;
	/** Signal-0 liveness probe. EPERM (alive, not ours) must report true. */
	readonly isProcessAlive?: (processGroup: number) => boolean;
	/** Kill a session and VERIFY it gone; true only on verified absence. */
	readonly killTmuxSession?: (session: string) => boolean;
}

export interface ReconcileResult {
	/** Settled failed ("orphaned: <reason>") after verified session death. */
	readonly reaped: RunId[];
	/** Non-terminal runs left alone (live, recent, or unverifiable session). */
	readonly skipped: RunId[];
}

export function reconcileOrphanedRuns(
	store: RunStore,
	opts: ReconcileOptions = {},
): ReconcileResult {
	const now = opts.now ?? Date.now();
	const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
	const isAlive = opts.isProcessAlive ?? isProcessGroupAlive;
	const killSession = opts.killTmuxSession ?? killAndVerifyTmuxSession;

	const reaped: RunId[] = [];
	const skipped: RunId[] = [];

	for (const record of store.list()) {
		if (isTerminal(record.status)) continue;

		const metadata = record.metadata;
		const processGroup = metadata?.processGroup ?? metadata?.pid;
		// A live recorded process group means some process can still act on
		// this run — never an orphan, even if the parent run has settled (its
		// supervisor may be mid-cleanup and about to settle this record).
		if (processGroup !== undefined && isAlive(processGroup)) {
			skipped.push(record.id);
			continue;
		}

		const reason = orphanReason(store, record, processGroup, now, staleMs);
		if (!reason) {
			skipped.push(record.id);
			continue;
		}

		// GC order matters: session first, record second. The record's
		// tmuxSession field is the only pointer to the session, so settling the
		// record before verified session death would leak the session forever.
		const session = metadata?.tmuxSession;
		if (session && !killSession(session)) {
			skipped.push(record.id);
			continue;
		}

		try {
			store.setResult(
				record.id,
				{ status: "failed", error: `orphaned: ${reason}` },
				now,
			);
			reaped.push(record.id);
		} catch {
			// Lost a settle race with a live supervisor — exactly what the
			// conservatism above exists for; leave the record alone.
			skipped.push(record.id);
		}
	}

	return { reaped, skipped };
}

/**
 * Why a run with no live process group is an orphan, or undefined if it must
 * be kept. Ordered from strongest evidence to weakest: a terminal parent run
 * means the supervising process (the parent run's child) is gone; a dead
 * recorded process group means the run itself is gone; an ownerless record is
 * orphaned only after the stale grace, since a supervisor may announce a run
 * before publishing its process facts.
 */
function orphanReason(
	store: RunStore,
	record: RunRecord,
	processGroup: number | undefined,
	now: number,
	staleMs: number,
): string | undefined {
	const parentId = record.parent ?? record.metadata?.parent;
	if (parentId) {
		const parent = store.readRecord(parentId);
		if (parent && isTerminal(parent.status)) {
			return `parent run ${parentId} is terminal (${parent.status})`;
		}
	}
	if (processGroup !== undefined) {
		return `process group ${processGroup} is dead`;
	}
	if (now - record.updatedAt >= staleMs) {
		return `no owning process and record stale for ${now - record.updatedAt}ms`;
	}
	return undefined;
}

/**
 * Default liveness probe: signal-0 to the process group, falling back to the
 * bare pid (metadata may record a pid that never became a group leader).
 * EPERM means the process exists but is not ours to signal — alive.
 */
function isProcessGroupAlive(processGroup: number): boolean {
	for (const target of [-processGroup, processGroup]) {
		try {
			process.kill(target, 0);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
		}
	}
	return false;
}

/**
 * Kill a run's tmux session and verify it is gone. Returns true only on
 * verified absence — retention and the reconciler keep the run record
 * otherwise, so the session pointer is never lost while the session might
 * still exist.
 */
export function killAndVerifyTmuxSession(session: string): boolean {
	const tmux = (args: string[]) =>
		spawnSync("tmux", args, { stdio: "ignore", timeout: 5_000 });
	const probe = tmux(["has-session", "-t", session]);
	// tmux not installed / server not running / session gone: verified absent.
	if (probe.error || probe.status !== 0) return true;
	tmux(["kill-session", "-t", session]);
	const after = tmux(["has-session", "-t", session]);
	return Boolean(after.error) || after.status !== 0;
}
