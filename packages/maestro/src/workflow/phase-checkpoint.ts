// Seat-only phase checkpoints. This module turns the exact dirty state left by
// an implementation or decision phase into ordinary Git commits. Its journal
// lives below maestro-private state, never in workflow state or a worktree.

import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import {
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
	sep,
} from "node:path";
import { runCommand, stageAndCommit } from "@vegardx/pi-git";
import { currentDepth } from "../spawn.js";

export type WorkflowCheckpointPhase = "implementation" | "decision";

export interface WorkflowCheckpointRepository {
	readonly key: string;
	readonly worktree: string;
	readonly expectedBranch: string;
}

export interface WorkflowPhaseCheckpointInput {
	readonly runId: string;
	readonly phase: WorkflowCheckpointPhase;
	readonly repositories: readonly WorkflowCheckpointRepository[];
	readonly messages: Readonly<Record<string, string>>;
	/** Required for decisions and forbidden for implementation checkpoints. */
	readonly expectedChangedPaths?: Readonly<Record<string, readonly string[]>>;
}

export interface WorkflowCheckpointRepositoryResult {
	readonly repository: string;
	readonly worktree: string;
	readonly expectedBranch: string;
	readonly preHead: string;
	readonly finalHead: string;
	readonly changedPaths: readonly string[];
	/** Null means the repository was already clean at the phase boundary. */
	readonly commit: string | null;
}

export interface WorkflowPhaseCheckpointResult {
	readonly runId: string;
	readonly phase: WorkflowCheckpointPhase;
	readonly repositories: readonly WorkflowCheckpointRepositoryResult[];
	/** Directly consumable as ReviewDecisionLedger commit references. */
	readonly commitRefs: readonly {
		readonly repository: string;
		readonly commit: string;
	}[];
}

export interface WorkflowPhaseCheckpointOptions {
	readonly maestroStateRoot: string;
	/** Worktrees and workflow/scratch roots writable by descendants. */
	readonly descendantWritableRoots: readonly string[];
	/** Test seam; production authority is always resolved from process depth. */
	readonly depth?: () => number;
}

interface CanonicalCheckpointInput {
	readonly runId: string;
	readonly phase: WorkflowCheckpointPhase;
	readonly repositories: readonly {
		readonly key: string;
		readonly worktree: string;
		readonly expectedBranch: string;
		readonly message: string;
		readonly expectedChangedPaths: readonly string[] | null;
	}[];
}

interface PendingRepositoryRecord {
	readonly status: "pending";
	readonly key: string;
	readonly worktree: string;
	readonly expectedBranch: string;
	readonly message: string;
	readonly paths: readonly string[];
	readonly preHead: string;
}

interface CompletedRepositoryRecord {
	readonly status: "completed";
	readonly key: string;
	readonly worktree: string;
	readonly expectedBranch: string;
	readonly message: string;
	readonly paths: readonly string[];
	readonly preHead: string;
	readonly finalHead: string;
	readonly commit: string | null;
}

type RepositoryRecord = PendingRepositoryRecord | CompletedRepositoryRecord;

interface CheckpointJournal {
	readonly version: 1;
	readonly runId: string;
	readonly phase: WorkflowCheckpointPhase;
	readonly inputDigest: string;
	readonly repositories: readonly RepositoryRecord[];
}

interface CheckpointEnvelope {
	readonly digest: string;
	readonly journal: CheckpointJournal;
}

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA = /^[a-f0-9]{40,64}$/;

export class WorkflowPhaseCheckpointer {
	readonly #root: string;

