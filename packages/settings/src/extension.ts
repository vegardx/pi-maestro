// Settings extension — registers /maestro command and settings.v1 capability.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingDeclaration } from "@vegardx/pi-contracts";
import {
	CAPABILITIES,
	resetSessionSettingOverrides,
} from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { getSettingsCompletions, handleSettingsCommand } from "./command.js";
import type { DomainRegistryInput } from "./domain.js";
import { setRegionActive, showConfigMenu } from "./menu.js";
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
				"Open Maestro configuration. Subcommands: show, get, set, reset, explain, validate, region.",
			handler: async (args, ctx) => {
				try {
					const trimmed = args.trim();
					if (!trimmed || trimmed === "show" || trimmed === "region") {
						await showConfigMenu(ctx, domainRegistry);
					} else if (trimmed.startsWith("region ")) {
						setRegionActive(ctx, trimmed.slice("region ".length).trim());
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
	},
);
