// Seat-owned preparation for a workflow spanning independent Git repositories.
// This module creates linked worktrees and records their immutable launch
// identity before any workflow descendant is started. It never commits or
// publishes, and resume is validation-only.

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import {
	chmod,
	link,
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	addWorktree,
	branchExists,
	currentBranch,
	detectDefaultBranch,
	findCheckoutOf,
	gitToplevel,
	headSha,
	isAncestor,
	revParse,
	runCommand,
	worktreeBaseSha,
} from "@vegardx/pi-git";

export interface AuthoredWorkflowRepository {
	readonly key: string;
	readonly path: string;
	/** Optional local or origin-tracking base branch for this repository. */
	readonly base?: string;
}

/** Exact repository identity selected during the human-approved preview. */
export interface PreparedWorkflowRepository {
	readonly key: string;
	readonly sourceRoot: string;
	readonly worktree: string;
	readonly branch: string;
	readonly baseBranch: string;
	readonly baseSha: string;
}

export interface PrepareWorkflowRepositoriesInput {
	readonly runId: string;
	readonly planSlug: string;
	readonly coordinatedRunRoot: string;
	readonly repositories: readonly AuthoredWorkflowRepository[];
	/** Optional human-approved read-only preview, checked before first mutation. */
	readonly expectedRepositories?: readonly PreparedWorkflowRepository[];
}

export interface WorkflowRepositoryPreparationOptions {
	/** Injectable process identity used by recovery tests and alternate seats. */
	readonly ownerPid?: number;
	readonly isProcessAlive?: (pid: number) => boolean;
	/** Observability hook invoked only after a repository is durably completed. */
	readonly onRepositoryPrepared?: (
		repository: PreparedWorkflowRepository,
	) => void | Promise<void>;
}

/**
 * Resolve the exact repository/worktree identity shown for approval without
 * creating a directory, branch, worktree, registry, journal, or lease.
 */
export async function previewWorkflowRepositories(
	input: PrepareWorkflowRepositoriesInput,
): Promise<readonly PreparedWorkflowRepository[]> {
	const prepared = await previewInput(input);
	return prepared.repositories.map((repository) => {
		if (existsSync(repository.worktree))
			throw new Error(
				`workflow worktree target already exists for ${repository.key}: ${repository.worktree}`,
			);
		if (branchExists(repository.sourceRoot, repository.branch))
			throw new Error(
				`workflow branch already exists for ${repository.key}: ${repository.branch}`,
			);
		if (findCheckoutOf(repository.sourceRoot, repository.branch))
			throw new Error(
				`workflow branch is already checked out for ${repository.key}`,
			);
		const baseSha = worktreeBaseSha(
			repository.sourceRoot,
			repository.branch,
			repository.base,
		);
		if (!baseSha)
			throw new Error(
				`could not resolve base ${repository.base} for ${repository.key}`,
			);
		return Object.freeze({
			key: repository.key,
			sourceRoot: repository.sourceRoot,
			worktree: repository.worktree,
			branch: repository.branch,
			baseBranch: repository.base,
			baseSha,
		});
	});
}

interface RepositoryRegistry {
	readonly version: 1;
	readonly runId: string;
	readonly planSlug: string;
	readonly coordinatedRunRoot: string;
	readonly repositories: readonly PreparedWorkflowRepository[];
}

interface PreparationJournal extends RepositoryRegistry {
	readonly repositories: readonly (PreparedWorkflowRepository & {
		readonly status: "pending" | "completed";
	})[];
}

const REGISTRY_KEYS = new Set([
	"version",
	"runId",
	"planSlug",
	"coordinatedRunRoot",
	"repositories",
]);
const REPOSITORY_KEYS = new Set([
	"key",
	"sourceRoot",
	"worktree",
	"branch",
	"baseBranch",
	"baseSha",
]);
const JOURNAL_REPOSITORY_KEYS = new Set([...REPOSITORY_KEYS, "status"]);
const SHA_PATTERN = /^[a-f0-9]{40,64}$/;