	constructor(options: WorkflowPhaseCheckpointOptions) {
		if ((options.depth ?? currentDepth)() !== 0)
			throw new Error("workflow phase checkpoint authority belongs to depth 0");
		if (options.descendantWritableRoots.length === 0)
			throw new Error("phase checkpoint requires descendant-writable roots");
		const stateRoot = canonicalDirectory(options.maestroStateRoot, true);
		const root = resolve(stateRoot, "phase-checkpoints");
		for (const forbidden of options.descendantWritableRoots.map(
			canonicalPath,
		)) {
			if (overlaps(root, forbidden))
				throw new Error(
					"phase checkpoint journal must be disjoint from descendant-writable roots",
				);
		}
		mkdirSync(root, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") chmodSync(root, 0o700);
		this.#root = realpathSync(root);
	}

	checkpoint(
		input: WorkflowPhaseCheckpointInput,
	): WorkflowPhaseCheckpointResult {
		const canonical = canonicalizeInput(input);
		const inputDigest = sha256(canonicalJson(canonical));
		const path = this.#journalPath(canonical.runId, canonical.phase);
		let journal = readJournal(path);
		if (journal) {
			if (journal.inputDigest !== inputDigest)
				throw new Error(
					"phase checkpoint was already started with different input",
				);
			validateJournal(journal, canonical);
		} else {
			journal = prepareJournal(canonical, inputDigest);
			writeJournal(path, journal);
		}

		for (let index = 0; index < journal.repositories.length; index += 1) {
			const record = journal.repositories[index]!;
			validateCheckout(record);
			if (record.status === "completed") {
				verifyCompleted(record);
				continue;
			}
			const completed = finishPending(record);
			journal = {
				...journal,
				repositories: journal.repositories.map((value, recordIndex) =>
					recordIndex === index ? completed : value,
				),
			};
			writeJournal(path, journal);
		}
		for (const record of journal.repositories) {
			if (record.status !== "completed")
				throw new Error("phase checkpoint did not complete every repository");
			verifyCompleted(record);
		}

		return resultFrom(journal);
	}

	#journalPath(runId: string, phase: WorkflowCheckpointPhase): string {
		const directory = join(this.#root, runId);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") chmodSync(directory, 0o700);
		return join(directory, `${phase}.json`);
	}
}

function canonicalizeInput(
	input: WorkflowPhaseCheckpointInput,
): CanonicalCheckpointInput {
	assertIdentifier(input.runId, "run id");
	if (input.phase !== "implementation" && input.phase !== "decision")
		throw new Error("invalid workflow checkpoint phase");
	if (!Array.isArray(input.repositories) || input.repositories.length === 0)
		throw new Error("phase checkpoint requires repositories");
	if (!isRecord(input.messages))
		throw new Error("phase checkpoint messages must be a repository map");
	if (input.phase === "decision" && !isRecord(input.expectedChangedPaths))
		throw new Error(
			"decision checkpoint requires exact expected changed paths",
		);
	if (
		input.phase === "implementation" &&
		input.expectedChangedPaths !== undefined
	)
		throw new Error(
			"implementation checkpoint must not declare decision changed paths",
		);

	const repositories = input.repositories
		.map((repository) => {
			if (!exactKeys(repository, ["key", "worktree", "expectedBranch"]))
				throw new Error("phase checkpoint repository registry is not exact");
			assertIdentifier(repository.key, "repository key");
			validateBranch(repository.expectedBranch);
			const message = input.messages[repository.key];
			validateMessage(message, repository.key);
			const worktree = canonicalDirectory(repository.worktree);
			const expectedChangedPaths =
				input.phase === "decision"
					? normalizePaths(
							worktree,
							input.expectedChangedPaths?.[repository.key],
							repository.key,
						)
					: null;
			return {
				key: repository.key,
				worktree,
				expectedBranch: repository.expectedBranch,
				message,
				expectedChangedPaths,
			};
		})
		.sort((left, right) => left.key.localeCompare(right.key));

	assertUnique(
		repositories.map(({ key }) => key),
		"repository key",
	);
	assertUnique(
		repositories.map(({ worktree }) => worktree),
		"repository worktree",
	);
	assertExactKeys(
		Object.keys(input.messages),
		repositories.map(({ key }) => key),
		"messages",
	);
	if (input.phase === "decision")
		assertExactKeys(
			Object.keys(input.expectedChangedPaths ?? {}),
			repositories.map(({ key }) => key),
			"expected changed paths",
		);
	return { runId: input.runId, phase: input.phase, repositories };
}

function prepareJournal(
	input: CanonicalCheckpointInput,
	inputDigest: string,
): CheckpointJournal {
	const snapshots = input.repositories.map((repository) => {
		validateCheckout(repository);
		assertIndexClean(repository.worktree, repository.key);
		const preHead = requiredHead(repository.worktree, repository.key);
		const paths = changedPaths(repository.worktree, repository.key);
		if (repository.expectedChangedPaths)
			assertExactPathSet(
				paths,
				repository.expectedChangedPaths,
				`${repository.key} decision dirty paths`,
			);
		return { repository, preHead, paths };
	});

	return {
		version: 1,
		runId: input.runId,
		phase: input.phase,
		inputDigest,
		repositories: snapshots.map(({ repository, preHead, paths }) =>
			paths.length === 0
				? {
						status: "completed" as const,
						key: repository.key,
						worktree: repository.worktree,
						expectedBranch: repository.expectedBranch,
						message: repository.message,
						paths,
						preHead,
						finalHead: preHead,
						commit: null,
					}
				: {
						status: "pending" as const,
						key: repository.key,
						worktree: repository.worktree,
						expectedBranch: repository.expectedBranch,
						message: repository.message,
						paths,
						preHead,
					},
		),
	};
}

function finishPending(
	record: PendingRepositoryRecord,
): CompletedRepositoryRecord {
	const currentHead = requiredHead(record.worktree, record.key);
	if (currentHead !== record.preHead)
		return recoverCommitted(record, currentHead);
	const dirty = changedPaths(record.worktree, record.key);
	assertExactPathSet(
		dirty,
		record.paths,
		`${record.key} dirty paths on resume`,
	);
	const staged = stagedPaths(record.worktree, record.key);
	if (staged.length > 0)
		assertExactPathSet(
			staged,
			record.paths,
			`${record.key} staged paths on resume`,
		);
	const committed = stageAndCommit(
		record.worktree,
		record.paths,
		record.message,
	);
	if (!committed.ok)
		throw new Error(
			`${record.key} checkpoint commit failed: ${committed.stderr.trim() || "git commit failed"}`,
		);
	const finalHead = requiredHead(record.worktree, record.key);
	const completed = {
		...record,
		status: "completed" as const,
		finalHead,
		commit: finalHead,
	};
	verifyCompleted(completed);
	return completed;
}

function recoverCommitted(
	record: PendingRepositoryRecord,
	currentHead: string,
): CompletedRepositoryRecord {
	const completed = {
		...record,
		status: "completed" as const,
		finalHead: currentHead,
		commit: currentHead,
	};
	verifyCompleted(completed);
	return completed;
}

function verifyCompleted(record: CompletedRepositoryRecord): void {
	validateCheckout(record);
	if (requiredHead(record.worktree, record.key) !== record.finalHead)
		throw new Error(`${record.key} checkpoint branch moved after completion`);
	if (changedPaths(record.worktree, record.key).length !== 0)
		throw new Error(`${record.key} worktree is dirty after checkpoint`);
	if (record.commit === null) {
		if (record.finalHead !== record.preHead || record.paths.length !== 0)
			throw new Error(`${record.key} invalid no-op checkpoint record`);
		return;
	}
	if (record.commit !== record.finalHead)
		throw new Error(
			`${record.key} checkpoint commit reference does not match HEAD`,
		);
	const parent = git(record.worktree, record.key, [
		"rev-parse",
		`${record.commit}^`,
	]);
	if (parent.trim() !== record.preHead)
		throw new Error(`${record.key} checkpoint commit parent changed`);
	const message = git(record.worktree, record.key, [
		"log",
		"-1",
		"--format=%B",
		"--no-show-signature",
		record.commit,
	]).replace(/\n+$/, "");
	if (message !== record.message.replace(/\n+$/, ""))
		throw new Error(`${record.key} checkpoint commit message changed`);
	assertExactPathSet(
		commitPaths(record.worktree, record.key, record.commit),
		record.paths,
		`${record.key} checkpoint commit paths`,
	);
}

function validateCheckout(repository: {
	readonly key: string;
	readonly worktree: string;
	readonly expectedBranch: string;
}): void {
	const top = git(repository.worktree, repository.key, [
		"rev-parse",
		"--show-toplevel",
	]);
	if (realpathSync(top.trim()) !== repository.worktree)
		throw new Error(`${repository.key} worktree is not a checkout root`);
	const branch = git(repository.worktree, repository.key, [
		"symbolic-ref",
		"--quiet",
		"--short",
		"HEAD",
	]);
	if (branch.trim() !== repository.expectedBranch)
		throw new Error(
			`${repository.key} expected branch ${repository.expectedBranch} is not checked out`,
		);
}

function changedPaths(worktree: string, key: string): string[] {
	const status = git(worktree, key, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
	]);
	const fields = status.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field) continue;
		if (field.length < 4) throw new Error(`${key} returned invalid Git status`);
		paths.push(field.slice(3));
		if (
			field[0] === "R" ||
			field[0] === "C" ||
			field[1] === "R" ||
			field[1] === "C"
		) {
			const source = fields[index + 1];
			if (!source) throw new Error(`${key} returned incomplete rename status`);
			paths.push(source);
			index += 1;
		}
	}
	return uniqueSorted(paths);
}

