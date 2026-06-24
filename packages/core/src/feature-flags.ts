// Feature-flag + enablement resolution.
//
// Precedence: env > settings (project > global, merged) > default(on).
// Core ships the env layer (always available, needs only process.env) and a
// `settings layer` seam. @vegardx/pi-settings injects the merged project/
// global view via setSettingsLayer once it loads; core never imports it, so
// the dependency points the right way (settings → core).
//
// Two granularities:
//   - whole extension: PI_EXT_<NAME>=on|off
//   - single feature:  PI_DISABLE="a.b,c.d" / PI_ENABLE="a.b"
// Everything defaults on; flags are selectively killable.

/** Merged project+global settings view, injected by @vegardx/pi-settings. */
export interface SettingsLayer {
	/** `undefined` => no opinion at this layer (fall through). */
	extensionEnabled(name: string): boolean | undefined;
	/** `undefined` => no opinion at this layer (fall through). */
	flagEnabled(path: string): boolean | undefined;
}

let settingsLayer: SettingsLayer | undefined;

/** Wire the project/global settings layer. Called by @vegardx/pi-settings. */
export function setSettingsLayer(layer: SettingsLayer | undefined): void {
	settingsLayer = layer;
}

function envVarName(name: string): string {
	return `PI_EXT_${name.replace(/-/g, "_").toUpperCase()}`;
}

function parseBool(raw: string | undefined): boolean | undefined {
	if (raw === undefined) return undefined;
	const v = raw.trim().toLowerCase();
	if (v === "1" || v === "on" || v === "true" || v === "yes") return true;
	if (v === "0" || v === "off" || v === "false" || v === "no") return false;
	return undefined;
}

function envPathSet(name: string): Set<string> {
	const raw = process.env[name];
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

/** Whole-extension gate. Defaults on. */
export function isExtensionEnabled(name: string): boolean {
	const fromEnv = parseBool(process.env[envVarName(name)]);
	if (fromEnv !== undefined) return fromEnv;
	const fromSettings = settingsLayer?.extensionEnabled(name);
	if (typeof fromSettings === "boolean") return fromSettings;
	return true;
}

/**
 * Single-feature gate. A disabled extension disables all its flags. At the
 * env layer the kill switch (PI_DISABLE) wins over PI_ENABLE — fail safe.
 */
export function isFlagEnabled(name: string, flag: string): boolean {
	if (!isExtensionEnabled(name)) return false;
	const path = `${name}.${flag}`;
	if (envPathSet("PI_DISABLE").has(path)) return false;
	if (envPathSet("PI_ENABLE").has(path)) return true;
	const fromSettings = settingsLayer?.flagEnabled(path);
	if (typeof fromSettings === "boolean") return fromSettings;
	return true;
}

/** Per-extension flag checker handed to the factory via the maestro context. */
export interface FlagChecker {
	enabled(flag: string): boolean;
}

export function createFlagChecker(name: string): FlagChecker {
	return { enabled: (flag) => isFlagEnabled(name, flag) };
}
