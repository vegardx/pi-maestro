// Mirror a RunBus into a RunStore: every message is appended to events.jsonl,
// and status/result/spawn messages keep the RunRecord in sync. Returns a
// disposer that detaches the mirror.

import type { RunBusMessage, RunRecord } from "@vegardx/pi-contracts";
import type { RunBus } from "./bus.js";
import { msgRunId } from "./bus.js";
import type { RunStore } from "./store.js";

export function persistRunBus(bus: RunBus, store: RunStore): () => void {
	return bus.subscribe((message: RunBusMessage) => {
		const runId = msgRunId(message);
		if (runId) store.appendEvent(runId, message);

		switch (message.type) {
			case "spawn": {
				const now = Date.now();
				const record: RunRecord = {
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
					store.setStatus(message.runId, message.status, message.at);
				}
				break;
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
