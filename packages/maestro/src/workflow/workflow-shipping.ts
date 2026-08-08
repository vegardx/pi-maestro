// Publication for a completed workflow run. Only the depth-zero seat may use
// this module: descendants receive neither Git publication credentials nor a
// reference to these operations.

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
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	currentBranch,
	headSha,
	pushBranch,
	workingTreeClean,
} from "@vegardx/pi-git";
import { createPr, editPr, findOpenPr } from "@vegardx/pi-github";
import { currentDepth } from "../depth.js";

export interface WorkflowPullRequestCopy {
	readonly title: string;
	readonly intent: string;
	readonly rationale: string;
	readonly changes: readonly string[];
}

export interface WorkflowShippingRepository {
	readonly key: string;
	readonly worktree: string;
	readonly expectedBranch: string;
	readonly expectedFinalHead: string;
	readonly baseBranch: string;
	readonly pullRequest: WorkflowPullRequestCopy;
}

export interface WorkflowShippingInput {
	readonly runId: string;
	readonly repositories: readonly WorkflowShippingRepository[];
}

export interface WorkflowShippingRepositoryResult {
	readonly repository: string;
	readonly branch: string;
	readonly finalHead: string;
	readonly pullRequestNumber: number;
}

export interface WorkflowShippingResult {
	readonly runId: string;
	readonly repositories: readonly WorkflowShippingRepositoryResult[];
}

export interface WorkflowShippingOps {
	inspect(worktree: string): {
		readonly branch: string | null;
		readonly head: string | null;
		readonly clean: boolean;
	};
	/** Must push the named local branch without force. */
	pushNonForce(
		worktree: string,
		branch: string,
	): Promise<{ readonly ok: boolean; readonly error?: string }>;
	findOpenPullRequest(
		worktree: string,
		branch: string,
	): Promise<{ readonly number: number } | null>;
	createPullRequest(
		worktree: string,
		request: {
			readonly title: string;
			readonly body: string;
			readonly base: string;
		},
	): Promise<{ readonly number: number }>;
	updatePullRequest(
		worktree: string,
		number: number,
		request: {
			readonly title: string;
			readonly body: string;
			readonly base: string;
		},
	): Promise<void>;
}

export interface WorkflowShipperOptions {
	readonly maestroStateRoot: string;
	readonly descendantWritableRoots: readonly string[];
	readonly depth?: () => number;
	readonly ops?: Partial<WorkflowShippingOps>;
	/** Test/observability seam, called only after the result is durable. */
	readonly onRepositoryPublished?: (
		result: WorkflowShippingRepositoryResult,
	) => void | Promise<void>;
}

type PendingShippingRepository = {
	readonly status: "pending";
} & CanonicalRepository;

type CompletedShippingRepository = {
	readonly status: "completed";
	readonly pullRequestNumber: number;
} & CanonicalRepository;

type ShippingRepositoryRecord =
	| PendingShippingRepository
	| CompletedShippingRepository;

interface ShippingJournal {
	readonly version: 1;
	readonly runId: string;
	readonly inputDigest: string;
	readonly repositories: readonly ShippingRepositoryRecord[];
}

interface CanonicalRepository extends WorkflowShippingRepository {
	readonly worktree: string;
}

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA = /^[a-f0-9]{40,64}$/;

export class WorkflowShipper {
	readonly #root: string;
	readonly #ops: WorkflowShippingOps;
	readonly #onRepositoryPublished?: WorkflowShipperOptions["onRepositoryPublished"];

	constructor(options: WorkflowShipperOptions) {
		if ((options.depth ?? currentDepth)() !== 0)
			throw new Error("workflow shipping authority belongs to depth 0");
		if (options.descendantWritableRoots.length === 0)
			throw new Error("workflow shipping requires descendant-writable roots");
		const stateRoot = canonicalDirectory(options.maestroStateRoot, true);
		const root = resolve(stateRoot, "workflow-shipping");
		for (const writable of options.descendantWritableRoots.map(canonicalPath))
			if (overlaps(root, writable))
				throw new Error(
					"workflow shipping journal must be disjoint from descendant-writable roots",
				);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") chmodSync(root, 0o700);
		this.#root = realpathSync(root);
		this.#ops = { ...defaultOps(), ...options.ops };
		this.#onRepositoryPublished = options.onRepositoryPublished;
	}

