// RunStore — durable per-run state under <runsRoot>/<runId>/:
//   status.json   the RunRecord (atomic temp-file + rename)
//   events.jsonl  the run-bus message log (append-only)
//   result.md     the final human-readable summary
//
// The store is rooted at a directory the caller computes (typically
// <agentDir>/maestro/runs/<repo>); it owns no path policy beyond the per-run
// layout. Status changes are validated against the run state machine.

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	RUN_RECORD_SCHEMA_VERSION,
	type RunBusMessage,
	type RunId,
	type RunRecord,
	type RunResult,
	type RunStatus,
	type StopRecord,
} from "@vegardx/pi-contracts";
import { assertTransition, isTerminal } from "./state-machine.js";

const STATUS = "status.json";
const EVENTS = "events.jsonl";
const RESULT = "result.md";

export class UnsupportedRunStateError extends Error {
	constructor(found: unknown) {
		super(
			`Unsupported Maestro run state schema ${String(found)} (expected ${RUN_RECORD_SCHEMA_VERSION}). ` +
				"This release is a full cutover; archive or reset the old Maestro run state and retry.",
		);
		this.name = "UnsupportedRunStateError";
	}
}

function stopFor(
	status: RunStatus,
	at: number,
	result?: RunResult,
): StopRecord | undefined {
	if (!isTerminal(status)) return undefined;
	const kind =
		status === "succeeded"
			? "completed"
			: status === "failed"
				? "failed"
				: status === "canceled"
					? "canceled"
					: status === "timed-out"
						? "timed-out"
						: "interrupted";
	return (
		result?.stop ?? {
			kind,
			completedAt: at,
			reason: result?.error,
			recoverable: status === "failed",
		}
	);
}

export interface RunStore {
	readonly root: string;
	create(record: RunRecord): void;
	setStatus(runId: RunId, status: RunStatus, at?: number): RunRecord;
	setResult(runId: RunId, result: RunResult, at?: number): RunRecord;
	setMetadata(
		runId: RunId,
		metadata: NonNullable<RunRecord["metadata"]>,
		at?: number,
	): RunRecord;
	setLastEventAt(runId: RunId, at?: number): RunRecord;
	appendEvent(runId: RunId, message: RunBusMessage): void;
	writeResult(runId: RunId, markdown: string): void;
	readResult(runId: RunId): string | undefined;
	readRecord(runId: RunId): RunRecord | undefined;
	readEvents(runId: RunId): RunBusMessage[];
	list(): RunRecord[];
	remove(runId: RunId): void;
}

export function createRunStore(root: string): RunStore {
	const dir = (runId: RunId) => join(root, runId);
	// Run dirs are created once and never removed while a run is live —
	// re-issuing mkdirSync on every event append doubled the sync fs work on
	// the hottest path in the process.
	const dirsEnsured = new Set<RunId>();
	const ensureDir = (runId: RunId): string => {
		const d = dir(runId);
		if (!dirsEnsured.has(runId)) {
			mkdirSync(d, { recursive: true });
			dirsEnsured.add(runId);
		}
		return d;
	};

	function writeRecord(record: RunRecord): void {
		const d = ensureDir(record.id);
		const path = join(d, STATUS);
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(record, null, 2));
		renameSync(tmp, path);
	}

	function read(runId: RunId): RunRecord | undefined {
		const path = join(dir(runId), STATUS);
		if (!existsSync(path)) return undefined;
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return undefined;
		}
		if (
			typeof value !== "object" ||
			value === null ||
			(value as { schemaVersion?: unknown }).schemaVersion !==
				RUN_RECORD_SCHEMA_VERSION
		) {
			throw new UnsupportedRunStateError(
				(value as { schemaVersion?: unknown } | null)?.schemaVersion ??
					"missing",
			);
		}
		return value as RunRecord;
	}

	function mutate(
		runId: RunId,
		fn: (record: RunRecord) => RunRecord,
	): RunRecord {
		const current = read(runId);
		if (!current) throw new Error(`unknown run: ${runId}`);
		const next = fn(current);
		writeRecord(next);
		return next;
	}

	return {
		root,

		create(record) {
			if (record.schemaVersion !== RUN_RECORD_SCHEMA_VERSION) {
				throw new UnsupportedRunStateError(record.schemaVersion);
			}
			writeRecord(record);
		},

		setStatus(runId, status, at = Date.now()) {
			return mutate(runId, (record) => {
				assertTransition(record.status, status);
				const stop = stopFor(status, at);
				return {
					...record,
					status,
					updatedAt: at,
					...(stop && record.completedAt === undefined
						? { completedAt: at, stop }
						: {}),
				};
			});
		},

		setResult(runId, result, at = Date.now()) {
			return mutate(runId, (record) => {
				assertTransition(record.status, result.status);
				const stop = stopFor(result.status, at, result);
				return {
					...record,
					status: result.status,
					result,
					updatedAt: at,
					completedAt: record.completedAt ?? at,
					stop: record.stop ?? stop,
				};
			});
		},

		setMetadata(runId, metadata, at = Date.now()) {
			return mutate(runId, (record) => ({
				...record,
				metadata,
				updatedAt: at,
			}));
		},

		setLastEventAt(runId, at = Date.now()) {
			return mutate(runId, (record) => ({
				...record,
				lastEventAt: at,
				updatedAt: Math.max(record.updatedAt, at),
			}));
		},

		appendEvent(runId, message) {
			const d = ensureDir(runId);
			appendFileSync(join(d, EVENTS), `${JSON.stringify(message)}\n`);
		},

		writeResult(runId, markdown) {
			const d = ensureDir(runId);
			writeFileSync(join(d, RESULT), markdown);
		},

		readResult(runId) {
			const path = join(dir(runId), RESULT);
			return existsSync(path) ? readFileSync(path, "utf8") : undefined;
		},

		readRecord: read,

		readEvents(runId) {
			const path = join(dir(runId), EVENTS);
			if (!existsSync(path)) return [];
			const out: RunBusMessage[] = [];
			for (const line of readFileSync(path, "utf8").split("\n")) {
				if (line.trim() === "") continue;
				try {
					out.push(JSON.parse(line) as RunBusMessage);
				} catch {
					// skip a torn trailing line rather than failing the whole read
				}
			}
			return out;
		},

		list() {
			if (!existsSync(root)) return [];
			const out: RunRecord[] = [];
			for (const name of readdirSync(root)) {
				if (!statSync(join(root, name)).isDirectory()) continue;
				const record = read(name as RunId);
				if (record) out.push(record);
			}
			return out;
		},

		remove(runId) {
			dirsEnsured.delete(runId);
			rmSync(dir(runId), { recursive: true, force: true });
		},
	};
}
