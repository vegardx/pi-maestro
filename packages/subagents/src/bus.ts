// RunBus — the in-process transport for run-bus messages. Producers publish;
// subscribers receive every message after they subscribe. A bounded ring of
// recent messages supports late subscribers replaying what they missed.
// Cross-process coordination (background agents) replays from the store's
// events.jsonl, not this in-memory buffer.

import type { RunBusMessage, RunId } from "@vegardx/pi-contracts";

export type RunBusHandler = (message: RunBusMessage) => void;

export interface RunBus {
	publish(message: RunBusMessage): void;
	subscribe(handler: RunBusHandler): () => void;
	/** Recent messages, optionally filtered to one run. */
	replay(runId?: RunId): RunBusMessage[];
}

const DEFAULT_RING = 1000;

export function createRunBus(ringSize = DEFAULT_RING): RunBus {
	const handlers = new Set<RunBusHandler>();
	// Circular buffer — shift() on a full array was O(ringSize) per publish,
	// which multiplies across every event of every parallel run.
	const ring: RunBusMessage[] = new Array(ringSize);
	let head = 0; // next write slot
	let count = 0;

	return {
		publish(message) {
			ring[head] = message;
			head = (head + 1) % ringSize;
			if (count < ringSize) count += 1;
			// Snapshot so a handler that (un)subscribes mid-dispatch is safe.
			for (const handler of [...handlers]) handler(message);
		},
		subscribe(handler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		replay(runId) {
			const start = (head - count + ringSize) % ringSize;
			const ordered: RunBusMessage[] = [];
			for (let i = 0; i < count; i++) {
				ordered.push(ring[(start + i) % ringSize]);
			}
			return runId ? ordered.filter((m) => msgRunId(m) === runId) : ordered;
		},
	};
}

/** The runId a message concerns, or undefined for run-less messages. */
export function msgRunId(message: RunBusMessage): RunId | undefined {
	return message.type === "spawn" ? message.run.id : message.runId;
}
