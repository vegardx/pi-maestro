import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModeName } from "@vegardx/pi-contracts";
import { installMaestroFooter } from "./footer.js";

export function installMaestroObservability(
	pi: ExtensionAPI,
	mode: () => ModeName,
): void {
	pi.on("session_start", (_event, ctx) => {
		installMaestroFooter({ pi, ctx, mode });
	});
}
