// Mode runtime composition root: constructs the shared RuntimeContext, wires
// plan tools, commands, event hooks, and capability registrations. All
// behavior lives in the sibling modules; this file only assembles them.

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CAPABILITIES,
	type ModeName,
	type ModesExecutionStatus,
} from "@vegardx/pi-contracts";
import type { MaestroContext } from "@vegardx/pi-core";
import type { ModesAskQueue } from "../ask-queue.js";
import type { PlanEngine } from "../engine.js";
import { createPlanTools } from "../tools.js";
import { registerRuntimeCommands } from "./commands.js";
import {
	activeDeliverable,
	createRuntimeContext,
	type ModesRuntimeOptions,
} from "./context.js";
import { registerRuntimeHooks } from "./hooks.js";

export type { ModesRuntimeOptions } from "./context.js";

const PLAN_CONTAINER = "plan" as const;

export { PLAN_CONTAINER };

export interface ModesRuntime {
	readonly askQueue: ModesAskQueue;
	currentMode(): ModeName;
	currentEngine(): PlanEngine | undefined;
	setMode(mode: ModeName, ctx?: ExtensionContext): void;
	openPlan(titleOrSlug: string | undefined, ctx: ExtensionContext): PlanEngine;
	cycle(ctx: ExtensionContext): Promise<void>;
}

export function createModesRuntime(
	pi: ExtensionAPI,
	maestro: MaestroContext,
	opts: ModesRuntimeOptions = {},
): ModesRuntime {
	const rt = createRuntimeContext(pi, maestro, opts);

	for (const tool of createPlanTools({
		engine: () => rt.engine,
		onPlanChanged: () => rt.emitPlanChanged(),
		mode: () => rt.state.mode,
		steerAgent: (groupId, guidance) => {
			rt.execution?.steer(groupId, guidance);
		},
		onTaskToggle: (groupId, taskId) => {
			rt.agentBridge?.onTaskComplete(groupId, taskId);
		},
		seedContent: () => rt.agentSeedContent,
		agentBridge: () => rt.agentBridge,
		agentGroupId: () =>
			process.env.PI_MAESTRO_AGENT_ID?.split("/")[0] || undefined,
	})) {
		pi.registerTool(tool);
	}

	registerRuntimeCommands(rt);
	registerRuntimeHooks(rt);

	maestro.capabilities.register(CAPABILITIES.usage, rt.usageLedger);
	maestro.capabilities.register(CAPABILITIES.overlays, rt.overlayManager);

	// Declare configurable settings for /maestro menu
	maestro.capabilities.get(CAPABILITIES.settings)?.declare("modes", [
		{ key: "maxAgents", label: "Max agents", type: "number", default: 4 },
		{
			key: "maxReviewCycles",
			label: "Max review cycles",
			type: "number",
			default: 2,
		},
		{ key: "models.agent.effort", label: "Agent effort", type: "thinking" },
		{ key: "models.agent.slot", label: "Agent slot", type: "slot" },
		{ key: "models.agent.model", label: "Agent model", type: "model" },
		{ key: "models.analyze.effort", label: "Analyze effort", type: "thinking" },
		{ key: "models.analyze.slot", label: "Analyze slot", type: "slot" },
		{ key: "models.analyze.model", label: "Analyze model", type: "model" },
		{
			key: "models.classifier.effort",
			label: "Classifier effort",
			type: "thinking",
		},
		{ key: "models.classifier.slot", label: "Classifier slot", type: "slot" },
	]);

	maestro.capabilities.register(CAPABILITIES.modes, {
		current: rt.currentMode,
		onChange(listener) {
			rt.listeners.add(listener);
			return () => rt.listeners.delete(listener);
		},
		execution: (): ModesExecutionStatus => ({
			mode: rt.state.mode,
			activePlanSlug: rt.state.activePlanSlug,
			activeDeliverableId:
				rt.state.execution.deliverableId ??
				(rt.engine ? activeDeliverable(rt.engine.get())?.id : undefined),
			executing: rt.state.execution.stage === "executing",
			compactionInFlight: rt.compactionInFlight,
		}),
	});

	return {
		askQueue: rt.askQueue,
		currentMode: rt.currentMode,
		currentEngine: rt.currentEngine,
		setMode: rt.setMode,
		openPlan: rt.openPlan,
		cycle: rt.cycle,
	};
}
