import { createPlanTool } from "./authoring.js";
import { createBashTool } from "./bash-tool.js";
import { createDeleteTool } from "./delete-tool.js";
import {
	type ExecutionPolicySettings,
	readExecutionPolicySettings,
} from "./execution-policy.js";
import { type Mode, type ModeName, mode } from "./mode.js";
import { plansRoot } from "./paths.js";
import { createPlanStore, type PlanStore } from "./store.js";
import { ToolRegistry } from "./tool-registry.js";

export interface SeatOptions {
	readonly cwd?: string;
	readonly agentDir?: string;
}

/** The small, human-driven surface that remains after the workflow cutover. */
export interface Seat {
	readonly store: PlanStore;
	readonly tools: ToolRegistry;
	mode(): Mode;
	setMode(name: ModeName): Mode;
	onModeChange(
		listener: (mode: ModeName, previous: ModeName) => void,
	): () => void;
}

export function createSeat(options: SeatOptions = {}): Seat {
	const cwd = options.cwd ?? process.cwd();
	const store = createPlanStore(plansRoot(options.agentDir));
	let current = mode("plan");
	const listeners = new Set<(mode: ModeName, previous: ModeName) => void>();
	const policy = (): ExecutionPolicySettings =>
		readExecutionPolicySettings(cwd, options.agentDir);

	const tools = ToolRegistry.declare([
		{
			definition: createBashTool({
				holder: "maestro",
				cwd,
				mode: () => current,
				policy,
			}),
			holders: ["maestro"],
		},
		{ definition: createDeleteTool(), holders: ["maestro"] },
		{
			definition: createPlanTool({ store, cwd: () => cwd }),
			holders: ["maestro"],
		},
	]);

	return {
		store,
		tools,
		mode: () => current,
		setMode: (name) => {
			const previous = current.name;
			current = mode(name);
			if (previous !== current.name)
				for (const listener of listeners) listener(current.name, previous);
			return current;
		},
		onModeChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
