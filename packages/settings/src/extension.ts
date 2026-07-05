// Settings extension — registers /maestro command and settings.v1 capability.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingDeclaration } from "@vegardx/pi-contracts";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { readModelsConfig } from "@vegardx/pi-models";
import { getSettingsCompletions, handleSettingsCommand } from "./command.js";
import { showConfigMenu } from "./menu.js";
import { updateSettingsFile } from "./writer.js";

/** Global registry of declared settings, populated by extensions. */
export const settingsRegistry: Map<string, SettingDeclaration[]> = new Map();

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
			lastCtx = ctx;
		});
		pi.on("input", (_e, ctx) => {
			lastCtx = ctx;
		});

		pi.registerCommand("maestro", {
			description:
				"Open maestro config menu. Subcommands: show, get, set, reset, preset.",
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				if (!trimmed || trimmed === "show") {
					const overlays = maestro.capabilities.get(CAPABILITIES.overlays);
					showConfigMenu(ctx, overlays);
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

		// Auto-switch models.active when user changes model via /model
		pi.on("model_select", (event, ctx) => {
			if (event.source === "restore") return;
			const provider = event.model.provider;
			const config = readModelsConfig(ctx.cwd);
			if (config?.presets[provider] && config.active !== provider) {
				updateSettingsFile("project", ctx.cwd, undefined, (raw) => {
					const models =
						typeof raw.models === "object" && raw.models !== null
							? (raw.models as Record<string, unknown>)
							: {};
					models.active = provider;
					raw.models = models;
				});
				ctx.ui.notify(`Preset \u2192 ${provider}`, "info");
			}
		});
	},
);
