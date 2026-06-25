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
import type {
	RunBusMessage,
	RunId,
	RunRecord,
	RunResult,
	RunStatus,
} from "@vegardx/pi-contracts";
import { assertTransition } from "./state-machine.js";

const STATUS = "status.json";
const EVENTS = "events.jsonl";
const RESULT = "result.md";

export interface RunStore {
	readonly root: string;
	create(record: RunRecord): void;
	setStatus(runId: RunId, status: RunStatus, at?: number): RunRecord;
	setResult(runId: RunId, result: RunResult, at?: number): RunRecord;
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

	function writeRecord(record: RunRecord): void {
		const d = dir(record.id);
		mkdirSync(d, { recursive: true });
		const path = join(d, STATUS);
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(record, null, 2));
		renameSync(tmp, path);
	}

	function read(runId: RunId): RunRecord | undefined {
		const path = join(dir(runId), STATUS);
		if (!existsSync(path)) return undefined;
		try {
			return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
		} catch {
			return undefined;
		}
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
			writeRecord(record);
		},

		setStatus(runId, status, at = Date.now()) {
			return mutate(runId, (record) => {
				assertTransition(record.status, status);
				return { ...record, status, updatedAt: at };
			});
		},

		setResult(runId, result, at = Date.now()) {
			return mutate(runId, (record) => {
				assertTransition(record.status, result.status);
				return {
					...record,
					status: result.status,
					result,
					updatedAt: at,
				};
			});
		},

		appendEvent(runId, message) {
			const d = dir(runId);
			mkdirSync(d, { recursive: true });
			appendFileSync(join(d, EVENTS), `${JSON.stringify(message)}\n`);
		},

		writeResult(runId, markdown) {
			const d = dir(runId);
			mkdirSync(d, { recursive: true });
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
			rmSync(dir(runId), { recursive: true, force: true });
		},
	};
}