function stagedPaths(worktree: string, key: string): string[] {
	return uniqueSorted(
		git(worktree, key, ["diff", "--cached", "--name-only", "-z"])
			.split("\0")
			.filter(Boolean),
	);
}

function commitPaths(worktree: string, key: string, commit: string): string[] {
	return uniqueSorted(
		git(worktree, key, [
			"diff-tree",
			"--no-commit-id",
			"--name-only",
			"-r",
			"-z",
			commit,
		])
			.split("\0")
			.filter(Boolean),
	);
}

function assertIndexClean(worktree: string, key: string): void {
	const staged = stagedPaths(worktree, key);
	if (staged.length > 0)
		throw new Error(`${key} index must be clean before phase checkpoint`);
}

function requiredHead(worktree: string, key: string): string {
	const head = git(worktree, key, ["rev-parse", "HEAD"]).trim();
	if (!SHA.test(head)) throw new Error(`${key} HEAD is not a commit`);
	return head;
}

function git(worktree: string, key: string, args: readonly string[]): string {
	const result = runCommand("git", args, { cwd: worktree });
	if (!result.ok)
		throw new Error(
			`${key} Git inspection failed: ${result.stderr.trim() || args.join(" ")}`,
		);
	return result.stdout;
}

function normalizePaths(
	worktree: string,
	paths: readonly string[] | undefined,
	key: string,
): string[] {
	if (!Array.isArray(paths))
		throw new Error(`${key} expected changed paths must be an array`);
	return uniqueSorted(
		paths.map((path) => {
			if (
				typeof path !== "string" ||
				!path ||
				isAbsolute(path) ||
				path.includes("\0")
			)
				throw new Error(`${key} has an invalid expected changed path`);
			const normalized = path.replaceAll("\\", "/");
			const absolute = resolve(worktree, normalized);
			const rel = relative(worktree, absolute).replaceAll(sep, "/");
			if (!rel || rel === ".." || rel.startsWith("../") || rel !== normalized)
				throw new Error(`${key} has an invalid expected changed path ${path}`);
			return rel;
		}),
	);
}

