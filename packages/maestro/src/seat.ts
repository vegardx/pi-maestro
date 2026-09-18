import { createPlanIntentTool, createPlanTool } from "./authoring.js";
import { createBashTool } from "./bash-tool.js";
import { createDeleteTool } from "./delete-tool.js";
import {
	type ExecutionPolicySettings,
	readExecutionPolicySettings,
} from "./execution-policy.js";
import { type Mode, type ModeName, mode } from "./mode.js";
import { plansRoot } from "./paths.js";
import type { PlanHostPort, PlanPolicy } from "./plan.js";
import { createPlanStore, type PlanStore } from "./store.js";
import { ToolRegistry } from "./tool-registry.js";

export interface SeatOptions {
	readonly cwd?: string;
	readonly agentDir?: string;
	/**
	 * How far the plan-mode exit has got, if it has started. Injected rather
	 * than read here: the record that answers it lives on disk
	 * (`<agentDir>/maestro/plans/.pending/<sessionId>.json`) and belongs to the
	 * exit flow, not to the seat. Absent means "no exit in progress", which is
	 * every seat that never starts one.
	 */
	readonly exitWindow?: () => ExitWindow;
	/**
	 * The dials the exit's dialogs settled, for the `plan` tool to attach.
	 *
	 * Read from the same pending record `exitWindow` reads, because they are two
	 * answers to one question — is an exit in progress, and what did it decide —
	 * and a second reader of that file would be a second opinion about it. The
	 * `plan` tool has no `policy` parameter: @see AuthoringDeps.policy.
	 */
	readonly exitPolicy?: () => PlanPolicy | undefined;
	/**
	 * The live session, as the two questions a pinned review raises: does this
	 * host have that model, has it loaded that skill. @see PlanHostPort
	 *
	 * ONE SOURCE FOR BOTH READERS. The `plan` tool refuses a document this host
	 * cannot honour and the store refuses to save one; that is one refusal, so
	 * they are handed the same port rather than each finding its own. A seat
	 * built without one — a test, a headless check — refuses anything pinned,
	 * by name, rather than storing what nothing could verify.
	 */
	readonly host?: () => PlanHostPort | undefined;
}

/**
 * What a plan-mode exit has opened, in the one vocabulary both tools read.
 *
 * - `none`   no record: neither exit tool exists.
 * - `intent` a record with no agreed description: `plan_intent` is held, and
 *   `plan` is not — there is nothing yet for a blind reviewer to check against.
 * - `plan`   the description is agreed: the `plan` tool's window is open.
 */
export type ExitWindow = "none" | "intent" | "plan";

/**
 * When the `plan` tool exists.
 *
 * Plan mode is a conversation, not a tool posture: the document is written on
 * the way out, so a model still in plan mode has nothing to call `plan` with.
 * The one exception is the exit window. The exit no longer moves the posture to
 * open it — the mode stays `plan` until the run starts — so the pending record
 * is the ONLY thing that says the window is open, and it only says so once the
 * description has been agreed. Both facts read through this one predicate, so
 * the registration, the defence-in-depth block and the tests cannot disagree.
 *
 * Workflow runs are not gated HERE, because the seat does not declare them:
 * they are the runtime's tools and this registry only moves its own. They are
 * refused to the model in plan mode all the same, by name, at the tool call —
 * see `seatToolBlockReason` in `extension.ts`. A run is safe from plan mode and
 * is still not the model's to start there: the person starts one with
 * `/workflow run`, and the plan-mode exit starts the plan's own.
 */
export function planToolAvailable(mode: ModeName, window: ExitWindow): boolean {
	return mode !== "plan" || window === "plan";
}

/**
 * When `plan_intent` exists: while an exit is in progress, and only then.
 *
 * INDEPENDENT OF THE MODE. The exit no longer switches the posture when it
 * starts, so a session in auto or hack with no exit pending must not hold a
 * tool whose whole meaning is "the dialog waiting for this record".
 */
export function intentToolAvailable(
	_mode: ModeName,
	window: ExitWindow,
): boolean {
	return window !== "none";
}

/** The small, human-driven surface that remains after the workflow cutover. */
export interface Seat {
	readonly store: PlanStore;
	readonly tools: ToolRegistry;
	/** Is the `plan` tool held right now? The registration's own answer. */
	planToolAvailable(): boolean;
	/** Is `plan_intent` held right now? Same door, same answer. */
	intentToolAvailable(): boolean;
	mode(): Mode;
	setMode(name: ModeName): Mode;
	onModeChange(
		listener: (mode: ModeName, previous: ModeName) => void,
	): () => void;
}

export function createSeat(options: SeatOptions = {}): Seat {
	const cwd = options.cwd ?? process.cwd();
	const store = createPlanStore(plansRoot(options.agentDir), {
		...(options.host ? { host: options.host } : {}),
	});
	let current = mode("plan");
	const listeners = new Set<(mode: ModeName, previous: ModeName) => void>();
	const policy = (): ExecutionPolicySettings =>
		readExecutionPolicySettings(cwd, options.agentDir);
	const exitWindow = options.exitWindow ?? ((): ExitWindow => "none");
	const planAvailable = (): boolean =>
		planToolAvailable(current.name, exitWindow());
	const intentAvailable = (): boolean =>
		intentToolAvailable(current.name, exitWindow());

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
				...(options.host ? { host: options.host } : {}),
				...(options.exitPolicy ? { policy: options.exitPolicy } : {}),
			}),
			holders: ["maestro"],
			available: planAvailable,
		},
		{
			definition: createPlanIntentTool(),
			holders: ["maestro"],
			available: intentAvailable,
		},
	]);

	return {
		store,
		tools,
		planToolAvailable: planAvailable,
		intentToolAvailable: intentAvailable,
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
