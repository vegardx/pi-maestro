// Supervisor protocol. A child that hits a decision it can't make alone calls
// the contact_supervisor tool, which publishes a needDecision message on the
// run-bus and returns immediately. The parent (orchestrator) projects
// needDecision: it asks the human (or relays the modes ship gate), then steers
// the child with the answer — which arrives in the child as guidance. The flow
// is asynchronous and cross-process-safe: no blocking RPC round-trip.

import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type {
	RunBusMessage,
	RunId,
	SupervisorDecision,
	SupervisorDecisionRequest,
} from "@vegardx/pi-contracts";
import type { RunBus } from "./bus.js";

/** Env var carrying the child's own run id (set by the runner). */
export const RUN_ID_ENV = "PI_MAESTRO_RUN_ID";

export function needDecisionMessage(
	runId: RunId,
	request: SupervisorDecisionRequest,
): RunBusMessage {
	return { type: "needDecision", runId, request };
}

export interface SupervisorToolOptions {
	/** The child's own run id (typically from PI_MAESTRO_RUN_ID). */
	readonly runId: () => RunId | undefined;
	readonly publish: (message: RunBusMessage) => void;
}

const SupervisorParams = Type.Object({
	question: Type.String({
		description: "The decision you need the supervisor to make.",
	}),
	options: Type.Optional(
		Type.Array(Type.String(), {
			description: "Discrete choices, if the answer is one of a set.",
		}),
	),
	context: Type.Optional(
		Type.String({ description: "Background the supervisor needs." }),
	),
});

/** The child-side contact_supervisor tool. */
export function createSupervisorTool(
	opts: SupervisorToolOptions,
): ToolDefinition {
	return defineTool({
		name: "contact_supervisor",
		label: "Contact supervisor",
		description:
			"Ask the orchestrating agent (or human) to make a decision you " +
			"cannot make alone. Returns immediately; the answer arrives as a " +
			"steering message you should wait for before proceeding.",
		parameters: SupervisorParams,
		async execute(_id, params) {
			const runId = opts.runId();
			if (!runId) {
				return {
					content: [
						{
							type: "text",
							text: "No supervisor available (not running as a subagent).",
						},
					],
					details: { delivered: false },
				};
			}
			opts.publish(
				needDecisionMessage(runId, {
					question: params.question,
					options: params.options,
					context: params.context,
				}),
			);
			return {
				content: [
					{
						type: "text",
						text: "Asked the supervisor. Wait for their guidance before continuing.",
					},
				],
				details: { delivered: true },
			};
		},
	}) as ToolDefinition;
}

export interface SupervisorProjectorDeps {
	readonly bus: RunBus;
	/** Resolve the decision (ask.v1 / ui.confirm / modes ship gate relay). */
	readonly decide: (
		runId: RunId,
		request: SupervisorDecisionRequest,
	) => Promise<SupervisorDecision>;
	/** Deliver the answer back to the child as a steering message. */
	readonly steer: (runId: RunId, guidance: string) => void;
	/** Optional side-channel notification for external observers. */
	readonly onNeedDecision?: (
		runId: RunId,
		request: SupervisorDecisionRequest,
	) => void;
}

/**
 * Parent-side projector: relay every needDecision to `decide`, then steer the
 * child with the answer. Returns a disposer.
 */
export function attachSupervisor(deps: SupervisorProjectorDeps): () => void {
	return deps.bus.subscribe((message) => {
		if (message.type !== "needDecision") return;
		const { runId, request } = message;
		deps.onNeedDecision?.(runId, request);
		void deps
			.decide(runId, request)
			.then((decision) => deps.steer(runId, decision.answer))
			.catch(() => {
				// A failed decision leaves the child waiting; the orchestrator's
				// stop/timeout path handles a stuck run.
			});
	});
}
