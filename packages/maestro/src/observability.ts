import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CAPABILITIES, type ModeName } from "@vegardx/pi-contracts";
import type { MaestroContext } from "@vegardx/pi-core";
import { installMaestroFooter } from "./footer.js";
import { UsageLedger } from "./usage-ledger.js";

export function installMaestroObservability(
	pi: ExtensionAPI,
	maestro: MaestroContext,
	mode: () => ModeName,
): UsageLedger {
	let invalidate: (() => void) | undefined;
	const ledger = new UsageLedger({ onChange: () => invalidate?.() });
	maestro.capabilities.register(CAPABILITIES.usage, ledger);

	let turnSawAssistant = false;
	let turnReportedUsage = false;
	pi.on("turn_start", () => {
		turnSawAssistant = false;
		turnReportedUsage = false;
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		turnSawAssistant = true;
		const message = event.message as AssistantMessage;
		if (!message.usage) return;
		turnReportedUsage = true;
		ledger.add(
			{ kind: "maestro" },
			{
				input: message.usage.input,
				output: message.usage.output,
				cacheRead: message.usage.cacheRead,
				cacheWrite: message.usage.cacheWrite,
				cost: message.usage.cost?.total,
			},
		);
	});
	pi.on("turn_end", () => {
		if (turnSawAssistant && !turnReportedUsage)
			ledger.recordUnavailable({ kind: "maestro" });
		ledger.incrementTurns({ kind: "maestro" });
	});
	pi.on("session_start", (_event, ctx) => {
		invalidate = installMaestroFooter({ pi, ctx, ledger, mode });
	});
	pi.on("session_shutdown", () => ledger.dispose());
	return ledger;
}
