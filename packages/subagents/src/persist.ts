// Mirror a RunBus into a RunStore: every message is appended to events.jsonl,
// and status/result/spawn messages keep the RunRecord in sync. Returns a
// disposer that detaches the mirror.

import {
	RUN_RECORD_SCHEMA_VERSION,
	type RunBusMessage,
	type RunId,
	type RunRecord,
} from "@vegardx/pi-contracts";
import type { RunBus } from "./bus.js";
import { msgRunId } from "./bus.js";
import type { RunStore } from "./store.js";

/** Floor between lastEventAt persists per run — the field feeds staleness
 *  displays, so second-granularity is plenty; per-message it was an atomic
 *  status.json rewrite for every tool start across every parallel run. */
const LAST_EVENT_WRITE_FLOOR_MS = 5_000;

export function persistRunBus(bus: RunBus, store: RunStore): () => void {
	const lastEventWrites = new Map<RunId, number>();
	return bus.subscribe((message: RunBusMessage) => {
		const runId = msgRunId(message);
		if (runId) store.appendEvent(runId, message);

		switch (message.type) {
			case "spawn": {
				const now = Date.now();
				const record: RunRecord = {
					schemaVersion: RUN_RECORD_SCHEMA_VERSION,
					id: message.run.id,
					parent: message.run.parent,
					profile: message.run.profile,
					status: "queued",
					createdAt: now,
					updatedAt: now,
				};
				store.create(record);
				break;
			}
			case "status":
				if (store.readRecord(message.runId)) {
					try {
						store.setStatus(message.runId, message.status, message.at);
					} catch {
						// A status arriving after the run settled (e.g. an interrupt
						// losing the race to a natural finish) is a no-op, not a
						// crash — terminal states never regress.
					}
				}
				break;
			case "metadata": {
				const current = store.readRecord(message.runId)?.metadata;
				if (store.readRecord(message.runId)) {
					store.setMetadata(message.runId, {
						...current,
						...message.metadata,
					});
				}
				break;
			}
			case "agentEvent":
			case "progress": {
				const now = Date.now();
				const lastWrite = lastEventWrites.get(message.runId) ?? 0;
				if (
					now - lastWrite >= LAST_EVENT_WRITE_FLOOR_MS &&
					store.readRecord(message.runId)
				) {
					lastEventWrites.set(message.runId, now);
					store.setLastEventAt(message.runId, now);
				}
				break;
			}
			case "result":
				if (store.readRecord(message.runId)) {
					store.setResult(message.runId, message.result);
					if (message.result.summary) {
						store.writeResult(message.runId, message.result.summary);
					}
				}
				break;
		}
	});
}
