// Normalized scalar settings helpers shared by scripted and interactive surfaces.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	getSessionSettingOverride,
	type ModelConfigScope,
	type SessionSettingValue,
	type SettingDeclaration,
	setSessionSettingOverride,
} from "@vegardx/pi-contracts";
import { isPlainObject, readPath } from "./reader.js";
import { updateSettingsFile, writeExtensionConfigKey } from "./writer.js";

export type MaestroScope = ModelConfigScope;
export interface LayeredValue<T> {
	readonly global?: T;
	readonly project?: T;
	readonly session?: T;
	readonly effective?: T;
	readonly source?: MaestroScope | "default";
}

export function parseStringList(raw: string): readonly string[] | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) return parsed;
	} catch {}
	const values = raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
	return values.length ? values : undefined;
}

export function parseSettingValue(raw: string): SessionSettingValue {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "boolean" ||
			typeof parsed === "number" ||
			typeof parsed === "string" ||
			(Array.isArray(parsed) && parsed.every((value) => typeof value === "string"))
		) return parsed;
	} catch {}
	return raw;
}

export function formatSettingValue(value: unknown): string {
	if (value === undefined) return "—";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.join(" → ");
	return JSON.stringify(value);
}

export function validateDeclaredValue(
	declaration: SettingDeclaration,
	value: SessionSettingValue | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	if (declaration.type === "boolean" && typeof value !== "boolean") return "must be boolean";
	if (declaration.type === "number" && typeof value !== "number") return "must be number";
	if (declaration.type === "string" && typeof value !== "string") return "must be string";
	if (declaration.type === "string-list" && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) return "must be a string list";
	if (declaration.type === "choice" && !declaration.options?.some((option) => option.value === value)) return "must be one declared choice";
	return undefined;
}

export function readDeclaredValue(
	cwd: string,
	extension: string,
	declaration: SettingDeclaration,
): LayeredValue<SessionSettingValue> {
	const manager = SettingsManager.create(cwd);
	const path = ["extensionConfig", extension, ...declaration.key.split(".")];
	const global = readPath(manager.getGlobalSettings(), path) as SessionSettingValue | undefined;
	const project = readPath(manager.getProjectSettings(), path) as SessionSettingValue | undefined;
	const session = getSessionSettingOverride(`${extension}.${declaration.key}`);
	return {
		global,
		project,
		session,
		effective: session ?? project ?? global ?? declaration.default,
		source: session !== undefined ? "session" : project !== undefined ? "project" : global !== undefined ? "global" : "default",
	};
}

export function readAdvancedValue(
	cwd: string,
	extension: string,
	key: string,
): LayeredValue<SessionSettingValue> {
	const manager = SettingsManager.create(cwd);
	const path = ["extensionConfig", extension, ...key.split(".")];
	const global = readPath(manager.getGlobalSettings(), path) as SessionSettingValue | undefined;
	const project = readPath(manager.getProjectSettings(), path) as SessionSettingValue | undefined;
	const session = getSessionSettingOverride(`${extension}.${key}`);
	return {
		global,
		project,
		session,
		effective: session ?? project ?? global,
		source: session !== undefined ? "session" : project !== undefined ? "project" : global !== undefined ? "global" : undefined,
	};
}

export function writeAdvancedValue(
	cwd: string,
	extension: string,
	key: string,
	scope: MaestroScope,
	value: SessionSettingValue | undefined,
): void {
	if (scope === "session") {
		setSessionSettingOverride(`${extension}.${key}`, value);
		return;
	}
	writeExtensionConfigKey(scope, cwd, extension, key, value);
}

export function writeDomainPath(
	cwd: string,
	scope: Exclude<MaestroScope, "session">,
	path: readonly string[],
	value: unknown,
): void {
	updateSettingsFile(scope, cwd, undefined, (raw) => {
		let cursor = raw;
		for (const part of path.slice(0, -1)) {
			if (!isPlainObject(cursor[part])) cursor[part] = {};
			cursor = cursor[part] as Record<string, unknown>;
		}
		const leaf = path.at(-1);
		if (!leaf) return;
		if (value === undefined) delete cursor[leaf];
		else cursor[leaf] = value;
	});
}
