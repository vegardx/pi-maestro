import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { MODE_NAMES, type ModeName } from "./mode.js";
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

export interface SeatHost {
	registerTool(tool: unknown): void;
	registerCommand(name: string, spec: unknown): void;
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
		maestro.capabilities.register(CAPABILITIES.modes, {
			current: entry.currentMode,
			onChange: (listener) => entry.seat().onModeChange(listener),
		});
		const { installMaestroObservability } = await import("./observability.js");
		installMaestroObservability(pi, entry.currentMode);
	},
);
