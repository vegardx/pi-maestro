// The /maestro entry. On a TUI (ctx.ui.custom present) the model-config
// domains — families, rosters, bindings, allowances, region — open in the
// full-screen takeover editor (maestro-app.ts). Rules (the policy table) stay
// on the select-loop, as does the whole menu on RPC/headless, where the
// takeover cannot mount and model config is authored via /maestro set. Every
// edit routes through the validated writeDomainValue path.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getSessionSettingOverride,
	setSessionSettingOverride,
	type V2ModelsConfig,
} from "@vegardx/pi-contracts";
import {
	activeRegion,
	activeV2Binding,
	isRegionOff,
	REGION_OFF,
	readV2Config,
	regionNames,
} from "@vegardx/pi-models";
import { type DomainRegistryInput, writeDomainValue } from "./domain.js";
import { launchMaestroApp, supportsMaestroApp } from "./maestro-app.js";
import { browsePolicyTable, readSettingsPolicyTable } from "./menu-policies.js";
import { dialogs } from "./menu-shared.js";
import { sessionModelId } from "./model.js";

export function getSessionSetting(extension: string, key: string) {
	return getSessionSettingOverride(extension, key);
}

export function setSessionSetting(
	extension: string,
	key: string,
	value: boolean | string | number | readonly string[] | undefined,
): void {
	setSessionSettingOverride(extension, key, value);
}

function safeV2Config(ctx: ExtensionContext): V2ModelsConfig | undefined {
	try {
		return readV2Config(ctx.cwd);
	} catch (cause) {
		ctx.ui.notify(
			`Model config could not be read: ${cause instanceof Error ? cause.message : String(cause)}. Fix or clear the models block (an incompatible one is wiped at boot).`,
			"warning",
		);
		return undefined;
	}
}

export async function showConfigMenu(
	ctx: ExtensionContext,
	registry: DomainRegistryInput = {},
): Promise<void> {
	// On a TUI, /maestro IS the full-screen modal — families, rosters, bindings,
	// allowances, region, and rules all live inside one takeover component.
	if (supportsMaestroApp(ctx)) {
		await launchMaestroApp(ctx, registry);
		return;
	}
	// RPC/headless can't host the takeover: rules stay on the select-loop and
	// model config is authored via /maestro set. The summary is the no-UI floor.
	const ui = dialogs(ctx);
	if (!ui) {
		notifySummary(ctx);
		return;
	}
	while (true) {
		const rows = readSettingsPolicyTable(ctx.cwd).rows.length;
		const choice = await ui.select("Maestro configuration", [
			`Rules (${rows} rows)…`,
			"Summary",
		]);
		if (!choice) return;
		if (choice.startsWith("Rules")) {
			await browsePolicyTable(ctx, ui, registry);
		} else {
			notifySummary(ctx);
			ctx.ui.notify(
				"Model config (families, rosters, bindings, allowances, region) is authored over RPC with /maestro set models.<key> <json>.",
				"info",
			);
		}
	}
}

/** Persist the active region to global settings and confirm (scripted path). */
export function setRegionActive(ctx: ExtensionContext, name: string): void {
	const config = safeV2Config(ctx);
	const normalized = isRegionOff(name) ? REGION_OFF : name;
	const names = regionNames(config?.region);
	if (!names.some((candidate) => candidate === normalized)) {
		ctx.ui.notify(
			`Unknown region "${name}". Configured: ${names.join(", ")}`,
			"warning",
		);
		return;
	}
	const errors = writeDomainValue(
		ctx,
		"models.region.active",
		"global",
		JSON.stringify(normalized),
	);
	if (errors.length) {
		ctx.ui.notify(errors.map((error) => `- ${error}`).join("\n"), "warning");
		return;
	}
	ctx.ui.notify(
		`Region → ${normalized}${isRegionOff(normalized) ? " (all models, no filter)" : ""}. The fleet resolves within it; /models shows the effect.`,
		"info",
	);
}

function notifySummary(ctx: ExtensionContext): void {
	const config = safeV2Config(ctx);
	const active = activeV2Binding(config, sessionModelId(ctx));
	const table = readSettingsPolicyTable(ctx.cwd);
	ctx.ui.notify(
		[
			"Maestro configuration",
			`Active binding: ${active?.id ?? "none (everything inherits the seat)"}`,
			`Families: ${Object.keys(config?.families ?? {}).length} · rosters: ${Object.keys(config?.rosters ?? {}).length} · bindings: ${Object.keys(config?.bindings ?? {}).length}`,
			`Region: ${activeRegion(config?.region)}`,
			`Rules: ${table.rows.length} rows`,
			"",
			"Use /maestro explain <agent>, /maestro validate, or /maestro set <domain-key> <json>.",
		].join("\n"),
		"info",
	);
}
