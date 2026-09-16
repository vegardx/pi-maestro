// The record that says a plan-mode exit is in progress for this session.
//
// The exit flow is split by exactly one model turn: phase 1 asks the human what
// only a human knows and then asks the model for the document; phase 2 picks up
// when that document is stored. Nothing in a dialog sequence survives a model
// turn, so the thing that joins the two halves has to be on disk — and it has
// to be small enough that reading it is not a second source of truth about the
// plan. It holds the four facts phase 2 cannot recover: which session, the
// policy the human chose, the one-line intent, and when.
//
// NOTHING UNREADABLE IS TREATED AS ABSENT. `null` means no exit is in progress;
// a file that exists but does not parse, speaks another schema version, or names
// another session is a `PendingExitError`, because answering "absent" to it
// would silently reopen the plan-tool window on a record nobody can check. That
// is the same rule `store.ts` applies to a plan file, for the same reason.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pendingExitFile, pendingExitRoot, SESSION_ID_RE } from "./paths.js";
import { type PlanPolicy, validatePolicy } from "./plan.js";

/** The policy errors, as a list; `validatePolicy` accumulates into one. */
function policyErrors(policy: PlanPolicy): string[] {
	const errors: string[] = [];
	validatePolicy(policy, errors);
	return errors;
}

/** Bumped when the record's shape changes incompatibly. */
export const PENDING_EXIT_SCHEMA_VERSION = 1 as const;

/**
 * An exit in progress: the mode has moved, the model has been asked for the
 * document, and nothing else has happened yet.
 */
export interface PendingExit {
	readonly schemaVersion: typeof PENDING_EXIT_SCHEMA_VERSION;
	readonly sessionId: string;
	/** Exactly the policy block the model was told to copy into the plan. */
	readonly policy: PlanPolicy;
	/** The human's one line, for the review that phase 2 will ask for. */
	readonly intent: string;
	readonly createdAt: string;
}

/** A record that exists but cannot be believed. Never swallowed. */
export class PendingExitError extends Error {
	constructor(
		message: string,
		readonly path?: string,
	) {
		super(message);
		this.name = "PendingExitError";
	}
}

/** The longest intent the record will hold; a review prompt gets one line. */
export const MAX_INTENT_LENGTH = 512;

function checkSessionId(sessionId: string): void {
	if (!SESSION_ID_RE.test(sessionId))
		throw new PendingExitError(
			`\`${sessionId}\` is not a usable session id, and it would become a filename.`,
		);
}

function malformed(path: string, why: string): PendingExitError {
	return new PendingExitError(
		`${path} is not a usable pending-exit record: ${why}. ` +
			"Delete the file to start the exit over.",
		path,
	);
}

/**
 * The record for this session, or `null` when there is none.
 *
 * @throws PendingExitError when a file is there and cannot be believed.
 */
export function readPendingExit(
	sessionId: string,
	agentDir?: string,
): PendingExit | null {
	checkSessionId(sessionId);
	const path = pendingExitFile(sessionId, agentDir);
	if (!existsSync(path)) return null;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw malformed(path, "it is not readable JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw malformed(path, "it is not a JSON object");
	const record = value as Partial<PendingExit>;
	if (record.schemaVersion !== PENDING_EXIT_SCHEMA_VERSION)
		throw malformed(
			path,
			`it was written by schema ${JSON.stringify(record.schemaVersion ?? "missing")} and this build speaks ${PENDING_EXIT_SCHEMA_VERSION}`,
		);
	if (record.sessionId !== sessionId)
		throw malformed(
			path,
			`it names session ${JSON.stringify(record.sessionId ?? "missing")}, not ${JSON.stringify(sessionId)}`,
		);
	if (typeof record.createdAt !== "string" || record.createdAt.length === 0)
		throw malformed(path, "it has no `createdAt`");
	if (typeof record.intent !== "string")
		throw malformed(path, "its `intent` is not a string");
	if (record.intent.length > MAX_INTENT_LENGTH)
		throw malformed(
			path,
			`its \`intent\` is ${record.intent.length} characters, past the ${MAX_INTENT_LENGTH} bound`,
		);
	if (
		typeof record.policy !== "object" ||
		record.policy === null ||
		Array.isArray(record.policy)
	)
		throw malformed(path, "its `policy` is not an object");
	// The same validator the plan document's own policy goes through, so a
	// record and the plan it produced cannot disagree about what is legal.
	const errors = policyErrors(record.policy as PlanPolicy);
	if (errors.length > 0)
		throw malformed(path, `its \`policy\` is invalid — ${errors.join("; ")}`);
	return {
		schemaVersion: PENDING_EXIT_SCHEMA_VERSION,
		sessionId,
		policy: record.policy as PlanPolicy,
		intent: record.intent,
		createdAt: record.createdAt,
	};
}

/** Is an exit in progress? Propagates `PendingExitError`; see `readPendingExit`. */
export function hasPendingExit(sessionId: string, agentDir?: string): boolean {
	return readPendingExit(sessionId, agentDir) !== null;
}

let writeCounter = 0;

/**
 * Write the record, refusing one this build could not read back.
 *
 * Returns the path, because every caller that writes one also wants to say
 * where it went.
 */
export function writePendingExit(
	record: PendingExit,
	agentDir?: string,
): string {
	checkSessionId(record.sessionId);
	if (record.schemaVersion !== PENDING_EXIT_SCHEMA_VERSION)
		throw new PendingExitError(
			`refusing to write schema ${String(record.schemaVersion)}; this build speaks ${PENDING_EXIT_SCHEMA_VERSION}`,
		);
	if (record.intent.length > MAX_INTENT_LENGTH)
		throw new PendingExitError(
			`refusing to write an intent of ${record.intent.length} characters, past the ${MAX_INTENT_LENGTH} bound`,
		);
	const errors = policyErrors(record.policy);
	if (errors.length > 0)
		throw new PendingExitError(
			`refusing to write an invalid policy:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
		);
	const path = pendingExitFile(record.sessionId, agentDir);
	mkdirSync(dirname(path), { recursive: true });
	// tmp + rename, as the plan store does: a reader sees the old record or the
	// new one, never half of either and never the empty file a crash leaves.
	const tmp = `${path}.${process.pid}.${writeCounter++}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
	return path;
}

/** Drop the record. Idempotent: no exit in progress is the normal state. */
export function deletePendingExit(sessionId: string, agentDir?: string): void {
	checkSessionId(sessionId);
	rmSync(pendingExitFile(sessionId, agentDir), { force: true });
}

/** `<agentDir>/maestro/plans/.pending`, for a caller that wants to say where. */
export function pendingExitDir(agentDir?: string): string {
	return pendingExitRoot(agentDir);
}