/** Create a registry, recovering only this run's exact durable preparation. */
export async function prepareWorkflowRepositories(
	input: PrepareWorkflowRepositoriesInput,
	options: WorkflowRepositoryPreparationOptions = {},
): Promise<readonly PreparedWorkflowRepository[]> {
	if (input.expectedRepositories) {
		const runRoot = await canonicalDirectory(input.coordinatedRunRoot);
		const paths = registryPaths(runRoot);
		if (
			!(await pathExists(paths.journal)) &&
			!(await pathExists(paths.registry))
		) {
			const actual = await previewWorkflowRepositories({
				...input,
				expectedRepositories: undefined,
			});
			assertExpectedRepositories(input.expectedRepositories, actual);
		}
	}
	const prepared = await prepareInput(input, true);
	const paths = registryPaths(prepared.runRoot);
	await validateRegistryDirectory(paths.directory, prepared.runRoot);
	const lock = await acquireCreateLock(paths.lock, options);
	try {
		if (await pathExists(paths.registry))
			throw new Error(
				`workflow repository registry already exists for ${input.runId}; resume it explicitly`,
			);
		let journal = await loadOrCreateJournal(paths.journal, input, prepared);
		validateJournalIdentity(journal, input, prepared);
		for (let index = 0; index < journal.repositories.length; index += 1) {
			const record = journal.repositories[index]!;
			const expected = prepared.repositories[index]!;
			if (record.status === "completed") {
				validatePreparedRecord(record);
				continue;
			}
			const targetExists = await pathExists(record.worktree);
			const branchPresent = branchExists(record.sourceRoot, record.branch);
			if (targetExists || branchPresent) {
				if (!targetExists || !branchPresent)
					throw new Error(
						`partial workflow worktree collision for ${record.key}`,
					);
				validatePreparedRecord(record);
			} else {
				const made = addWorktree(
					record.sourceRoot,
					record.worktree,
					record.branch,
					expected.base,
				);
				if (!made.ok || !made.created || resolve(made.path) !== record.worktree)
					throw new Error(
						made.ok
							? `workflow worktree creation collided for ${record.key}`
							: made.error,
					);
				validatePreparedRecord(record);
			}
			journal = {
				...journal,
				repositories: journal.repositories.map((candidate, candidateIndex) =>
					candidateIndex === index
						? { ...candidate, status: "completed" as const }
						: candidate,
				),
			};
			await replacePrivateExact(paths.journal, `${JSON.stringify(journal)}\n`);
			await options.onRepositoryPrepared?.(record);
		}
		const repositories = journal.repositories.map(({ status: _, ...record }) =>
			Object.freeze(record),
		);
		const registry: RepositoryRegistry = {
			version: 1,
			runId: input.runId,
			planSlug: input.planSlug,
			coordinatedRunRoot: prepared.runRoot,
			repositories,
		};
		await persistPrivateExact(paths.registry, `${JSON.stringify(registry)}\n`);
		await unlink(paths.journal);
		return repositories;
	} finally {
		await releaseCreateLock(paths.lock, lock);
	}
}

/** Validate and return an existing registry without creating Git state. */
export async function resumeWorkflowRepositories(
	input: PrepareWorkflowRepositoriesInput,
): Promise<readonly PreparedWorkflowRepository[]> {
	const prepared = await prepareInput(input, false);
	const paths = registryPaths(prepared.runRoot);
	await validateExistingRegistryDirectory(paths.directory, prepared.runRoot);
	const registry = await readRegistry(paths.registry);
	if (
		registry.runId !== input.runId ||
		registry.planSlug !== input.planSlug ||
		registry.coordinatedRunRoot !== prepared.runRoot
	)
		throw new Error("workflow repository registry launch identity mismatch");
	if (registry.repositories.length !== prepared.repositories.length)
		throw new Error("workflow repository registry repository set mismatch");
	const expectedByKey = new Map(
		prepared.repositories.map((repository) => [repository.key, repository]),
	);
	const seen = new Set<string>();
	for (const record of registry.repositories) {
		const expected = expectedByKey.get(record.key);
		if (
			!expected ||
			seen.has(record.key) ||
			record.sourceRoot !== expected.sourceRoot ||
			record.worktree !== expected.worktree ||
			record.branch !== expected.branch ||
			record.baseBranch !==
				(input.expectedRepositories?.find(({ key }) => key === record.key)
					?.baseBranch ?? expected.base)
		)
			throw new Error(`workflow repository registry differs for ${record.key}`);
		seen.add(record.key);
		validateCheckout(record);
		if (
			revParse(record.sourceRoot, record.baseSha) !== record.baseSha ||
			!isAncestor(record.worktree, record.baseSha) ||
			worktreeBaseSha(record.sourceRoot, record.branch, record.baseBranch) !==
				record.baseSha
		)
			throw new Error(
				`workflow repository base SHA is no longer valid for ${record.key}`,
			);
	}
	return registry.repositories;
}

