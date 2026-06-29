// Event bus vocabulary. Names are namespaced under "maestro." and mapped to
// typed payloads. Emitters/subscribers live in @vegardx/pi-core; this is the
// shared contract so any module can publish or listen with type safety.

import type { DeliverableId, PlanId } from "./ids.js";
import type { ModeName } from "./modes.js";

export const EVENTS = {
	modeChanged: "maestro.mode.changed",
	planUpdated: "maestro.plan.updated",
	shipCompleted: "maestro.ship.completed",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export interface EventPayloads {
	[EVENTS.modeChanged]: {
		readonly mode: ModeName;
		readonly previous: ModeName;
	};
	[EVENTS.planUpdated]: { readonly planId: PlanId };
	[EVENTS.shipCompleted]: {
		readonly deliverableId: DeliverableId;
		readonly pr?: number;
	};
}

export type EventPayload<E extends EventName> = EventPayloads[E];
