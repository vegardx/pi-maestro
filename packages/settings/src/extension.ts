// Settings extension — registers /maestro command and settings.v1 capability.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingDeclaration } from "@vegardx/pi-contracts";
import {
	CAPABILITIES,
	resetSessionSettingOverrides,
} from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { activePreset, readModelsConfig } from "@vegardx/pi-models";
import { getSettingsCompletions, handleSettingsCommand } from "./command.js";
import type { DomainRegistryInput } from "./domain.js";
import { browseResidency, setResidency, showConfigMenu } from "./menu.js";
import { settingsRegistry } from "./registry.js";

export { settingsRegistry } from "./registry.js";

export default defineExtension(
	{
		name: "settings",
		path: "packages/settings/src/extension.ts",
		doc: "Settings viewer/editor: /maestro interactive menu + subcommands.",
	},
	(pi, maestro) => {
		let domainRegistry: DomainRegistryInput = {};
		// Provide settings.v1 capability for extensions to declare settings
		maestro.capabilities.register(CAPABILITIES.settings, {
			declare(extension: string, settings: SettingDeclaration[]) {
				settingsRegistry.set(extension, settings);
			},
			registerAgentConfiguration(input) {
				domainRegistry = input;
			},
		});

		let lastCtx: ExtensionContext | undefined;
		pi.on("session_start", (_e, ctx) => {
			resetSessionSettingOverrides();
			lastCtx = ctx;
		});
		pi.on("session_shutdown", () => {
			resetSessionSettingOverrides();
			lastCtx = undefined;
		});
		pi.on("input", (_e, ctx) => {
			lastCtx = ctx;
		});

		pi.registerCommand("maestro", {
			description:
				"Open Maestro configuration. Subcommands: show, get, set, reset, explain, validate, residency.",
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				if (!trimmed || trimmed === "show") {
					await showConfigMenu(ctx, domainRegistry);
				} else if (trimmed === "residency") {
					await browseResidency(ctx);
				} else if (trimmed.startsWith("residency ")) {
					setResidency(ctx, trimmed.slice("residency ".length).trim());
				} else {
					// Text-based subcommands for scripting
					handleSettingsCommand(args, ctx, domainRegistry);
				}
			},
			getArgumentCompletions: (prefix) => {
				if (!lastCtx) return null;
				const items = getSettingsCompletions(prefix, lastCtx);
				return items.map((value) => ({ value, label: value }));
			},
		});

		// The session model selects the active preset from exact target membership.
		pi.on("model_select", (event, ctx) => {
			if (event.source === "restore") return;
			const config = readModelsConfig(ctx.cwd);
			if (!config) return;
			const modelId = `${event.model.provider}/${event.model.id}`;
			const active = activePreset(config, modelId);
			if (active) ctx.ui.notify(`Preset → ${active.id}`, "info");
		});
	},
);