/**
 * Re-enter preparation after the outer plan runner was interrupted. A crash
 * may leave either the final registry or only the durable partial journal.
 * Completed preparation is validation-only; partial preparation resumes the
 * creator so remaining worktrees are finished without string-matching errors.
 */
export async function continueWorkflowRepositories(
	input: PrepareWorkflowRepositoriesInput,
	options: WorkflowRepositoryPreparationOptions = {},
): Promise<readonly PreparedWorkflowRepository[]> {
	const registry = registryPaths(resolve(input.coordinatedRunRoot)).registry;
	return (await pathExists(registry))
		? resumeWorkflowRepositories(input)
		: prepareWorkflowRepositories(input, options);
}

interface PreparedInputRepository {
	readonly key: string;
	readonly sourceRoot: string;
	readonly worktree: string;
	readonly branch: string;
	readonly base: string;
}

async function previewInput(input: PrepareWorkflowRepositoriesInput): Promise<{
	readonly runRoot: string;
	readonly repositories: readonly PreparedInputRepository[];
}> {
	assertIdentifier(input.runId, "workflow run id");
	assertIdentifier(input.planSlug, "plan slug");
	if (!isAbsolute(input.coordinatedRunRoot))
		throw new Error("coordinated run root must be absolute");
	if (input.repositories.length === 0)
		throw new Error("workflow repository preparation requires a repository");
	const runRoot = await canonicalDirectory(input.coordinatedRunRoot);
	const reposContainer = join(runRoot, "repos");
	const keys = new Set<string>();
	const sourceRoots = new Set<string>();
	const repositories: PreparedInputRepository[] = [];
	for (const authored of input.repositories) {
		assertIdentifier(authored.key, "repository key");
		if (keys.has(authored.key))
			throw new Error(`duplicate workflow repository key ${authored.key}`);
		keys.add(authored.key);
		if (!isAbsolute(authored.path))
			throw new Error(`repository path must be absolute for ${authored.key}`);
		const sourceRoot = await canonicalDirectory(authored.path);
		const top = gitToplevel(sourceRoot);
		if (!top || (await realpath(top)) !== sourceRoot)
			throw new Error(
				`repository ${authored.key} must name an exact non-bare Git root`,
			);
		if (sourceRoots.has(sourceRoot))
			throw new Error(`duplicate workflow repository root ${sourceRoot}`);
		if (pathsOverlap(sourceRoot, runRoot))
			throw new Error(
				`repository ${authored.key} must not overlap the coordinated run root`,
			);
		sourceRoots.add(sourceRoot);
		const approvedBase = input.expectedRepositories?.find(
			({ key }) => key === authored.key,
		)?.baseBranch;
		const base =
			authored.base ??
			approvedBase ??
			detectDefaultBranch(sourceRoot) ??
			currentBranch(sourceRoot);
		if (!base || base.startsWith("-") || /[\0\r\n]/.test(base))
			throw new Error(`could not resolve a safe base for ${authored.key}`);
		const branch = workflowBranch(input.planSlug, input.runId, authored.key);
		const worktree = join(reposContainer, authored.key);
		assertStrictChild(worktree, reposContainer, "workflow worktree");
		repositories.push({
			key: authored.key,
			sourceRoot,
			worktree,
			branch,
			base,
		});
	}
	for (let left = 0; left < repositories.length; left += 1)
		for (let right = left + 1; right < repositories.length; right += 1)
			if (
				pathsOverlap(
					repositories[left]!.sourceRoot,
					repositories[right]!.sourceRoot,
				)
			)
				throw new Error("workflow repository roots must not overlap");
	return {
		runRoot,
		repositories: repositories.sort((left, right) =>
			left.key.localeCompare(right.key),
		),
	};
}

