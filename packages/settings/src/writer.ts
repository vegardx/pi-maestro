// Atomic writer for extensionConfig keys.
//
// pi's SettingsManager exposes no setters for extensionConfig, so we
// round-trip the raw JSON ourselves (preserving every other key verbatim —
// a SettingsManager round-trip would re-emit only its typed subset and drop
// the rest). Unlike the pi-extensions writer, this one is atomic: we write a
// sibling temp file and rename it over the target, so a crash mid-write can
// never leave a half-written settings.json.

import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SettingsScope = "project" | "global";

export function settingsPath(
	scope: SettingsScope,
	cwd: string,
	agentDir?: string,
): string {
	if (scope === "project") return join(cwd, ".pi", "settings.json");
	return join(agentDir ?? getAgentDir(), "settings.json");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Reject segments that would let a crafted key walk into Object.prototype.
const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function assertSafeSegments(segments: readonly string[]): void {
	for (const segment of segments) {
		if (segment.length === 0) {
			throw new Error("settings-writer: empty key segment");
		}
		if (UNSAFE_SEGMENTS.has(segment)) {
			throw new Error(
				`settings-writer: refusing prototype-polluting segment "${segment}"`,
			);
		}
	}
}

function readRawObject(path: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return isPlainObject(parsed) ? parsed : {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
}

function writeAtomic(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(
		dirname(path),
		`.${
			path.split("/").pop() ?? "settings.json"
		}.tmp-${process.pid}-${Date.now().toString(36)}`,
	);
	writeFileSync(tmp, contents);
	try {
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// best effort cleanup
		}
		throw err;
	}
}

function setPath(
	root: Record<string, unknown>,
	parts: string[],
	value: unknown,
): unknown {
	let current = root;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		const next = current[part];
		if (!isPlainObject(next)) current[part] = {};
		current = current[part] as Record<string, unknown>;
	}
	const leaf = parts[parts.length - 1];
	const previous = current[leaf];
	current[leaf] = value;
	return previous;
}

function deletePath(root: Record<string, unknown>, parts: string[]): unknown {
	const chain: Array<{ obj: Record<string, unknown>; key: string }> = [];
	let current = root;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		const next = current[part];
		if (!isPlainObject(next)) return undefined;
		chain.push({ obj: current, key: part });
		current = next;
	}
	const leaf = parts[parts.length - 1];
	const previous = current[leaf];
	delete current[leaf];
	for (let i = chain.length - 1; i >= 0; i--) {
		const { obj, key } = chain[i];
		if (Object.keys(obj[key] as Record<string, unknown>).length > 0) break;
		delete obj[key];
	}
	return previous;
}

export interface WriteResult {
	path: string;
	previous: unknown;
}

/**
 * Read a settings file, let `mutate` modify the parsed object in place, and
 * write it back atomically (temp file + rename). The single atomic-write
 * primitive — `writeExtensionConfigKey` and @vegardx/pi-models'
 * background-model writer both route through it, so there is exactly one
 * crash-safe write path. Returns the resolved file path.
 */
export function updateSettingsFile(
	scope: SettingsScope,
	cwd: string,
	agentDir: string | undefined,
	mutate: (raw: Record<string, unknown>) => void,
): { path: string } {
	const path = settingsPath(scope, cwd, agentDir);
	const raw = readRawObject(path);
	mutate(raw);
	writeAtomic(path, `${JSON.stringify(raw, null, 2)}\n`);
	return { path };
}

export function readExtensionConfigKey(
	scope: SettingsScope,
	cwd: string,
	name: string,
	key: string,
	agentDir?: string,
): unknown {
	const raw = readRawObject(settingsPath(scope, cwd, agentDir));
	const ec = raw.extensionConfig;
	if (!isPlainObject(ec)) return undefined;
	const entry = ec[name];
	if (!isPlainObject(entry)) return undefined;
	let current: unknown = entry;
	for (const part of key.split(".")) {
		if (!isPlainObject(current) || !Object.hasOwn(current, part)) {
			return undefined;
		}
		current = current[part];
	}
	return current;
}

/**
 * Set (or, when `value` is null, delete) `extensionConfig.<name>.<key>` in
 * the settings.json for `scope`, atomically. `key` may be dotted; nested
 * containers are created on write and pruned on delete, including the
 * per-extension entry and the `extensionConfig` object once empty.
 */
export function writeExtensionConfigKey(
	scope: SettingsScope,
	cwd: string,
	name: string,
	key: string,
	value: boolean | string | number | readonly string[] | null,
	agentDir?: string,
): WriteResult {
	const parts = key.split(".");
	assertSafeSegments([name, ...parts]);

	let previous: unknown;
	const { path } = updateSettingsFile(scope, cwd, agentDir, (raw) => {
		const extensionConfig = isPlainObject(raw.extensionConfig)
			? raw.extensionConfig
			: {};
		const entry = isPlainObject(extensionConfig[name])
			? (extensionConfig[name] as Record<string, unknown>)
			: {};

		if (value === null) {
			previous = deletePath(entry, parts);
			if (Object.keys(entry).length === 0) delete extensionConfig[name];
			else extensionConfig[name] = entry;
		} else {
			previous = setPath(entry, parts, value as unknown);
			extensionConfig[name] = entry;
		}

		if (Object.keys(extensionConfig).length === 0) delete raw.extensionConfig;
		else raw.extensionConfig = extensionConfig;
	});
	return { path, previous };
}
