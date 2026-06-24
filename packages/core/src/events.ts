// Typed event bus — a thin, type-safe wrapper over pi's string-channel
// EventBus (pi.events). Names and payloads come from @vegardx/pi-contracts,
// so publishers and subscribers share one checked vocabulary. The host owns
// the underlying bus lifecycle (cleared on session shutdown).

import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { EventName, EventPayload } from "@vegardx/pi-contracts";

export interface TypedEventBus {
	emit<E extends EventName>(name: E, payload: EventPayload<E>): void;
	on<E extends EventName>(
		name: E,
		handler: (payload: EventPayload<E>) => void,
	): () => void;
}

export function createTypedEventBus(bus: EventBus): TypedEventBus {
	return {
		emit: (name, payload) => bus.emit(name, payload),
		on: (name, handler) =>
			bus.on(name, (data) => handler(data as EventPayload<typeof name>)),
	};
}