async function prepareInput(
	input: PrepareWorkflowRepositoriesInput,
	create: boolean,
): Promise<{
	readonly runRoot: string;
	readonly repositories: readonly PreparedInputRepository[];
}> {
	const preview = await previewInput(input);
	const runRoot = preview.runRoot;
	const reposContainer = join(runRoot, "repos");
	if (create) await ensurePrivateChildDirectory(reposContainer, runRoot);
	const canonicalReposContainer = await realpath(reposContainer);
	if (canonicalReposContainer !== resolve(reposContainer))
		throw new Error("workflow repository container contains a symlink");
	assertStrictChild(canonicalReposContainer, runRoot, "repository container");
	return {
		runRoot,
		repositories: preview.repositories.map((repository) => ({
			...repository,
			worktree: join(canonicalReposContainer, repository.key),
		})),
	};
}

function workflowBranch(planSlug: string, runId: string, key: string): string {
	const branch = `maestro/${planSlug}/${runId}/${key}`;
	if (branch.length > 240) throw new Error("workflow branch name is too long");
	return branch;
}

function assertExpectedRepositories(
	expected: readonly PreparedWorkflowRepository[],
	actual: readonly PreparedWorkflowRepository[],
): void {
	const canonical = (values: readonly PreparedWorkflowRepository[]) =>
		JSON.stringify(
			[...values]
				.sort((left, right) => left.key.localeCompare(right.key))
				.map(({ key, sourceRoot, worktree, branch, baseBranch, baseSha }) => ({
					key,
					sourceRoot,
					worktree,
					branch,
					baseBranch,
					baseSha,
				})),
		);
	if (canonical(expected) !== canonical(actual))
		throw new Error(
			"workflow repository preparation differs from the approved preview",
		);
}

function validateCheckout(record: PreparedWorkflowRepository): void {
	const canonicalSource = canonicalDirectorySync(record.sourceRoot);
	const canonicalWorktree = canonicalDirectorySync(record.worktree);
	if (
		canonicalSource !== record.sourceRoot ||
		canonicalWorktree !== record.worktree
	)
		throw new Error(
			`workflow repository path identity changed for ${record.key}`,
		);
	if (gitToplevel(record.worktree) !== record.worktree)
		throw new Error(`workflow worktree root changed for ${record.key}`);
	if (currentBranch(record.worktree) !== record.branch)
		throw new Error(`workflow branch checkout changed for ${record.key}`);
	const checkout = findCheckoutOf(record.sourceRoot, record.branch);
	if (!checkout || canonicalDirectorySync(checkout) !== record.worktree)
		throw new Error(`workflow worktree registration changed for ${record.key}`);
	if (
		commonGitDirectory(record.sourceRoot) !==
		commonGitDirectory(record.worktree)
	)
		throw new Error(
			`workflow repository source identity changed for ${record.key}`,
		);
}

function validatePreparedRecord(record: PreparedWorkflowRepository): void {
	validateCheckout(record);
	if (headSha(record.worktree) !== record.baseSha)
		throw new Error(
			`workflow worktree is not at its approved base for ${record.key}`,
		);
}

function commonGitDirectory(path: string): string {
	const result = runCommand("git", ["rev-parse", "--git-common-dir"], {
		cwd: path,
	});
	if (!result.ok)
		throw new Error(`could not inspect workflow repository identity: ${path}`);
	return realpathSync(resolve(path, result.stdout.trim()));
}

