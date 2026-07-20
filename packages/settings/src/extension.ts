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
		let registered: DomainRegistryInput = {};
		// The personas.v1 roster is resolved lazily at menu time — the
		// subagents extension registers it after boot, and persona pickers
		// degrade to free text (with a warning) when it is absent.
		const domainRegistry: DomainRegistryInput = {
			get kinds() {
				return registered.kinds;
			},
			get runtime() {
				return registered.runtime;
			},
			personas: () => maestro.capabilities.get(CAPABILITIES.personas)?.list(),
		};
		// Provide settings.v1 capability for extensions to declare settings
		maestro.capabilities.register(CAPABILITIES.settings, {
			declare(extension: string, settings: SettingDeclaration[]) {
				settingsRegistry.set(extension, settings);
			},
			registerAgentConfiguration(input) {
				registered = input;
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
				try {
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
				} catch (cause) {
					// A malformed/stale models config must read as guidance, not
					// as an extension stack trace.
					ctx.ui.notify(
						`Maestro settings could not be read: ${cause instanceof Error ? cause.message : String(cause)}\nFix the models block in settings.json (see docs/modes-architecture.md).`,
						"warning",
					);
				}
			},
			getArgumentCompletions: (prefix) => {
				if (!lastCtx) return null;
				const items = getSettingsCompletions(prefix, lastCtx);
				return items.map((value) => ({ value, label: value }));
			},
		});

		// The session model selects the active preset from exact target membership.
		// A stale/malformed models config notifies ONCE — never an extension
		// error on every model switch (2026-07-19: pre-cutover models format).
		let configErrorNotified = false;
		pi.on("model_select", (event, ctx) => {
			if (event.source === "restore") return;
			let config: ReturnType<typeof readModelsConfig>;
			try {
				config = readModelsConfig(ctx.cwd);
			} catch (cause) {
				if (!configErrorNotified) {
					configErrorNotified = true;
					ctx.ui.notify(
						`Maestro model settings ignored: ${cause instanceof Error ? cause.message : String(cause)}`,
						"warning",
					);
				}
				return;
			}
			if (!config) return;
			const modelId = `${event.model.provider}/${event.model.id}`;
			const active = activePreset(config, modelId);
			if (active) ctx.ui.notify(`Preset → ${active.id}`, "info");
		});
	},
);
