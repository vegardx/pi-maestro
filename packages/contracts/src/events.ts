// Typed Maestro event vocabulary.

import type { AgentKind, ResolvedAgentAssignment } from "./agents.js";
import type { DeliverableId, PlanId, RunId } from "./ids.js";
import type { ExecutionStage, ModeName, WorkflowStage } from "./modes.js";
import type {
	DeliveryFailure,
	StructuredFinding,
	TransitionGate,
} from "./plan.js";
import type {
	RunProgress,
	RunStatus,
	StopRecord,
	SupervisorDecisionRequest,
} from "./runs.js";
import type { UsageCheckpoint } from "./usage.js";

export const EVENTS = {
	modeChanged: "maestro.mode.changed",
	executionStageChanged: "maestro.execution.stageChanged",
	agentAssigned: "maestro.agent.assigned",
	runStatus: "maestro.run.status",
	runProgress: "maestro.run.progress",
	runStopped: "maestro.run.stopped",
	runAgentEvent: "maestro.run.agentEvent",
	usageCheckpoint: "maestro.usage.checkpoint",
	supervisorNeedDecision: "maestro.supervisor.needDecision",
	planUpdated: "maestro.plan.updated",
	deliveryFailed: "maestro.delivery.failed",
	gateChanged: "maestro.gate.changed",
	findingRecorded: "maestro.finding.recorded",
	shipCompleted: "maestro.ship.completed",
	askChanged: "maestro.ask.changed",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export interface EventPayloads {
	[EVENTS.modeChanged]: {
		readonly mode: ModeName;
		readonly previous: ModeName;
	};
	[EVENTS.executionStageChanged]: {
		readonly previous: ExecutionStage;
		readonly stage: ExecutionStage;
		readonly workflowStage?: WorkflowStage;
		readonly deliverableId?: DeliverableId;
	};
	[EVENTS.agentAssigned]: {
		readonly agentId: string;
		readonly kind: AgentKind;
		readonly assignment: ResolvedAgentAssignment;
	};
	[EVENTS.runStatus]: {
		readonly runId: RunId;
		readonly status: RunStatus;
		readonly completedAt?: number;
	};
	[EVENTS.runProgress]: {
		readonly runId: RunId;
		readonly progress: RunProgress;
	};
	[EVENTS.runStopped]: { readonly runId: RunId; readonly stop: StopRecord };
	[EVENTS.runAgentEvent]: { readonly runId: RunId; readonly event: unknown };
	[EVENTS.usageCheckpoint]: UsageCheckpoint;
	[EVENTS.supervisorNeedDecision]: {
		readonly runId: RunId;
		readonly request: SupervisorDecisionRequest;
	};
	[EVENTS.planUpdated]: { readonly planId: PlanId };
	[EVENTS.deliveryFailed]: {
		readonly deliverableId: DeliverableId;
		readonly failure: DeliveryFailure;
	};
	[EVENTS.gateChanged]: {
		readonly deliverableId: DeliverableId;
		readonly gate: TransitionGate;
	};
	[EVENTS.findingRecorded]: {
		readonly deliverableId: DeliverableId;
		readonly finding: StructuredFinding;
	};
	[EVENTS.shipCompleted]: {
		readonly deliverableId: DeliverableId;
		readonly pr?: number;
	};
	[EVENTS.askChanged]: { readonly pending: number; readonly blocking: number };
}

export type EventPayload<E extends EventName> = EventPayloads[E];