async function loadOrCreateJournal(
	path: string,
	input: PrepareWorkflowRepositoriesInput,
	prepared: Awaited<ReturnType<typeof prepareInput>>,
): Promise<PreparationJournal> {
	if (await pathExists(path)) return await readJournal(path);
	const repositories: Array<
		PreparedWorkflowRepository & { readonly status: "pending" }
	> = [];
	for (const repository of prepared.repositories) {
		if (await pathExists(repository.worktree))
			throw new Error(
				`workflow worktree target already exists for ${repository.key}: ${repository.worktree}`,
			);
		if (branchExists(repository.sourceRoot, repository.branch))
			throw new Error(
				`workflow branch already exists for ${repository.key}: ${repository.branch}`,
			);
		if (findCheckoutOf(repository.sourceRoot, repository.branch))
			throw new Error(
				`workflow branch is already checked out for ${repository.key}`,
			);
		const baseSha = worktreeBaseSha(
			repository.sourceRoot,
			repository.branch,
			repository.base,
		);
		if (!baseSha)
			throw new Error(
				`could not resolve base ${repository.base} for ${repository.key}`,
			);
		repositories.push({
			key: repository.key,
			sourceRoot: repository.sourceRoot,
			worktree: repository.worktree,
			branch: repository.branch,
			baseBranch: repository.base,
			baseSha,
			status: "pending",
		});
	}
	const journal: PreparationJournal = {
		version: 1,
		runId: input.runId,
		planSlug: input.planSlug,
		coordinatedRunRoot: prepared.runRoot,
		repositories,
	};
	await persistPrivateExact(path, `${JSON.stringify(journal)}\n`);
	return journal;
}

function validateJournalIdentity(
	journal: PreparationJournal,
	input: PrepareWorkflowRepositoriesInput,
	prepared: Awaited<ReturnType<typeof prepareInput>>,
): void {
	if (
		journal.runId !== input.runId ||
		journal.planSlug !== input.planSlug ||
		journal.coordinatedRunRoot !== prepared.runRoot ||
		journal.repositories.length !== prepared.repositories.length
	)
		throw new Error(
			"workflow repository preparation journal identity mismatch",
		);
	for (let index = 0; index < journal.repositories.length; index += 1) {
		const record = journal.repositories[index]!;
		const expected = prepared.repositories[index]!;
		if (
			record.key !== expected.key ||
			record.sourceRoot !== expected.sourceRoot ||
			record.worktree !== expected.worktree ||
			record.branch !== expected.branch ||
			record.baseBranch !== expected.base ||
			worktreeBaseSha(expected.sourceRoot, expected.branch, expected.base) !==
				record.baseSha
		)
			throw new Error(
				`workflow repository preparation journal differs for ${record.key}`,
			);
	}
}

async function readJournal(path: string): Promise<PreparationJournal> {
	const value = await readPrivateJson(path, "preparation journal");
	if (!isRecord(value, REGISTRY_KEYS) || value.version !== 1)
		throw new Error("workflow repository preparation journal is invalid");
	if (
		typeof value.runId !== "string" ||
		typeof value.planSlug !== "string" ||
		typeof value.coordinatedRunRoot !== "string" ||
		!Array.isArray(value.repositories)
	)
		throw new Error("workflow repository preparation journal is invalid");
	for (const repository of value.repositories) {
		if (
			!isRecord(repository, JOURNAL_REPOSITORY_KEYS) ||
			typeof repository.key !== "string" ||
			typeof repository.sourceRoot !== "string" ||
			typeof repository.worktree !== "string" ||
			typeof repository.branch !== "string" ||
			typeof repository.baseBranch !== "string" ||
			!safeBranch(repository.baseBranch) ||
			typeof repository.baseSha !== "string" ||
			!SHA_PATTERN.test(repository.baseSha) ||
			(repository.status !== "pending" && repository.status !== "completed")
		)
			throw new Error("workflow repository preparation journal is invalid");
	}
	return value as unknown as PreparationJournal;
}

