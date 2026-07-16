// Settings extension — registers /maestro command and settings.v1 capability.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingDeclaration } from "@vegardx/pi-contracts";
import {
	CAPABILITIES,
	resetSessionRoleOverrides,
	resetSessionSettingOverrides,
} from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { activeProfile, readModelsConfig } from "@vegardx/pi-models";
import { getSettingsCompletions, handleSettingsCommand } from "./command.js";
import { showConfigMenu } from "./menu.js";
import { settingsRegistry } from "./registry.js";

export { settingsRegistry } from "./registry.js";

export default defineExtension(
	{
		name: "settings",
		path: "packages/settings/src/extension.ts",
		doc: "Settings viewer/editor: /maestro interactive menu + subcommands.",
	},
	(pi, maestro) => {
		// Provide settings.v1 capability for extensions to declare settings
		maestro.capabilities.register(CAPABILITIES.settings, {
			declare(extension: string, settings: SettingDeclaration[]) {
				settingsRegistry.set(extension, settings);
			},
		});

		let lastCtx: ExtensionContext | undefined;
		pi.on("session_start", (_e, ctx) => {
			resetSessionRoleOverrides();
			resetSessionSettingOverrides();
			lastCtx = ctx;
		});
		pi.on("session_shutdown", () => {
			resetSessionRoleOverrides();
			resetSessionSettingOverrides();
			lastCtx = undefined;
		});
		pi.on("input", (_e, ctx) => {
			lastCtx = ctx;
		});

		pi.registerCommand("maestro", {
			description:
				"Open hierarchical Maestro settings. Subcommands: show, get, set, reset, profiles, <role> [list|add|remove|default|effort].",
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				if (!trimmed || trimmed === "show") {
					showConfigMenu(ctx);
				} else {
					// Text-based subcommands for scripting
					handleSettingsCommand(args, ctx);
				}
			},
			getArgumentCompletions: (prefix) => {
				if (!lastCtx) return null;
				const items = getSettingsCompletions(prefix, lastCtx);
				return items.map((value) => ({ value, label: value }));
			},
		});

		// The session model selects the active profile (derived from target
		// membership \u2014 no stored `active`). Notify which profile /model activated.
		pi.on("model_select", (event, ctx) => {
			if (event.source === "restore") return;
			const config = readModelsConfig(ctx.cwd);
			if (!config) return;
			const modelId = `${event.model.provider}/${event.model.id}`;
			const active = activeProfile(config, modelId);
			if (active) ctx.ui.notify(`Profile \u2192 ${active.name}`, "info");
		});
	},
);
