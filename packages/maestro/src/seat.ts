import { createPlanTool } from "./authoring.js";
import { createBashTool } from "./bash-tool.js";
import { createCommitTool } from "./commit-tool.js";
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
	readonly askHuman?: (
		question: string,
	) => Promise<{ readonly answer: string; readonly from: "maestro" | "human" }>;
}

/** The small, human-driven surface that remains after the workflow cutover. */
export interface Seat {
	readonly store: PlanStore;
	readonly tools: ToolRegistry;
	mode(): Mode;
	setMode(name: ModeName): Mode;
}

export function createSeat(options: SeatOptions = {}): Seat {
	const cwd = options.cwd ?? process.cwd();
	const store = createPlanStore(plansRoot(options.agentDir));
	let current = mode("plan");
	const policy = (): ExecutionPolicySettings =>
		readExecutionPolicySettings(cwd, options.agentDir);

	const tools = ToolRegistry.declare([
		{
			definition: createBashTool({
				holder: "maestro",
				cwd,
				mode: () => current,
				policy,
				...(options.askHuman
					? {
							confirm: async (command: string, reason: string) => {
								const reply = await options.askHuman?.(
									`Run this? ${command}\n\nWhy it is being asked: ${reason}\n\nAnswer yes to allow it.`,
								);
								return (
									reply?.from === "human" &&
									/^\s*y(es)?\s*$/i.test(reply.answer)
								);
							},
						}
					: {}),
			}),
			holders: ["maestro"],
		},
		{
			definition: createCommitTool({ cwd: () => cwd }),
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
			current = mode(name);
			return current;
		},
	};
}
