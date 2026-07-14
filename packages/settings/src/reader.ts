// Layered settings reader.
//
// We defer the *where* (file paths, agent dir, env overrides, future XDG
// changes) to pi's SettingsManager, and keep the *how* (pick our keys,
// merge project over global) local. pi's Settings type is closed (no
// extensionConfig), but the parsed JSON keeps unknown keys, so we cast at
// the boundary and validate shapes ourselves.
//
// Shape we read:
//   { "extensionConfig": { "<name>": { "enabled": bool,
//                                       "flags": { "<flag>": bool },
//                                       ...arbitrary knobs } } }

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { listSessionSettingOverrides } from "@vegardx/pi-contracts";

export type ExtensionConfig = Record<string, unknown>;
export type ExtensionConfigMap = Record<string, ExtensionConfig>;

export interface LayeredExtensionConfig {
	global: ExtensionConfigMap;
	project: ExtensionConfigMap;
	/** project merged over global, deep, project winning at the leaf. */
	merged: ExtensionConfigMap;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractExtensionConfig(raw: unknown): ExtensionConfigMap {
	if (!isPlainObject(raw)) return {};
	const ec = raw.extensionConfig;
	if (!isPlainObject(ec)) return {};
	const out: ExtensionConfigMap = {};
	for (const [name, value] of Object.entries(ec)) {
		if (isPlainObject(value)) out[name] = value;
	}
	return out;
}

function deepMerge(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const existing = out[key];
		out[key] =
			isPlainObject(existing) && isPlainObject(value)
				? deepMerge(existing, value)
				: value;
	}
	return out;
}

/**
 * Read the global and project `extensionConfig` slices plus the merged
 * view. Project wins at the leaf; sibling nested keys from each layer
 * survive (a shallow spread would let project's `<name>` object hide a
 * global flag the project didn't mention).
 */
export function readLayeredExtensionConfig(
	cwd: string,
	agentDir?: string,
): LayeredExtensionConfig {
	const manager = SettingsManager.create(cwd, agentDir);
	const global = extractExtensionConfig(manager.getGlobalSettings());
	const project = extractExtensionConfig(manager.getProjectSettings());

	const merged: ExtensionConfigMap = {};
	const names = new Set([...Object.keys(global), ...Object.keys(project)]);
	for (const name of names) {
		merged[name] = deepMerge(
			global[name] ?? {},
			project[name] ?? {},
		) as ExtensionConfig;
	}
	for (const override of listSessionSettingOverrides()) {
		if (!merged[override.extension]) merged[override.extension] = {};
		setPath(merged[override.extension], override.path, override.value);
	}
	return { global, project, merged };
}

// ---- Typed accessors ---------------------------------------------------
// Fail closed: a wrong-typed value returns the default rather than coercing,
// so a settings typo can't silently flip behaviour. `key` may be dotted.

function setPath(entry: ExtensionConfig, key: string, value: unknown): void {
	let current = entry;
	const parts = key.split(".");
	for (const part of parts.slice(0, -1)) {
		if (!isPlainObject(current[part])) current[part] = {};
		current = current[part] as Record<string, unknown>;
	}
	current[parts.at(-1)!] = value;
}

function readPath(entry: ExtensionConfig | undefined, key: string): unknown {
	if (!entry) return undefined;
	let current: unknown = entry;
	for (const part of key.split(".")) {
		if (!isPlainObject(current) || !Object.hasOwn(current, part)) {
			return undefined;
		}
		current = current[part];
	}
	return current;
}

export function getConfigBoolean(
	config: ExtensionConfigMap,
	name: string,
	key: string,
	defaultValue: boolean,
): boolean {
	const raw = readPath(config[name], key);
	return typeof raw === "boolean" ? raw : defaultValue;
}

export function getConfigString(
	config: ExtensionConfigMap,
	name: string,
	key: string,
	defaultValue: string,
): string {
	const raw = readPath(config[name], key);
	return typeof raw === "string" ? raw : defaultValue;
}

export function getConfigNumber(
	config: ExtensionConfigMap,
	name: string,
	key: string,
	defaultValue: number,
): number {
	const raw = readPath(config[name], key);
	return typeof raw === "number" && Number.isFinite(raw) ? raw : defaultValue;
}

export function getConfigStringArray(
	config: ExtensionConfigMap,
	name: string,
	key: string,
	defaultValue: readonly string[],
): readonly string[] {
	const raw = readPath(config[name], key);
	if (!Array.isArray(raw)) return defaultValue;
	if (raw.some((v) => typeof v !== "string")) return defaultValue;
	return raw as string[];
}

/**
 * Read a nested object from extensionConfig. Returns `undefined` when the
 * key is missing or the value is not a plain object (null, array, primitive).
 */
export function getConfigObject(
	config: ExtensionConfigMap,
	name: string,
	key: string,
): Record<string, unknown> | undefined {
	const raw = readPath(config[name], key);
	if (!isPlainObject(raw)) return undefined;
	return raw;
}