function validateMessage(
	message: unknown,
	key: string,
): asserts message is string {
	if (typeof message !== "string" || !message.trim())
		throw new Error(`${key} checkpoint message must say what changed`);
	if (message.includes("\0") || Buffer.byteLength(message) > 32 * 1024)
		throw new Error(`${key} checkpoint message is invalid`);
	if ((message.split("\n", 1)[0] ?? "").length > 200)
		throw new Error(`${key} checkpoint subject is longer than 200 characters`);
}

function validateBranch(branch: string): void {
	if (!branch.trim() || branch.startsWith("-") || /[\0\r\n]/.test(branch))
		throw new Error("checkpoint expected branch is invalid");
}

function validateJournal(
	journal: CheckpointJournal,
	input: CanonicalCheckpointInput,
): void {
	if (
		!exactKeys(journal, [
			"version",
			"runId",
			"phase",
			"inputDigest",
			"repositories",
		]) ||
		journal.version !== 1 ||
		journal.runId !== input.runId ||
		journal.phase !== input.phase ||
		!Array.isArray(journal.repositories) ||
		journal.repositories.length !== input.repositories.length
	)
		throw new Error("invalid phase checkpoint journal");
	for (let index = 0; index < input.repositories.length; index += 1) {
		const expected = input.repositories[index]!;
		const value: unknown = journal.repositories[index];
		if (!isRecord(value))
			throw new Error("invalid phase checkpoint journal repository record");
		const completed = value.status === "completed";
		if (
			!exactKeys(
				value,
				completed
					? [
							"status",
							"key",
							"worktree",
							"expectedBranch",
							"message",
							"paths",
							"preHead",
							"finalHead",
							"commit",
						]
					: [
							"status",
							"key",
							"worktree",
							"expectedBranch",
							"message",
							"paths",
							"preHead",
						],
			) ||
			value.key !== expected.key ||
			value.worktree !== expected.worktree ||
			value.expectedBranch !== expected.expectedBranch ||
			value.message !== expected.message ||
			!Array.isArray(value.paths) ||
			value.paths.some((path) => typeof path !== "string") ||
			typeof value.preHead !== "string" ||
			!SHA.test(value.preHead) ||
			(value.status !== "pending" && !completed) ||
			(completed &&
				(typeof value.finalHead !== "string" ||
					!SHA.test(value.finalHead) ||
					(value.commit !== null &&
						(typeof value.commit !== "string" || !SHA.test(value.commit)))))
		)
			throw new Error("invalid phase checkpoint journal repository record");
		const actual = value as unknown as RepositoryRecord;
		if (expected.expectedChangedPaths)
			assertExactPathSet(
				actual.paths,
				expected.expectedChangedPaths,
				`${actual.key} journal paths`,
			);
	}
}

