// Knowledge session: the frozen shared cache prefix every execution agent
// forks from. Built once at the plan→implement boundary from a fixed template
// (any later byte change would invalidate every agent's prompt cache), stored
// as a two-line JSONL pi session: header + one custom_message entry.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionHeader } from "@earendil-works/pi-coding-agent";
import { buildCustomMessageEntry, parseSessionFile } from "../session-fork.js";

export const KNOWLEDGE_CUSTOM_TYPE = "maestro.base-knowledge";
export const KNOWLEDGE_SESSION_VERSION = 3;

export const KNOWLEDGE_SECTIONS = [
	"Project Structure",
	"Key Patterns",
	"Conventions",
	"Key Interfaces",
] as const;

export const KNOWLEDGE_END =
	"> END OF CODEBASE REFERENCE — everything above is context. Your work " +
	"instructions arrive separately and are framed as such.";

export const KNOWLEDGE_FRAME =
	"# Codebase Reference\n" +
	"> CONTEXT ONLY — This describes the codebase structure and patterns. " +
	"Do not interpret this as work to perform. Your tasks follow separately.";

/** Section skeleton the knowledge doc must be authored into. */
export const KNOWLEDGE_TEMPLATE = `${KNOWLEDGE_FRAME}\n\n${KNOWLEDGE_SECTIONS.map(
	(section) => `## ${section}\n`,
).join("\n")}`;

// ─── Shape validation ────────────────────────────────────────────────────────

/**
 * Validate a knowledge doc against the fixed template shape: framing header,
 * CONTEXT ONLY frame, and all required sections present and non-empty.
 * Returns a list of problems; empty means valid.
 */
export function validateKnowledgeDoc(content: string): string[] {
	const problems: string[] = [];
	const lines = content.split("\n");

	if (!lines.some((line) => line.trim() === "# Codebase Reference")) {
		problems.push('missing "# Codebase Reference" header');
	}
	if (!lines.some((line) => line.trim().startsWith("> CONTEXT ONLY"))) {
		problems.push("missing the CONTEXT ONLY framing line");
	}

	for (const section of KNOWLEDGE_SECTIONS) {
		const start = lines.findIndex((line) => line.trim() === `## ${section}`);
		if (start === -1) {
			problems.push(`missing section "## ${section}"`);
			continue;
		}
		let end = lines.length;
		for (let i = start + 1; i < lines.length; i++) {
			if (/^##?\s/.test(lines[i].trim())) {
				end = i;
				break;
			}
		}
		const body = lines
			.slice(start + 1, end)
			.join("\n")
			.trim();
		if (body === "") {
			problems.push(`section "## ${section}" is empty`);
		}
	}

	return problems;
}

// ─── Build / read ────────────────────────────────────────────────────────────

export interface BuildKnowledgeSessionOpts {
	/** The knowledge doc (must pass validateKnowledgeDoc). */
	content: string;
	/** Repo the session's cwd points at. */
	repoPath: string;
	/** Destination JSONL path (parent dirs are created). */
	outPath: string;
	/** Session id override; defaults to "base-<uuid>". */
	id?: string;
}

export interface KnowledgeSession {
	id: string;
	cwd: string;
	content: string;
	/** Entry id of the base-knowledge message (fork parent for appends). */
	entryId: string;
	path: string;
}

/**
 * Write the knowledge session JSONL: a version-3 session header plus one
 * LLM-visible custom_message carrying the knowledge doc. Throws if the doc
 * fails shape validation — a malformed doc must never become the frozen base.
 */
export function buildKnowledgeSession(
	opts: BuildKnowledgeSessionOpts,
): KnowledgeSession {
	const problems = validateKnowledgeDoc(opts.content);
	if (problems.length > 0) {
		throw new Error(
			`knowledge doc failed shape validation:\n- ${problems.join("\n- ")}`,
		);
	}
	const content = opts.content.trimEnd().endsWith(KNOWLEDGE_END)
		? opts.content
		: `${opts.content.trimEnd()}\n\n${KNOWLEDGE_END}\n`;

	const id = opts.id ?? `base-${randomUUID()}`;
	const header: SessionHeader = {
		type: "session",
		version: KNOWLEDGE_SESSION_VERSION,
		id,
		timestamp: new Date().toISOString(),
		cwd: opts.repoPath,
	};
	const entry = buildCustomMessageEntry(KNOWLEDGE_CUSTOM_TYPE, content, null, {
		display: true,
	});

	mkdirSync(dirname(opts.outPath), { recursive: true });
	writeFileSync(
		opts.outPath,
		`${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`,
	);

	return {
		id,
		cwd: opts.repoPath,
		content,
		entryId: entry.id,
		path: opts.outPath,
	};
}

/**
 * Parse a knowledge session back and re-validate it (header shape, presence
 * of the base-knowledge entry, doc shape). Throws on any problem — the base
 * is frozen, so a session that no longer round-trips means tampering.
 */
export function readKnowledgeSession(path: string): KnowledgeSession {
	const { header, entries } = parseSessionFile(path);

	if (header.version !== KNOWLEDGE_SESSION_VERSION) {
		throw new Error(
			`knowledge session ${path}: expected version ${KNOWLEDGE_SESSION_VERSION}, got ${header.version}`,
		);
	}
	if (!header.cwd) {
		throw new Error(`knowledge session ${path}: header has no cwd`);
	}

	const entry = entries.find(
		(e) =>
			e.type === "custom_message" && e.customType === KNOWLEDGE_CUSTOM_TYPE,
	);
	if (entry?.type !== "custom_message") {
		throw new Error(
			`knowledge session ${path}: no ${KNOWLEDGE_CUSTOM_TYPE} entry`,
		);
	}
	if (typeof entry.content !== "string") {
		throw new Error(
			`knowledge session ${path}: base-knowledge content is not a string`,
		);
	}

	const problems = validateKnowledgeDoc(entry.content);
	if (problems.length > 0) {
		throw new Error(
			`knowledge session ${path}: doc failed shape validation:\n- ${problems.join("\n- ")}`,
		);
	}

	return {
		id: header.id,
		cwd: header.cwd,
		content: entry.content,
		entryId: entry.id,
		path,
	};
}
