// Event bus vocabulary. Names are namespaced under "maestro." and mapped to
// typed payloads. Emitters/subscribers live in @vegardx/pi-core; this is the
// shared contract so any module can publish or listen with type safety.

import type { DeliverableId, PlanId, RunId } from "./ids.js";
import type { ModeName } from "./modes.js";
import type {
	RunProgress,
	RunStatus,
	SupervisorDecisionRequest,
} from "./runs.js";

export const EVENTS = {
	modeChanged: "maestro.mode.changed",
	runStatus: "maestro.run.status",
	runProgress: "maestro.run.progress",
	runAgentEvent: "maestro.run.agentEvent",
	supervisorNeedDecision: "maestro.supervisor.needDecision",
	planUpdated: "maestro.plan.updated",
	shipCompleted: "maestro.ship.completed",
	askChanged: "maestro.ask.changed",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export interface EventPayloads {
	[EVENTS.modeChanged]: {
		readonly mode: ModeName;
		readonly previous: ModeName;
	};
	[EVENTS.runStatus]: { readonly runId: RunId; readonly status: RunStatus };
	[EVENTS.runProgress]: {
		readonly runId: RunId;
		readonly progress: RunProgress;
	};
	[EVENTS.runAgentEvent]: {
		readonly runId: RunId;
		readonly event: unknown;
	};
	[EVENTS.supervisorNeedDecision]: {
		readonly runId: RunId;
		readonly request: SupervisorDecisionRequest;
	};
	[EVENTS.planUpdated]: { readonly planId: PlanId };
	[EVENTS.shipCompleted]: {
		readonly deliverableId: DeliverableId;
		readonly pr?: number;
	};
	/** The ask engine's pending set changed (post/raise/settle/defer). */
	[EVENTS.askChanged]: {
		readonly pending: number;
		readonly blocking: number;
	};
}

export type EventPayload<E extends EventName> = EventPayloads[E];
