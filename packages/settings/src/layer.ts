// Bridge from settings to core's feature-flag resolver.
//
// core owns the resolver and exposes setSettingsLayer as a seam; settings
// fills it. This keeps the dependency pointing the right way (settings →
// core) — core never imports settings.
//
// Granular-flag schema: extensionConfig.<name>.flags.<flag> = boolean.
// Whole-extension:       extensionConfig.<name>.enabled     = boolean.

import { type SettingsLayer, setSettingsLayer } from "@vegardx/pi-core";
import {
	type ExtensionConfigMap,
	readLayeredExtensionConfig,
} from "./reader.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Build a SettingsLayer over a merged extensionConfig snapshot. */
export function createSettingsLayer(merged: ExtensionConfigMap): SettingsLayer {
	return {
		extensionEnabled(name) {
			const value = merged[name]?.enabled;
			return typeof value === "boolean" ? value : undefined;
		},
		flagEnabled(path) {
			const dot = path.indexOf(".");
			if (dot <= 0) return undefined;
			const name = path.slice(0, dot);
			const flag = path.slice(dot + 1);
			let current: unknown = merged[name]?.flags;
			for (const part of flag.split(".")) {
				if (!isPlainObject(current) || !Object.hasOwn(current, part)) {
					return undefined;
				}
				current = current[part];
			}
			return typeof current === "boolean" ? current : undefined;
		},
	};
}

const INSTALL_KEY = "__maestro_settings_layer_installed__";

export interface InstallSettingsLayerOptions {
	cwd?: string;
	agentDir?: string;
	/** Re-read and re-install even if already installed this process. */
	force?: boolean;
}

/**
 * Read layered settings and wire the resulting SettingsLayer into core.
 * Idempotent per process (guarded on globalThis) unless `force` is set —
 * extensions can call it freely at session start; the first wins.
 * Returns the installed layer.
 */
export function installSettingsLayer(
	options: InstallSettingsLayerOptions = {},
): SettingsLayer {
	const g = globalThis as Record<string, unknown>;
	if (g[INSTALL_KEY] && !options.force) {
		return g[INSTALL_KEY] as SettingsLayer;
	}
	const { merged } = readLayeredExtensionConfig(
		options.cwd ?? process.cwd(),
		options.agentDir,
	);
	const layer = createSettingsLayer(merged);
	setSettingsLayer(layer);
	g[INSTALL_KEY] = layer;
	return layer;
}

/** Test seam — forget the install guard and clear core's layer. */
export function __resetSettingsLayer(): void {
	const g = globalThis as Record<string, unknown>;
	delete g[INSTALL_KEY];
	setSettingsLayer(undefined);
}