function readJournal(path: string): CheckpointJournal | undefined {
	if (!existsSync(path)) return undefined;
	if (lstatSync(path).isSymbolicLink())
		throw new Error("phase checkpoint journal cannot be a symbolic link");
	const source = readFileSync(path, "utf8");
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw new Error("phase checkpoint journal is not JSON");
	}
	if (
		!isRecord(value) ||
		!exactKeys(value, ["digest", "journal"]) ||
		typeof value.digest !== "string" ||
		!isRecord(value.journal) ||
		sha256(canonicalJson(value.journal)) !== value.digest ||
		source !== canonicalJson(value)
	)
		throw new Error("phase checkpoint journal integrity check failed");
	return value.journal as unknown as CheckpointJournal;
}

function writeJournal(path: string, journal: CheckpointJournal): void {
	const envelope: CheckpointEnvelope = {
		digest: sha256(canonicalJson(journal)),
		journal,
	};
	const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeSync(descriptor, canonicalJson(envelope), undefined, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
		const directory = openSync(dirname(path), "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		if (existsSync(temporary)) rmSync(temporary);
	}
}

function resultFrom(journal: CheckpointJournal): WorkflowPhaseCheckpointResult {
	const repositories = journal.repositories.map((record) => {
		if (record.status !== "completed")
			throw new Error("phase checkpoint did not complete every repository");
		return {
			repository: record.key,
			worktree: record.worktree,
			expectedBranch: record.expectedBranch,
			preHead: record.preHead,
			finalHead: record.finalHead,
			changedPaths: [...record.paths],
			commit: record.commit,
		};
	});
	return {
		runId: journal.runId,
		phase: journal.phase,
		repositories,
		commitRefs: repositories.flatMap((repository) =>
			repository.commit
				? [{ repository: repository.repository, commit: repository.commit }]
				: [],
		),
	};
}

function assertExactPathSet(
	actual: readonly string[],
	expected: readonly string[],
	label: string,
): void {
	if (
		canonicalJson(uniqueSorted(actual)) !==
		canonicalJson(uniqueSorted(expected))
	)
		throw new Error(
			`${label} do not exactly match (actual: ${uniqueSorted(actual).join(", ") || "none"}; expected: ${uniqueSorted(expected).join(", ") || "none"})`,
		);
}

function assertExactKeys(
	actual: readonly string[],
	expected: readonly string[],
	label: string,
): void {
	if (canonicalJson([...actual].sort()) !== canonicalJson([...expected].sort()))
		throw new Error(`${label} must exactly match the repository registry`);
}

function assertUnique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length)
		throw new Error(`duplicate ${label}`);
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function assertIdentifier(value: string, label: string): void {
	if (typeof value !== "string" || !IDENTIFIER.test(value))
		throw new Error(`invalid checkpoint ${label}`);
}

function canonicalDirectory(path: string, create = false): string {
	if (!isAbsolute(path))
		throw new Error(`checkpoint path must be absolute: ${path}`);
	if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
	const canonical = realpathSync(path);
	if (!statSync(canonical).isDirectory())
		throw new Error(`checkpoint path is not a directory: ${path}`);
	return canonical;
}

function canonicalPath(input: string): string {
	if (!isAbsolute(input))
		throw new Error(`checkpoint path must be absolute: ${input}`);
	let cursor = resolve(input);
	const missing: string[] = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		missing.unshift(
			cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
		);
		cursor = parent;
	}
	const canonical = resolve(realpathSync(cursor), ...missing);
	if (canonical === parse(canonical).root)
		throw new Error("checkpoint path cannot be the filesystem root");
	return canonical;
}

function overlaps(left: string, right: string): boolean {
	const leftToRight = relative(left, right);
	const rightToLeft = relative(right, left);
	return (
		leftToRight === "" ||
		(!leftToRight.startsWith("..") && !isAbsolute(leftToRight)) ||
		(!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft))
	);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
	return (
		isRecord(value) &&
		Object.keys(value).length === keys.length &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	throw new Error("phase checkpoint journal contains a non-JSON value");
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
