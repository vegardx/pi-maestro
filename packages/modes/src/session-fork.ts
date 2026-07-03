// Session forking primitives: parse JSONL session files, extract linear paths,
// create forked sessions, and append entries. Used by the analyze phase and
// lens/worker checkpoint forking.

import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	CustomEntry,
	CustomMessageEntry,
	SessionEntry,
	SessionHeader,
} from "@earendil-works/pi-coding-agent";

export interface ParsedSession {
	readonly header: SessionHeader;
	readonly entries: SessionEntry[];
}

/**
 * Parse a JSONL session file into its header and entries.
 * Skips empty lines and logs warnings for malformed JSON.
 */
export function parseSessionFile(path: string): ParsedSession {
	const content = readFileSync(path, "utf8");
	const lines = content.split("\n").filter((line) => line.trim() !== "");
	if (lines.length === 0) {
		throw new Error(`Empty session file: ${path}`);
	}

	const header = JSON.parse(lines[0]) as SessionHeader;
	if (header.type !== "session") {
		throw new Error(
			`Invalid session file: first line must be type "session", got "${header.type}"`,
		);
	}

	const entries: SessionEntry[] = [];
	for (let i = 1; i < lines.length; i++) {
		try {
			entries.push(JSON.parse(lines[i]) as SessionEntry);
		} catch {
			// Skip malformed lines — log would go here in production
		}
	}

	return { header, entries };
}

/**
 * Walk entries from the start up to (and including) the entry with targetId.
 * Follows the linear parentId chain. Returns the ordered slice.
 *
 * For linear sessions (single branch), this is simply all entries up to the target.
 * For tree sessions, this walks the parentId chain from the target back to root.
 */
export function pathToEntry(
	entries: readonly SessionEntry[],
	targetId: string,
): SessionEntry[] {
	// Build a lookup map
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
	}

	const target = byId.get(targetId);
	if (!target) {
		throw new Error(`Entry not found: ${targetId}`);
	}

	// Walk from target back to root via parentId
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = target;
	while (current) {
		path.unshift(current);
		if (current.parentId === null) break;
		current = byId.get(current.parentId);
	}

	return path;
}

export interface ForkOptions {
	/** Override cwd in the forked session header. */
	readonly cwd?: string;
	/** Custom session id for the fork. Defaults to a new UUID. */
	readonly id?: string;
}

/**
 * Create a new session file by forking from a source at a specific entry.
 * The fork contains the header (optionally with overridden cwd) and all entries
 * in the path to the target entry.
 *
 * Returns the path to the newly created session file.
 */
export function forkSessionAt(
	sourceFile: string,
	targetEntryId: string,
	outputDir: string,
	opts?: ForkOptions,
): string {
	const { header, entries } = parseSessionFile(sourceFile);
	const path = pathToEntry(entries, targetEntryId);

	const forkedHeader: SessionHeader = {
		...header,
		id: opts?.id ?? randomUUID(),
		timestamp: new Date().toISOString(),
		parentSession: header.id,
		...(opts?.cwd !== undefined && { cwd: opts.cwd }),
	};

	mkdirSync(outputDir, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const shortId = randomUUID().slice(0, 8);
	const outputFile = join(outputDir, `fork_${timestamp}_${shortId}.jsonl`);

	const lines = [
		JSON.stringify(forkedHeader),
		...path.map((entry) => JSON.stringify(entry)),
	];
	writeFileSync(outputFile, `${lines.join("\n")}\n`);

	return outputFile;
}

/**
 * Append entries as JSONL lines to an existing session file.
 * Used to add modes state, execution seed, or persona overrides after forking.
 */
export function appendToSession(
	sessionFile: string,
	entries: readonly (SessionEntry | CustomEntry | CustomMessageEntry)[],
): void {
	const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
	appendFileSync(sessionFile, `${lines}\n`);
}

/**
 * Build a custom entry (non-LLM-visible) for use with appendToSession.
 */
export function buildCustomEntry<T = unknown>(
	customType: string,
	data: T,
	parentId: string | null,
): CustomEntry<T> {
	return {
		type: "custom",
		customType,
		data,
		id: randomUUID().slice(0, 8),
		parentId,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Build a custom message entry (LLM-visible) for use with appendToSession.
 */
export function buildCustomMessageEntry(
	customType: string,
	content: string,
	parentId: string | null,
	opts?: { display?: boolean },
): CustomMessageEntry {
	return {
		type: "custom_message",
		customType,
		content,
		display: opts?.display ?? false,
		id: randomUUID().slice(0, 8),
		parentId,
		timestamp: new Date().toISOString(),
	};
}
