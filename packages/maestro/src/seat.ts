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
	/**
	 * Is this session inside the plan-mode exit flow? Injected rather than read
	 * here: the record that answers it lives on disk
	 * (`<agentDir>/maestro/plans/.pending/<sessionId>.json`) and belongs to the
	 * exit flow, not to the seat. Absent means "no exit in progress", which is
	 * every seat that never starts one.
	 */
	readonly pendingExit?: () => boolean;
}

/**
 * When the `plan` tool exists.
 *
 * Plan mode is a conversation, not a tool posture: the document is written on
 * the way out, so a model still in plan mode has nothing to call `plan` with.
 * The one exception is the exit window — phase 1 switches the mode and asks the
 * model for the document, and the pending record is what says that window is
 * open. Both facts read through this one predicate, so the registration, the
 * defence-in-depth block and the tests cannot disagree about them.
 *
 * Workflow runs are deliberately NOT gated this way: they never touch the
 * working tree or the host, so running one from plan mode is intended.
 */
export function planToolAvailable(
	mode: ModeName,
	pendingExit: boolean,
): boolean {
	return mode !== "plan" || pendingExit;
}

/** The small, human-driven surface that remains after the workflow cutover. */
export interface Seat {
	readonly store: PlanStore;
	readonly tools: ToolRegistry;
	/** Is the `plan` tool held right now? The registration's own answer. */
	planToolAvailable(): boolean;
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
	const pendingExit = options.pendingExit ?? (() => false);
	const planAvailable = (): boolean =>
		planToolAvailable(current.name, pendingExit());

	const tools = ToolRegistry.declare([
		{
			definition: createBashTool({
				cwd,
				mode: () => current,
				policy,
			}),
			holders: ["maestro"],
		},
		{ definition: createDeleteTool(), holders: ["maestro"] },
		{
			definition: createPlanTool({
				store,
				cwd: () => cwd,
				mode: () => current.name,
			}),
			holders: ["maestro"],
			available: planAvailable,
		},
	]);

	return {
		store,
		tools,
		planToolAvailable: planAvailable,
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