	async ship(input: WorkflowShippingInput): Promise<WorkflowShippingResult> {
		const canonical = canonicalize(input);
		const lease = acquireShippingLease(this.#root, canonical.runId);
		try {
			return await this.#shipCanonical(canonical);
		} finally {
			releaseShippingLease(lease);
		}
	}

	async #shipCanonical(canonical: {
		readonly runId: string;
		readonly repositories: readonly CanonicalRepository[];
	}): Promise<WorkflowShippingResult> {
		const inputDigest = digest(canonical);
		const path = join(this.#root, `${canonical.runId}.json`);
		let journal = readJournal(path);
		if (journal) {
			if (journal.inputDigest !== inputDigest)
				throw new Error(
					"workflow shipping was already started with different input",
				);
		} else {
			journal = {
				version: 1,
				runId: canonical.runId,
				inputDigest,
				repositories: canonical.repositories.map((repository) => ({
					...repository,
					status: "pending" as const,
				})),
			};
			writeJournal(path, journal);
		}

		for (let index = 0; index < journal.repositories.length; index += 1) {
			const repository: ShippingRepositoryRecord = journal.repositories[index]!;
			assertReady(repository, this.#ops.inspect(repository.worktree));
			if (repository.status === "completed") continue;

			const pushed = await this.#ops.pushNonForce(
				repository.worktree,
				repository.expectedBranch,
			);
			if (!pushed.ok)
				throw new Error(
					`could not push ${repository.key}/${repository.expectedBranch}: ${pushed.error ?? "unknown error"}`,
				);
			const request = {
				title: repository.pullRequest.title,
				body: workflowPullRequestBody(repository.pullRequest),
				base: repository.baseBranch,
			};
			const existing = await this.#ops.findOpenPullRequest(
				repository.worktree,
				repository.expectedBranch,
			);
			let pullRequestNumber: number;
			if (existing) {
				assertPullRequestNumber(existing.number);
				await this.#ops.updatePullRequest(
					repository.worktree,
					existing.number,
					request,
				);
				pullRequestNumber = existing.number;
			} else {
				pullRequestNumber = (
					await this.#ops.createPullRequest(repository.worktree, request)
				).number;
			}
			assertPullRequestNumber(pullRequestNumber);
			const completed: CompletedShippingRepository = {
				...repository,
				status: "completed" as const,
				pullRequestNumber,
			};
			journal = {
				...journal,
				repositories: journal.repositories.map((candidate, candidateIndex) =>
					candidateIndex === index ? completed : candidate,
				),
			};
			writeJournal(path, journal);
			await this.#onRepositoryPublished?.(resultFromRepository(completed));
		}
		return {
			runId: journal.runId,
			repositories: journal.repositories.map((repository) => {
				if (repository.status !== "completed")
					throw new Error(
						"workflow shipping did not complete every repository",
					);
				return resultFromRepository(repository);
			}),
		};
	}
}

interface ShippingLease {
	readonly path: string;
	readonly fd: number;
}

function acquireShippingLease(root: string, runId: string): ShippingLease {
	const path = join(root, `${runId}.lock`);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeSync(fd, `${process.pid}\n`, undefined, "utf8");
			fsyncSync(fd);
			return { path, fd };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const info = lstatSync(path);
			if (
				!info.isFile() ||
				info.isSymbolicLink() ||
				(process.platform !== "win32" && (info.mode & 0o777) !== 0o600)
			)
				throw new Error(
					"workflow shipping lease is not a private regular file",
				);
			const owner = Number.parseInt(readFileSync(path, "utf8"), 10);
			if (Number.isSafeInteger(owner) && processAlive(owner))
				throw new Error(
					`workflow shipping for ${runId} is already in progress`,
				);
			unlinkSync(path);
		}
	}
	throw new Error(`could not acquire workflow shipping lease for ${runId}`);
}

