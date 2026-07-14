// Session-file primitives: validation-grade parsing plus a header-only
// bootstrap that hands the file to the pi SDK's SessionManager. Session
// assembly (fork + append) lives on the SDK; parseSessionFile stays a dumb
// reader on purpose — SessionManager.open() migrates old versions in place,
// and frozen files (the knowledge base) must fail loudly instead of being
// silently rewritten.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
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

export interface CreateSessionFileOpts {
	/** Session id; defaults to a new UUID. */
	readonly id?: string;
	/** Header version; defaults to the SDK's current session version. */
	readonly version?: number;
}

/**
 * Bootstrap a session file at an exact path and hand it to the SDK: write the
 * one-line header, then open it with SessionManager so subsequent appendXXX()
 * calls persist eagerly. SessionManager.create() can't be used here — it
 * defers file creation until the first assistant message, and these files
 * must exist on disk before `pi --session <file>` spawns.
 */
export function createSessionFileAt(
	path: string,
	cwd: string,
	opts?: CreateSessionFileOpts,
): SessionManager {
	const header: SessionHeader = {
		type: "session",
		version: opts?.version ?? CURRENT_SESSION_VERSION,
		id: opts?.id ?? randomUUID(),
		timestamp: new Date().toISOString(),
		cwd,
	};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(header)}\n`);
	return SessionManager.open(path);
}