async function readRegistry(path: string): Promise<RepositoryRegistry> {
	const value = await readPrivateJson(path, "registry");
	if (!isRecord(value, REGISTRY_KEYS) || value.version !== 1)
		throw new Error("workflow repository registry is invalid");
	if (
		typeof value.runId !== "string" ||
		typeof value.planSlug !== "string" ||
		typeof value.coordinatedRunRoot !== "string" ||
		!Array.isArray(value.repositories)
	)
		throw new Error("workflow repository registry is invalid");
	for (const repository of value.repositories) {
		if (
			!isRecord(repository, REPOSITORY_KEYS) ||
			typeof repository.key !== "string" ||
			typeof repository.sourceRoot !== "string" ||
			typeof repository.worktree !== "string" ||
			typeof repository.branch !== "string" ||
			typeof repository.baseBranch !== "string" ||
			!safeBranch(repository.baseBranch) ||
			typeof repository.baseSha !== "string" ||
			!SHA_PATTERN.test(repository.baseSha)
		)
			throw new Error("workflow repository registry is invalid");
	}
	return value as unknown as RepositoryRegistry;
}

function safeBranch(value: string): boolean {
	return (
		Boolean(value.trim()) && !value.startsWith("-") && !/[\0\r\n]/.test(value)
	);
}

async function readPrivateJson(path: string, label: string): Promise<unknown> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT")
			throw new Error(`workflow repository ${label} does not exist`);
		throw error;
	}
	if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600)
		throw new Error(
			`workflow repository ${label} is not a private regular file`,
		);
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function registryPaths(runRoot: string): {
	readonly directory: string;
	readonly registry: string;
	readonly journal: string;
	readonly lock: string;
} {
	const directory = join(runRoot, "runtime", "maestro-repositories");
	return {
		directory,
		registry: join(directory, "registry.json"),
		journal: join(directory, "preparation.json"),
		lock: join(directory, "create.lock"),
	};
}

interface PreparationLease {
	readonly version: 1;
	readonly ownerPid: number;
	readonly token: string;
}

async function acquireCreateLock(
	path: string,
	options: WorkflowRepositoryPreparationOptions,
): Promise<string> {
	const ownerPid = options.ownerPid ?? process.pid;
	if (!Number.isSafeInteger(ownerPid) || ownerPid < 1)
		throw new Error("workflow repository preparation owner pid is invalid");
	const isProcessAlive = options.isProcessAlive ?? processIsAlive;
	const token = randomUUID();
	for (;;) {
		try {
			const handle = await open(path, "wx", 0o600);
			try {
				await handle.writeFile(
					`${JSON.stringify({ version: 1, ownerPid, token })}\n`,
					"utf8",
				);
				await handle.sync();
			} finally {
				await handle.close();
			}
			return token;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		}
		const existing = await readPreparationLease(path);
		if (isProcessAlive(existing.ownerPid))
			throw new Error("workflow repository preparation is already claimed");
		const takeoverPath = `${path}.takeover`;
		const takeoverToken = await acquireTakeoverLock(
			takeoverPath,
			ownerPid,
			isProcessAlive,
		);
		try {
			let current: PreparationLease;
			try {
				current = await readPreparationLease(path);
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") continue;
				throw error;
			}
			if (isProcessAlive(current.ownerPid))
				throw new Error("workflow repository preparation is already claimed");
			if (current.token !== existing.token) continue;
			await unlink(path);
		} finally {
			await releaseCreateLock(takeoverPath, takeoverToken);
		}
	}
}

async function acquireTakeoverLock(
	path: string,
	ownerPid: number,
	isProcessAlive: (pid: number) => boolean,
): Promise<string> {
	const token = randomUUID();
	try {
		const handle = await open(path, "wx", 0o600);
		try {
			await handle.writeFile(
				`${JSON.stringify({ version: 1, ownerPid, token })}\n`,
				"utf8",
			);
			await handle.sync();
		} finally {
			await handle.close();
		}
		return token;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		const existing = await readPreparationLease(path);
		if (isProcessAlive(existing.ownerPid))
			throw new Error("workflow repository preparation takeover is busy");
		await unlink(path);
		return await acquireTakeoverLock(path, ownerPid, isProcessAlive);
	}
}