function releaseShippingLease(lease: ShippingLease): void {
	closeSync(lease.fd);
	try {
		unlinkSync(lease.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Deliberately has no review, finding, agent, or model fields. */
export function workflowPullRequestBody(copy: WorkflowPullRequestCopy): string {
	validateCopy(copy);
	return [
		`## Intent\n\n${copy.intent.trim()}`,
		`## Rationale\n\n${copy.rationale.trim()}`,
		["## Changes", ...copy.changes.map((change) => `- ${change.trim()}`)].join(
			"\n",
		),
	].join("\n\n");
}

function canonicalize(input: WorkflowShippingInput): {
	readonly runId: string;
	readonly repositories: readonly CanonicalRepository[];
} {
	if (!IDENTIFIER.test(input.runId)) throw new Error("invalid workflow run id");
	if (!Array.isArray(input.repositories) || input.repositories.length === 0)
		throw new Error("workflow shipping requires repositories");
	const keys = new Set<string>();
	const worktrees = new Set<string>();
	const repositories = input.repositories.map((repository) => {
		if (!IDENTIFIER.test(repository.key))
			throw new Error(`invalid repository key ${repository.key}`);
		if (keys.has(repository.key))
			throw new Error(`duplicate repository key ${repository.key}`);
		keys.add(repository.key);
		const worktree = canonicalDirectory(repository.worktree, false);
		if (worktrees.has(worktree)) throw new Error("duplicate workflow worktree");
		worktrees.add(worktree);
		if (!repository.expectedBranch.trim())
			throw new Error(`missing expected branch for ${repository.key}`);
		if (!SHA.test(repository.expectedFinalHead))
			throw new Error(`invalid final HEAD for ${repository.key}`);
		if (!repository.baseBranch.trim())
			throw new Error(`missing base branch for ${repository.key}`);
		validateCopy(repository.pullRequest);
		return {
			key: repository.key,
			worktree,
			expectedBranch: repository.expectedBranch,
			expectedFinalHead: repository.expectedFinalHead,
			baseBranch: repository.baseBranch,
			pullRequest: {
				title: repository.pullRequest.title,
				intent: repository.pullRequest.intent,
				rationale: repository.pullRequest.rationale,
				changes: [...repository.pullRequest.changes],
			},
		};
	});
	return { runId: input.runId, repositories };
}

function validateCopy(copy: WorkflowPullRequestCopy): void {
	if (!copy || typeof copy !== "object")
		throw new Error("missing pull request copy");
	if (!copy.title?.trim()) throw new Error("pull request title is required");
	if (!copy.intent?.trim()) throw new Error("pull request intent is required");
	if (!copy.rationale?.trim())
		throw new Error("pull request rationale is required");
	if (!Array.isArray(copy.changes) || copy.changes.length === 0)
		throw new Error("pull request changes are required");
	if (copy.changes.some((change) => !change.trim()))
		throw new Error("pull request changes cannot be blank");
}

function assertReady(
	repository: CanonicalRepository,
	actual: ReturnType<WorkflowShippingOps["inspect"]>,
): void {
	if (actual.branch !== repository.expectedBranch)
		throw new Error(
			`${repository.key}: expected branch ${repository.expectedBranch}, found ${actual.branch ?? "detached HEAD"}`,
		);
	if (!actual.clean)
		throw new Error(
			`${repository.key}: worktree must be clean before shipping`,
		);
	if (actual.head !== repository.expectedFinalHead)
		throw new Error(
			`${repository.key}: expected final HEAD ${repository.expectedFinalHead}, found ${actual.head ?? "missing"}`,
		);
}

function resultFromRepository(
	repository: CanonicalRepository & {
		readonly pullRequestNumber: number;
	},
): WorkflowShippingRepositoryResult {
	return {
		repository: repository.key,
		branch: repository.expectedBranch,
		finalHead: repository.expectedFinalHead,
		pullRequestNumber: repository.pullRequestNumber,
	};
}

function defaultOps(): WorkflowShippingOps {
	return {
		inspect: (worktree) => ({
			branch: currentBranch(worktree),
			head: headSha(worktree),
			clean: workingTreeClean(worktree),
		}),
		pushNonForce: async (worktree, branch) => {
			const result = await pushBranch(worktree, branch);
			return result.ok
				? { ok: true }
				: {
						ok: false,
						error: result.stderr.trim() || `git exit ${result.exitCode}`,
					};
		},
		findOpenPullRequest: async (worktree, branch) => {
			const result = await findOpenPr(worktree, branch);
			if (result.error)
				throw new Error(`could not find pull request: ${result.error}`);
			return result.pr ? { number: result.pr.number } : null;
		},
		createPullRequest: async (worktree, request) => {
			const result = await createPr(worktree, request);
			if (result.error)
				throw new Error(`could not create pull request: ${result.error}`);
			const number = numberFromUrl(result.url);
			if (number === null)
				throw new Error("could not read created pull request number");
			return { number };
		},
		updatePullRequest: async (worktree, number, request) => {
			const result = await editPr(worktree, number, request);
			if (!result.ok)
				throw new Error(
					`could not update pull request: ${result.error ?? "unknown error"}`,
				);
		},
	};
}

function readJournal(path: string): ShippingJournal | null {
	if (!existsSync(path)) return null;
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("invalid workflow shipping journal");
	const envelope = JSON.parse(readFileSync(path, "utf8")) as {
		digest?: string;
		journal?: ShippingJournal;
	};
	if (!envelope.journal || envelope.digest !== digest(envelope.journal))
		throw new Error("workflow shipping journal integrity check failed");
	if (envelope.journal.version !== 1)
		throw new Error("unsupported workflow shipping journal version");
	return envelope.journal;
}

function writeJournal(path: string, journal: ShippingJournal): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
	const payload = `${JSON.stringify({ digest: digest(journal), journal })}\n`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeSync(fd, payload);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
}

function digest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

function canonicalDirectory(path: string, create: boolean): string {
	if (!isAbsolute(path))
		throw new Error("workflow shipping paths must be absolute");
	if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error(`workflow shipping path is not a real directory: ${path}`);
	return realpathSync(path);
}

function canonicalPath(path: string): string {
	if (!isAbsolute(path))
		throw new Error("descendant-writable roots must be absolute");
	return existsSync(path) ? realpathSync(path) : resolve(path);
}

function overlaps(left: string, right: string): boolean {
	const contains = (from: string, to: string) => {
		const value = relative(resolve(from), resolve(to));
		return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
	};
	return contains(left, right) || contains(right, left);
}

function numberFromUrl(url: string | null): number | null {
	const match = url?.match(/\/pull\/(\d+)/);
	return match ? Number.parseInt(match[1]!, 10) : null;
}

function assertPullRequestNumber(value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new Error("invalid pull request number");
}
