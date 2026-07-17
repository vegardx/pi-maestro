// Interactive /maestro entry. The exact domain graph is authoritative; this
// compact menu exposes its summary and directs edits through scripted keys.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readDomainSnapshot, type DomainRegistryInput } from "./domain.js";

export function showConfigMenu(
	ctx: ExtensionContext,
	registry: DomainRegistryInput = {},
): void {
	const snapshot = readDomainSnapshot(ctx, registry);
	ctx.ui.notify(
		[
			"Maestro configuration",
			`Active preset: ${snapshot.activePreset ?? "session fallback"}`,
			`Exact model sets: ${snapshot.modelSets.length}`,
			`Agent kinds: ${snapshot.kinds.length}`,
			`Runtime policies: ${snapshot.runtimePolicies.length}`,
			`Transition gates: ${snapshot.gates.length}`,
			"",
			"Use /maestro explain <kind>, /maestro validate, or /maestro set <domain-key> <json>.",
		].join("\n"),
		"info",
	);
}
