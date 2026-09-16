import type {
	ExtensionCommandContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { MODE_NAMES, type ModeName } from "./mode.js";
import { workflowInputFile } from "./paths.js";
import { createPlanCommand } from "./plan-command.js";
import { EFFORTS } from "./plan-input.js";
import { createSeat, planToolAvailable, type Seat } from "./seat.js";

const DIRECT_MUTATION_TOOLS = new Set(["write", "edit", "delete"]);

/**
 * Why a tool call cannot happen in this posture, or nothing.
 *
 * `plan` is here as defence in depth only: the registration already withholds
 * it (`planToolAvailable`), so a call that reaches this point means a host kept
 * a stale tool set. Worth a named refusal rather than a silent write.
 *
 * Nothing else is gated by mode. Workflow tools in particular are left alone:
 * a run touches neither this working tree nor the host, so starting one from
 * plan mode is intended, not an oversight.
 */
export function seatToolBlockReason(
	mode: ModeName,
	toolName: string,
	pendingExit = false,
): string | undefined {
	if (mode === "plan" && DIRECT_MUTATION_TOOLS.has(toolName))
		return `Mode plan is read-only; switch to /mode auto or /mode hack before using ${toolName}.`;
	if (toolName === "plan" && !planToolAvailable(mode, pendingExit))
		return "The `plan` tool is not held in plan mode; it is offered on the way out, so switch with /mode auto or /mode hack and write the plan there.";
	return undefined;
}

/**
 * Phase 1 of the plan-mode exit, before the mode actually changes.
 *
 * A seam, deliberately empty: the dialogs, the pending record and the steer
 * that asks the model for the document land in `exit-flow.ts` (M2-EXIT1). It
 * exists now so the `/mode` handler has exactly one place to grow, and so the
 * seat's tool set already flips on the transition this hook straddles.
 */
export type ModeExitHook = (
	previous: ModeName,
	next: ModeName,
) => void | Promise<void>;

export const beginModeExit: ModeExitHook = () => {};

/**
 * What a stored plan write should say, once, to the human watching.
 *
 * The tool result already tells the MODEL how to run the plan. This is the
 * other half, and now also the one place a human is told where the `plan` tool
 * lives: plan mode is the conversation and does not hold it, the exit offers it,
 * and a workflow run is allowed from either posture because it touches neither
 * the working tree nor the host.
 *
 * Returns the text rather than notifying, so the decision is testable without a
 * UI and so the event wiring stays one line.
 */
export function planStoredNotice(
	event: Pick<ToolResultEvent, "toolName" | "isError" | "details">,
	mode: ModeName,
): string | undefined {
	if (event.toolName !== "plan" || event.isError) return undefined;
	const details = event.details as
		| { stored?: unknown; slug?: unknown }
		| undefined;
	if (details?.stored !== true || typeof details.slug !== "string")
		return undefined;
	return (
		`Stored plan \`${details.slug}\`. Run it with \`/plan run ${details.slug} [${EFFORTS.join("|")}]\`; ` +
		`approval happens at the run's \`approve-plan\` checkpoint.` +
		" The `plan` tool is not held in plan mode — only while leaving it — but a" +
		" workflow run, research included, may be started from plan mode: it touches" +
		" neither this working tree nor the host." +
		(mode === "plan"
			? " To hand-edit instead, leave this posture with `/mode auto`."
			: "")
	);
}

export interface SeatHost {
	registerTool(tool: unknown): void;
	registerCommand(name: string, spec: unknown): void;
	/**
	 * Steering text for the session. Optional because the seat must start on a
	 * host that has none; `/plan run` then prints the call instead of injecting
	 * it, rather than pretending it handed something over.
	 */
	sendUserMessage?(
		content: string,
		options?: { deliverAs?: "steer" | "followUp" },
	): void;
	/**
	 * Pi's live tool set. Optional as a pair: `registerTool` has no inverse, so
	 * withdrawing a tool means naming the set that remains. A host without them
	 * still gets every tool that was available when the seat was built — it just
	 * cannot take one back, which is why the block reason above exists.
	 */
	getActiveTools?(): string[];
	setActiveTools?(toolNames: string[]): void;
}

export interface StartSeatOptions {
	readonly cwd?: string;
	readonly agentDir?: string;
	/** @see SeatOptions.pendingExit — the exit flow's record, once it exists. */
	readonly pendingExit?: () => boolean;
	/** @see beginModeExit — overridable so a test can watch the seam fire. */
	readonly beginModeExit?: ModeExitHook;
}

export interface SeatEntry {
	seat(): Seat;
	currentMode(): ModeName;
	pendingExit(): boolean;
}

export function startSeat(
	pi: SeatHost,
	options: StartSeatOptions = {},
): SeatEntry {
	const cwd = options.cwd ?? process.cwd();
	const pendingExit = options.pendingExit ?? (() => false);
	const onModeExit = options.beginModeExit ?? beginModeExit;
	let built: Seat | undefined;
	const registered = new Set<string>();

	/**
	 * Make Pi's tool set equal the seat's, which is the whole point of declaring
	 * availability: the set is recomputed from the registry on every mode change
	 * rather than remembered anywhere. Foreign tools — Pi's own, and every
	 * workflow tool — are copied through untouched; only names this seat
	 * declares are added or withdrawn.
	 */
	const syncTools = (live: Seat): void => {
		const available = live.tools.definitionsFor("maestro");
		for (const tool of available) {
			if (registered.has(tool.name)) continue;
			registered.add(tool.name);
			pi.registerTool(tool);
		}
		if (!pi.getActiveTools || !pi.setActiveTools) return;
		const ours = new Set(live.tools.declaredFor("maestro"));
		const availableNames = new Set(available.map((tool) => tool.name));
		const active = pi.getActiveTools();
		const next = active.filter(
			(name) => !ours.has(name) || availableNames.has(name),
		);
		for (const name of availableNames)
			if (!next.includes(name)) next.push(name);
		if (next.length !== active.length || next.some((n, i) => n !== active[i]))
			pi.setActiveTools(next);
	};

	const seat = (): Seat => {
		if (built) return built;
		const created = createSeat({
			cwd,
			pendingExit,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
		});
		built = created;
		// Registration follows the mode, so it follows every route into one —
		// the `/mode` command today, the exit flow's own `setMode` tomorrow.
		created.onModeChange(() => syncTools(created));
		syncTools(created);
		return created;
	};

	pi.registerCommand("mode", {
		description: `Switch posture. /mode [${MODE_NAMES.join("|")}]`,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const wanted = args.trim().toLowerCase();
			if (!wanted) {
				ctx.ui.notify(`Mode is ${seat().mode().name}.`, "info");
				return;
			}
			if (!MODE_NAMES.includes(wanted as ModeName)) {
				ctx.ui.notify(
					`Unknown mode \`${wanted}\` — one of ${MODE_NAMES.join(", ")}.`,
					"warning",
				);
				return;
			}
			const previous = seat().mode().name;
			// Phase 1 of the exit flow belongs here, before the posture changes,
			// because everything it asks about is what the human knows and the
			// plan does not yet say. It is a no-op until M2-EXIT1 fills it.
			if (previous !== wanted) await onModeExit(previous, wanted as ModeName);
			const next = seat().setMode(wanted as ModeName);
			ctx.ui.notify(
				`Mode ${next.name}: ${next.cwd === "write" ? "can write" : "read-only"}, safeguards ${next.safeguards}.`,
				"info",
			);
		},
	});

	pi.registerCommand(
		"plan",
		createPlanCommand({
			// A getter, not the store: `seat()` builds lazily, and building it at
			// registration time would undo that.
			get store() {
				return seat().store;
			},
			inputPath: (slug) => workflowInputFile(slug, options.agentDir),
			...(pi.sendUserMessage
				? { sendUserMessage: pi.sendUserMessage.bind(pi) }
				: {}),
		}),
	);

	return {
		seat,
		currentMode: () => built?.mode().name ?? "plan",
		pendingExit,
	};
}

export default defineExtension(
	{
		name: "maestro",
		path: "packages/maestro/src/extension.ts",
		doc: "Author plans and enforce the interactive seat posture.",
	},
	async (pi, maestro) => {
		const entry = startSeat(pi);
		entry.seat();
		pi.on("tool_call", (event) => {
			const reason = seatToolBlockReason(
				entry.currentMode(),
				event.toolName,
				entry.pendingExit(),
			);
			if (reason) return { block: true, reason };
		});
		pi.on("tool_result", (event, ctx) => {
			const notice = planStoredNotice(event, entry.currentMode());
			if (notice) ctx.ui.notify(notice, "info");
		});
		maestro.capabilities.register(CAPABILITIES.modes, {
			current: entry.currentMode,
			onChange: (listener) => entry.seat().onModeChange(listener),
		});
		const { installMaestroObservability } = await import("./observability.js");
		installMaestroObservability(pi, entry.currentMode);
	},
);