async function readPreparationLease(path: string): Promise<PreparationLease> {
	const value = await readPrivateJson(path, "preparation claim");
	if (
		!isRecord(value, new Set(["version", "ownerPid", "token"])) ||
		value.version !== 1 ||
		typeof value.ownerPid !== "number" ||
		!Number.isSafeInteger(value.ownerPid) ||
		value.ownerPid < 1 ||
		typeof value.token !== "string" ||
		value.token.length === 0
	)
		throw new Error("workflow repository preparation claim is invalid");
	return value as unknown as PreparationLease;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error) && error.code === "EPERM";
	}
}

async function releaseCreateLock(path: string, token: string): Promise<void> {
	try {
		if ((await readPreparationLease(path)).token !== token)
			throw new Error("workflow repository preparation lock identity changed");
		await unlink(path);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}
}

async function persistPrivateExact(
	path: string,
	contents: string,
): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		try {
			await handle.writeFile(contents, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await link(temporary, path);
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST")
			throw new Error("workflow repository registry collision");
		throw error;
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		});
	}
}

async function replacePrivateExact(
	path: string,
	contents: string,
): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		try {
			await handle.writeFile(contents, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		});
	}
}

async function validateRegistryDirectory(
	path: string,
	runRoot: string,
): Promise<void> {
	const runtime = dirname(path);
	await ensurePrivateChildDirectory(runtime, runRoot);
	await ensurePrivateChildDirectory(path, runtime);
	const canonical = await realpath(path);
	if (canonical !== resolve(path))
		throw new Error("workflow repository registry path contains a symlink");
	assertStrictChild(canonical, runRoot, "workflow repository registry");
}

async function ensurePrivateChildDirectory(
	path: string,
	parent: string,
): Promise<void> {
	assertStrictChild(
		resolve(path),
		resolve(parent),
		"workflow repository state",
	);
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
	}
	const info = await lstat(path);
	if (info.isSymbolicLink())
		throw new Error(`workflow repository state contains a symlink: ${path}`);
	if (!info.isDirectory())
		throw new Error(`workflow repository state is not a directory: ${path}`);
	const canonical = await realpath(path);
	if (canonical !== resolve(path))
		throw new Error(`workflow repository state contains a symlink: ${path}`);
	await chmod(path, 0o700);
}

async function validateExistingRegistryDirectory(
	path: string,
	runRoot: string,
): Promise<void> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT")
			throw new Error("workflow repository registry does not exist");
		throw error;
	}
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		(info.mode & 0o777) !== 0o700
	)
		throw new Error("workflow repository registry directory is not private");
	const canonical = await realpath(path);
	if (canonical !== resolve(path))
		throw new Error("workflow repository registry path contains a symlink");
	assertStrictChild(canonical, runRoot, "workflow repository registry");
}

async function canonicalDirectory(path: string): Promise<string> {
	const info = await lstat(path);
	if (info.isSymbolicLink()) throw new Error(`path is a symlink: ${path}`);
	if (!info.isDirectory())
		throw new Error(`path is not a real directory: ${path}`);
	return await realpath(path);
}

function canonicalDirectorySync(path: string): string {
	const info = lstatSync(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error(`path is not a real directory: ${path}`);
	return realpathSync(path);
}

function assertIdentifier(value: string, label: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value))
		throw new Error(`${label} is invalid`);
}

function assertStrictChild(
	candidate: string,
	parent: string,
	label: string,
): void {
	const rel = relative(parent, candidate);
	if (!rel || rel.startsWith("..") || isAbsolute(rel))
		throw new Error(`${label} must stay below ${parent}`);
}

function pathsOverlap(left: string, right: string): boolean {
	const leftToRight = relative(left, right);
	const rightToLeft = relative(right, left);
	return (
		!leftToRight ||
		(!leftToRight.startsWith("..") && !isAbsolute(leftToRight)) ||
		(!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft))
	);
}

function isRecord(
	value: unknown,
	allowedKeys: ReadonlySet<string>,
): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every((key) => allowedKeys.has(key))
	);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value;
}
