// The record that says a plan-mode exit is in progress for this session.
//
// The exit flow is split by exactly one model turn: phase 1 asks the human what
// only a human knows and then asks the model for the document; phase 2 picks up
// when that document is stored. Nothing in a dialog sequence survives a model
// turn, so the thing that joins the two halves has to be on disk — and it has
// to be small enough that reading it is not a second source of truth about the
// plan. It holds the facts the turns either side of it cannot recover: which
// session, the policy the dialogs settled, the posture the human asked for and
// has not been given yet, the agreed description once there is one, how many
// blind reviews the plan has already had, and when.
//
// THE MODE HAS NOT MOVED WHILE THIS EXISTS. `wanted` is the posture the human
// asked for at `/mode auto`; the seat stays in plan mode until the run starts,
// so the record is also the only place that answers "where were we going?".
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
import { EXIT_MODES, type ExitMode, isExitMode } from "./mode.js";
import { pendingExitFile, pendingExitRoot, SESSION_ID_RE } from "./paths.js";
import { type PlanPolicy, validatePolicy } from "./plan.js";

/** The policy errors, as a list; `validatePolicy` accumulates into one. */
function policyErrors(policy: PlanPolicy): string[] {
	const errors: string[] = [];
	validatePolicy(policy, errors);
	return errors;
}

/**
 * Bumped when the record's shape changes incompatibly.
 *
 * 2 added `wanted` and made `intent` optional, because the mode no longer moves
 * at the start of the exit and the description is agreed one model turn later.
 * There is NO compatibility reader for 1: a v1 record says the posture already
 * changed, which is a claim this build would act on and cannot check.
 *
 * `reviews` arrived inside 2 and did NOT bump it: a record written without one
 * has had no blind review, which is exactly what its absence reads as, so there
 * is nothing an older record would make this build believe wrongly.
 */
export const PENDING_EXIT_SCHEMA_VERSION = 2 as const;

/**
 * An exit in progress: the questions are answered, the posture has NOT moved,
 * and the model has been asked either for the description or for the document.
 */
export interface PendingExit {
	readonly schemaVersion: typeof PENDING_EXIT_SCHEMA_VERSION;
	readonly sessionId: string;
	/**
	 * Exactly the policy block the model will be told to copy into the plan —
	 * the effort the human chose, the default gates, and the publication this
	 * repository derives (`publish.mode` and `publish.base`).
	 */
	readonly policy: PlanPolicy;
	/** The posture the human asked for, given only when the run starts. */
	readonly wanted: ExitMode;
	/**
	 * The agreed description: two or three sentences the model wrote and the
	 * human agreed to. ABSENT until it is agreed, and its absence is what holds
	 * the `plan` tool shut — there is nothing yet for a blind reviewer to check
	 * the plan against.
	 */
	readonly intent?: string;
	/**
	 * How many blind reviews this exit has already spent.
	 *
	 * ON THE RECORD because the loop crosses model turns: *Revise with the
	 * model* ends phase 2 with the record still open, the model rewrites the
	 * plan, and the `plan` call that stores it starts phase 2 again from
	 * nothing. A count that lived in phase 2's own stack would restart at zero
	 * every time round, which is a bound that never binds. Absent reads as 0.
	 */
	readonly reviews?: number;
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

/**
 * The longest agreed description the record will hold.
 *
 * Two or three sentences, and this is the bound `plan_intent` refuses past: a
 * yardstick a blind reviewer has to hold in mind alongside the whole plan stops
 * being a yardstick somewhere around here.
 */
export const MAX_INTENT_LENGTH = 600;

/** A count of reviews: a whole number of them, and never a negative one. */
function isReviewCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

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
	if (!isExitMode(record.wanted))
		throw malformed(
			path,
			`its \`wanted\` is ${JSON.stringify(record.wanted ?? "missing")}, not one of ${EXIT_MODES.join(", ")}`,
		);
	if (record.intent !== undefined) {
		if (typeof record.intent !== "string")
			throw malformed(path, "its `intent` is not a string");
		if (record.intent.length > MAX_INTENT_LENGTH)
			throw malformed(
				path,
				`its \`intent\` is ${record.intent.length} characters, past the ${MAX_INTENT_LENGTH} bound`,
			);
	}
	if (record.reviews !== undefined && !isReviewCount(record.reviews))
		throw malformed(
			path,
			`its \`reviews\` is ${JSON.stringify(record.reviews)}, not a count of blind reviews`,
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
		wanted: record.wanted,
		...(record.intent === undefined ? {} : { intent: record.intent }),
		...(record.reviews === undefined ? {} : { reviews: record.reviews }),
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
	if (!isExitMode(record.wanted))
		throw new PendingExitError(
			`refusing to write \`wanted\` ${JSON.stringify(record.wanted)}; one of ${EXIT_MODES.join(", ")}`,
		);
	if (record.intent !== undefined && record.intent.length > MAX_INTENT_LENGTH)
		throw new PendingExitError(
			`refusing to write an intent of ${record.intent.length} characters, past the ${MAX_INTENT_LENGTH} bound`,
		);
	if (record.reviews !== undefined && !isReviewCount(record.reviews))
		throw new PendingExitError(
			`refusing to write \`reviews\` ${JSON.stringify(record.reviews)}; it is a count of blind reviews`,
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
