// Retention/GC for run artifacts. Defaults: keep the most recent maxRuns per
// repo, drop runs older than maxAgeDays, cap each event log at eventLogCapBytes
// (head/tail truncation). Active runs (queued/running/blocked) are NEVER pruned
// or truncated. Pruning is meant to run on session_start.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunId } from "@vegardx/pi-contracts";
import { isActive } from "./state-machine.js";
import type { RunStore } from "./store.js";

export interface RetentionPolicy {
	readonly maxRuns: number;
	readonly maxAgeDays: number;
	readonly eventLogCapBytes: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
	maxRuns: 50,
	maxAgeDays: 14,
	eventLogCapBytes: 5 * 1024 * 1024,
};

export interface PruneResult {
	readonly pruned: RunId[];
	readonly truncated: RunId[];
}

export function pruneRuns(
	store: RunStore,
	policy: RetentionPolicy = DEFAULT_RETENTION,
	now: number = Date.now(),
): PruneResult {
	const records = store.list();
	const prunable = records.filter((r) => !isActive(r.status));
	// Newest first — index >= maxRuns are over the cap.
	prunable.sort((a, b) => b.updatedAt - a.updatedAt);

	const cutoff = now - policy.maxAgeDays * 24 * 60 * 60 * 1000;
	const pruned: RunId[] = [];

	for (let i = 0; i < prunable.length; i++) {
		const record = prunable[i];
		const overCap = i >= policy.maxRuns;
		const tooOld = record.updatedAt < cutoff;
		if (overCap || tooOld) {
			store.remove(record.id);
			pruned.push(record.id);
		}
	}

	const truncated: RunId[] = [];
	for (const record of records) {
		if (pruned.includes(record.id) || isActive(record.status)) continue;
		if (capEventLog(store, record.id, policy.eventLogCapBytes)) {
			truncated.push(record.id);
		}
	}

	return { pruned, truncated };
}

/**
 * Trim an oversized event log to a head+tail window with a marker line in the
 * middle, preserving whole lines. Returns true when it truncated.
 */
function capEventLog(store: RunStore, runId: RunId, capBytes: number): boolean {
	const path = join(store.root, runId, "events.jsonl");
	if (!existsSync(path)) return false;
	if (statSync(path).size <= capBytes) return false;

	const raw = readFileSync(path, "utf8");
	const half = Math.floor(capBytes / 2);
	const head = raw.slice(0, half);
	const tail = raw.slice(raw.length - half);
	const headLines = head.slice(0, head.lastIndexOf("\n") + 1);
	const tailLines = tail.slice(tail.indexOf("\n") + 1);
	const marker = `{"type":"_truncated","note":"event log capped at ${capBytes} bytes"}\n`;
	writeFileSync(path, `${headLines}${marker}${tailLines}`);
	return true;
}
