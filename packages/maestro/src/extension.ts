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
import { createSeat, type Seat } from "./seat.js";

const DIRECT_MUTATION_TOOLS = new Set(["write", "edit", "delete"]);

export function seatToolBlockReason(
	mode: ModeName,
	toolName: string,
): string | undefined {
	return mode === "plan" && DIRECT_MUTATION_TOOLS.has(toolName)
		? `Mode plan is read-only; switch to /mode auto or /mode hack before using ${toolName}.`
		: undefined;
}

/**
 * What a stored plan write should say, once, to the human watching.
 *
 * The tool result already tells the MODEL how to run the plan. This is the
 * other half: plan mode has no exit — it is a tool posture, not a state machine
 * — so the only "you are done here" a session ever gets is this line. It offers
 * both ways out: hand the plan to a run, or leave the posture and edit by hand.
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
}

export function startSeat(
	pi: SeatHost,
	options: { readonly cwd?: string; readonly agentDir?: string } = {},
): { seat(): Seat; currentMode(): ModeName } {
	const cwd = options.cwd ?? process.cwd();
	let built: Seat | undefined;
	const seat = (): Seat => {
		if (built) return built;
		built = createSeat({
			cwd,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
		});
		for (const tool of built.tools.definitionsFor("maestro"))
			pi.registerTool(tool);
		return built;
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
			const reason = seatToolBlockReason(entry.currentMode(), event.toolName);
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
