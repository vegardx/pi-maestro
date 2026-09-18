// The seat: the mode, the plan store, and the small tool surface that is left.
//
// THE PLAN IS NOT WRITTEN BY A TOOL ANY MORE. `plan` and `plan_intent` used to
// live here behind an availability predicate, held open by a record on disk
// that said a plan-mode exit was in progress. The exit asks the model for both
// artifacts itself now — `authoring.ts` — so there is no window to open, no
// record to read, and no predicate to keep in step with one. What remains is
// the two tools a seat holds in every posture.

import { createBashTool } from "./bash-tool.js";
import { createDeleteTool } from "./delete-tool.js";
import {
	type ExecutionPolicySettings,
	readExecutionPolicySettings,
} from "./execution-policy.js";
import { type Mode, type ModeName, mode } from "./mode.js";
import type { PlanHostPort } from "./plan.js";
import { createPlanStore, type PlanStore } from "./store.js";
import { ToolRegistry } from "./tool-registry.js";

export interface SeatOptions {
	readonly cwd?: string;
	readonly agentDir?: string;
	/**
	 * The live session, as the two questions a pinned review raises: does this
	 * host have that model, has it loaded that skill. @see PlanHostPort
	 *
	 * The store refuses to save a plan this host cannot honour, and the exit's
	 * own validation is handed the same port from the same place, so a document
	 * accepted on the way in and re-read on the way out is judged against one
	 * host. A seat built without one refuses anything pinned, by name, rather
	 * than storing what nothing could verify.
	 */
	readonly host?: () => PlanHostPort | undefined;
	/**
	 * The session the store records as a plan's author. @see StoreOptions.sessionId
	 *
	 * Injected rather than read here for the same reason `host` is: the session
	 * does not exist when the seat is built, and the seat must not invent one.
	 */
	readonly sessionId?: () => string | undefined;
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
	const store = createPlanStore({
		cwd,
		sessionId: options.sessionId ?? ((): undefined => undefined),
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
		...(options.host ? { host: options.host } : {}),
	});
	let current = mode("plan");
	const listeners = new Set<(mode: ModeName, previous: ModeName) => void>();
	const policy = (): ExecutionPolicySettings =>
		readExecutionPolicySettings(cwd, options.agentDir);

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
