// Durable, maestro-local mapping from canonical review findings to ordinary
// follow-up commits. This module never creates or annotates Git commits and
// never writes into a repository or workflow artifact tree.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { revParse, runCommand } from "@vegardx/pi-git";

export interface DecisionCommitReference {
	readonly repository: string;
	readonly commit: string;
}

export interface DecisionChangedPath {
	readonly repository: string;
	readonly path: string;
}

export interface ReviewFindingDecisionInput {
	readonly findingId: string;
	readonly decision: "changed" | "no_change";
	readonly reasoning: string;
	readonly changedPaths?: readonly DecisionChangedPath[];
	readonly commitRefs?: readonly DecisionCommitReference[];
}

export interface RepositoryReviewBoundaryInput {
	readonly repository: string;
	readonly path: string;
	readonly expectedBranch: string;
	readonly implementationHead: string;
	readonly finalHead: string;
}

export interface SealReviewDecisionLedgerInput {
	readonly runId: string;
	/** Only canonical IDs are consumed; lens/model fields on source objects do not persist. */
	readonly findings: readonly { readonly id: string }[];
	readonly decisions: readonly ReviewFindingDecisionInput[];
	readonly repositories: readonly RepositoryReviewBoundaryInput[];
}

export interface ReviewDecisionLedgerDecision {
	readonly findingId: string;
	readonly decision: "changed" | "no_change";
	readonly reasoning: string;
	readonly changedPaths: readonly DecisionChangedPath[];
	readonly commitRefs: readonly DecisionCommitReference[];
}

export interface ReviewDecisionLedger {
	readonly schema: "maestro-review-decision-ledger-v1";
	readonly runId: string;
	readonly findingIds: readonly string[];
	readonly decisions: readonly ReviewDecisionLedgerDecision[];
	readonly repositories: readonly {
		readonly repository: string;
		readonly expectedBranch: string;
		readonly implementationHead: string;
		readonly finalHead: string;
	}[];
}

export interface ReviewDecisionLedgerReference {
	readonly runId: string;
	readonly digest: string;
}

export interface ReviewDecisionLedgerStoreOptions {
	readonly maestroStateRoot: string;
	/** Repository roots, linked worktrees, and shared workflow-state roots. */
	readonly forbiddenRoots: readonly string[];
}

interface PersistedLedgerEnvelope {
	readonly digest: string;
	readonly ledger: ReviewDecisionLedger;
}

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Seat-owned durable storage for the review decision/commit map.
 *
 * The ledger contains canonical finding IDs, decisions, and commit SHAs only.
 * Reviewer lens/model/task provenance belongs in the separate private review
 * store and is intentionally neither accepted nor serialized here. Because
 * this class only inspects commits, normal implementation commits remain the
 * complete Git history: there are no ledger commits, Git notes, or trailers.
 */
export class ReviewDecisionLedgerStore {
	readonly #root: string;

	constructor(options: ReviewDecisionLedgerStoreOptions) {
		if (options.forbiddenRoots.length === 0)
			throw new Error("decision ledger storage requires forbidden roots");
		const root = join(
			canonicalPath(options.maestroStateRoot),
			"review-decisions",
		);
		for (const forbidden of options.forbiddenRoots.map(canonicalPath)) {
			if (overlaps(root, forbidden))
				throw new Error(
					"decision ledger storage must be disjoint from repositories and workflow state",
				);
		}
		mkdirSync(root, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") chmodSync(root, 0o700);
		this.#root = realpathSync(root);
	}

	seal(input: SealReviewDecisionLedgerInput): {
		readonly reference: ReviewDecisionLedgerReference;
		readonly ledger: ReviewDecisionLedger;
	} {
		const ledger = buildLedger(input);
		const digest = sha256(canonicalJson(ledger));
		const reference = { runId: ledger.runId, digest };
		this.#persist(reference, ledger);
		return { reference, ledger: cloneJson(ledger) };
	}

	load(reference: ReviewDecisionLedgerReference): ReviewDecisionLedger {
		validateReference(reference);
		const path = ledgerPath(this.#root, reference.runId);
		if (lstatSync(path).isSymbolicLink())
			throw new Error("decision ledger cannot be a symbolic link");
		const envelope = JSON.parse(
			readFileSync(path, "utf8"),
		) as PersistedLedgerEnvelope;
		if (!DIGEST_PATTERN.test(envelope.digest))
			throw new Error("invalid decision ledger envelope");
		const actualDigest = sha256(canonicalJson(envelope.ledger));
		if (!sameDigest(actualDigest, envelope.digest))
			throw new Error("decision ledger integrity check failed");
		if (!sameDigest(actualDigest, reference.digest))
			throw new Error("decision ledger reference digest does not match");
		validateStoredLedger(envelope.ledger, reference.runId);
		return cloneJson(envelope.ledger);
	}

	#persist(
		reference: ReviewDecisionLedgerReference,
		ledger: ReviewDecisionLedger,
	): void {
		const target = ledgerPath(this.#root, reference.runId);
		if (existsSync(target)) {
			this.#assertExistingMatches(target, reference);
			return;
		}
		const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
		try {
			writeFileSync(
				temporary,
				canonicalJson({ digest: reference.digest, ledger }),
				{ encoding: "utf8", flag: "wx", mode: 0o600 },
			);
			try {
				// Linking a completed same-directory file is an atomic no-overwrite
				// publication. A racing resume may win, but cannot replace a seal.
				linkSync(temporary, target);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				this.#assertExistingMatches(target, reference);
			}
			if (process.platform !== "win32") chmodSync(target, 0o600);
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	#assertExistingMatches(
		path: string,
		reference: ReviewDecisionLedgerReference,
	): void {
		const existing = JSON.parse(
			readFileSync(path, "utf8"),
		) as PersistedLedgerEnvelope;
		if (existing.digest !== reference.digest)
			throw new Error(
				`decision ledger ${reference.runId} is already sealed with different contents`,
			);
		const actual = sha256(canonicalJson(existing.ledger));
		if (!sameDigest(actual, existing.digest))
			throw new Error("existing decision ledger failed its integrity check");
	}
}

function buildLedger(
	input: SealReviewDecisionLedgerInput,
): ReviewDecisionLedger {
	if (!RUN_ID_PATTERN.test(input.runId))
		throw new Error("invalid decision ledger run ID");
	const findingIds = uniqueStrings(
		input.findings.map(({ id }) => id),
		"finding",
	).sort();
	const repositoryInputs = uniqueBy(
		input.repositories,
		({ repository }) => repository,
		"repository",
	);
	if (repositoryInputs.size === 0)
		throw new Error("decision ledger requires at least one repository");
	const decisionInputs = uniqueBy(
		input.decisions,
		({ findingId }) => findingId,
		"decision",
	);
	assertExactKeys(
		new Set(findingIds),
		new Set(decisionInputs.keys()),
		"decisions",
	);

	const repositories = new Map<
		string,
		{
			path: string;
			expectedBranch: string;
			implementationHead: string;
			finalHead: string;
			postReviewCommits: Set<string>;
			pathsByCommit: ReadonlyMap<string, ReadonlySet<string>>;
		}
	>();
	for (const [repository, boundary] of repositoryInputs) {
		assertCleanWorktree(boundary.path, repository);
		assertExpectedBranch(boundary.path, repository, boundary.expectedBranch);
		const implementationHead = resolveCommit(
			boundary.path,
			boundary.implementationHead,
			`${repository} implementation head`,
		);
		const finalHead = resolveCommit(
			boundary.path,
			boundary.finalHead,
			`${repository} final head`,
		);
		const currentHead = resolveCommit(
			boundary.path,
			"HEAD",
			`${repository} HEAD`,
		);
		if (finalHead !== currentHead)
			throw new Error(`${repository} final head is not the current HEAD`);
		const ancestry = runCommand(
			"git",
			["merge-base", "--is-ancestor", implementationHead, finalHead],
			{ cwd: boundary.path },
		);
		if (!ancestry.ok)
			throw new Error(
				`${repository} implementation head is not an ancestor of final head`,
			);
		const commits = revisionList(
			boundary.path,
			`${implementationHead}..${finalHead}`,
		);
		repositories.set(repository, {
			path: boundary.path,
			expectedBranch: boundary.expectedBranch,
			implementationHead,
			finalHead,
			postReviewCommits: new Set(commits),
			pathsByCommit: new Map(
				commits.map((commit) => [
					commit,
					pathsChangedByCommit(boundary.path, commit),
				]),
			),
		});
	}

	const referencedCommits = new Map(
		[...repositories].map(([repository]) => [repository, new Set<string>()]),
	);
	const declaredChangedPaths = new Map(
		[...repositories].map(([repository]) => [repository, new Set<string>()]),
	);
	const decisions = findingIds.map((findingId) => {
		const inputDecision = decisionInputs.get(findingId);
		if (!inputDecision) throw new Error(`missing decision for ${findingId}`);
		if (
			inputDecision.decision !== "changed" &&
			inputDecision.decision !== "no_change"
		)
			throw new Error(`decision ${findingId} has an invalid outcome`);
		if (!inputDecision.reasoning.trim())
			throw new Error(`decision ${findingId} requires reasoning`);
		const refs = inputDecision.commitRefs ?? [];
		const changedPaths = inputDecision.changedPaths ?? [];
		if (
			inputDecision.decision === "changed" &&
			(refs.length === 0 || changedPaths.length === 0)
		)
			throw new Error(
				`changed decision ${findingId} requires changed paths and a commit reference`,
			);
		if (
			inputDecision.decision === "no_change" &&
			(refs.length > 0 || changedPaths.length > 0)
		)
			throw new Error(
				`no-change decision ${findingId} cannot reference paths or commits`,
			);
		const normalizedPaths = uniqueChangedPaths(changedPaths, repositories).sort(
			compareQualifiedPath,
		);
		for (const changedPath of normalizedPaths)
			declaredChangedPaths.get(changedPath.repository)?.add(changedPath.path);

		const seen = new Set<string>();
		const touchedPaths = new Map<string, Set<string>>();
		const commitRefs = refs.map((ref) => {
			const repository = repositories.get(ref.repository);
			if (!repository)
				throw new Error(
					`decision ${findingId} names unknown repository ${ref.repository}`,
				);
			const commit = resolveCommit(
				repository.path,
				ref.commit,
				"decision commit",
			);
			if (!repository.postReviewCommits.has(commit))
				throw new Error(
					`decision ${findingId} references ${commit} outside the post-review range`,
				);
			const commitPaths = repository.pathsByCommit.get(commit);
			if (!commitPaths)
				throw new Error(`decision commit ${commit} has no inspected diff`);
			const touched = touchedPaths.get(ref.repository) ?? new Set<string>();
			for (const path of commitPaths) touched.add(path);
			touchedPaths.set(ref.repository, touched);
			const declaredPaths = normalizedPaths
				.filter((path) => path.repository === ref.repository)
				.map(({ path }) => path);
			if (!declaredPaths.some((path) => commitPaths.has(path)))
				throw new Error(
					`decision ${findingId} commit ${commit} does not touch a declared changed path`,
				);
			const qualified = `${ref.repository}:${commit}`;
			if (seen.has(qualified))
				throw new Error(`decision ${findingId} repeats commit ${qualified}`);
			seen.add(qualified);
			referencedCommits.get(ref.repository)?.add(commit);
			return { repository: ref.repository, commit };
		});
		commitRefs.sort(
			(a, b) =>
				a.repository.localeCompare(b.repository) ||
				a.commit.localeCompare(b.commit),
		);
		for (const changedPath of normalizedPaths) {
			if (!touchedPaths.get(changedPath.repository)?.has(changedPath.path))
				throw new Error(
					`decision ${findingId} declares changed path ${changedPath.repository}:${changedPath.path} that no referenced commit touches`,
				);
		}
		return {
			findingId,
			decision: inputDecision.decision,
			reasoning: inputDecision.reasoning.trim(),
			changedPaths: normalizedPaths,
			commitRefs,
		};
	});

	for (const [repository, state] of repositories) {
		assertExactKeys(
			state.postReviewCommits,
			referencedCommits.get(repository) ?? new Set(),
			`post-review commits for ${repository}`,
		);
		const actualPaths = new Set<string>();
		for (const paths of state.pathsByCommit.values())
			for (const path of paths) actualPaths.add(path);
		assertExactKeys(
			actualPaths,
			declaredChangedPaths.get(repository) ?? new Set(),
			`post-review changed paths for ${repository}`,
		);
	}

	return {
		schema: "maestro-review-decision-ledger-v1",
		runId: input.runId,
		findingIds,
		decisions,
		repositories: [...repositories]
			.map(([repository, state]) => ({
				repository,
				expectedBranch: state.expectedBranch,
				implementationHead: state.implementationHead,
				finalHead: state.finalHead,
			}))
			.sort((a, b) => a.repository.localeCompare(b.repository)),
	};
}

function validateStoredLedger(
	ledger: ReviewDecisionLedger,
	runId: string,
): void {
	if (
		ledger.schema !== "maestro-review-decision-ledger-v1" ||
		ledger.runId !== runId ||
		!Array.isArray(ledger.findingIds) ||
		!Array.isArray(ledger.decisions) ||
		!Array.isArray(ledger.repositories)
	)
		throw new Error("invalid stored decision ledger");
	uniqueStrings(ledger.findingIds, "finding");
	const decisions = uniqueBy(
		ledger.decisions,
		({ findingId }) => findingId,
		"decision",
	);
	assertExactKeys(
		new Set(ledger.findingIds),
		new Set(decisions.keys()),
		"decisions",
	);
}

function compareQualifiedPath(
	a: DecisionChangedPath,
	b: DecisionChangedPath,
): number {
	return (
		a.repository.localeCompare(b.repository) || a.path.localeCompare(b.path)
	);
}

function assertExpectedBranch(
	cwd: string,
	repository: string,
	expectedBranch: string,
): void {
	if (!expectedBranch.trim())
		throw new Error(`${repository} expected branch cannot be empty`);
	const branch = runCommand(
		"git",
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		{
			cwd,
		},
	);
	if (!branch.ok || branch.stdout.trim() !== expectedBranch)
		throw new Error(
			`${repository} expected branch ${expectedBranch} is not checked out`,
		);
}

function uniqueChangedPaths(
	paths: readonly DecisionChangedPath[],
	repositories: ReadonlyMap<string, { readonly path: string }>,
): DecisionChangedPath[] {
	const result: DecisionChangedPath[] = [];
	const seen = new Set<string>();
	for (const changed of paths) {
		if (!repositories.has(changed.repository))
			throw new Error(
				`changed path names unknown repository ${changed.repository}`,
			);
		const normalized = changed.path.replaceAll("\\", "/");
		if (
			!normalized ||
			isAbsolute(normalized) ||
			normalized.split("/").some((part) => part === "..")
		)
			throw new Error(`invalid changed path ${changed.path}`);
		const key = `${changed.repository}:${normalized}`;
		if (seen.has(key)) throw new Error(`duplicate changed path ${key}`);
		seen.add(key);
		result.push({ repository: changed.repository, path: normalized });
	}
	return result;
}

function pathsChangedByCommit(cwd: string, commit: string): Set<string> {
	const diff = runCommand(
		"git",
		[
			"diff-tree",
			"--root",
			"--no-commit-id",
			"--name-only",
			"-r",
			"-m",
			commit,
		],
		{ cwd },
	);
	if (!diff.ok)
		throw new Error(
			`cannot inspect decision commit ${commit}: ${diff.stderr.trim()}`,
		);
	const paths = new Set(
		diff.stdout
			.split("\n")
			.map((path) => path.trim())
			.filter(Boolean),
	);
	if (paths.size === 0)
		throw new Error(`decision commit ${commit} has an empty diff`);
	return paths;
}

function assertCleanWorktree(cwd: string, repository: string): void {
	const status = runCommand("git", ["status", "--porcelain"], { cwd });
	if (!status.ok)
		throw new Error(
			`${repository} worktree status cannot be inspected: ${status.stderr.trim() || "git failed"}`,
		);
	if (status.stdout.trim().length > 0)
		throw new Error(`${repository} worktree is not clean at decision seal`);
}

function revisionList(cwd: string, range: string): string[] {
	const result = runCommand("git", ["rev-list", "--reverse", range], { cwd });
	if (!result.ok)
		throw new Error(
			`cannot inspect post-review commit range: ${result.stderr.trim()}`,
		);
	return result.stdout
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean);
}

function resolveCommit(cwd: string, value: string, label: string): string {
	const resolved = revParse(cwd, value);
	if (!resolved) throw new Error(`${label} does not resolve to a commit`);
	return resolved;
}

function uniqueStrings(values: readonly string[], label: string): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!value.trim()) throw new Error(`${label} ID cannot be empty`);
		if (seen.has(value)) throw new Error(`duplicate ${label} ${value}`);
		seen.add(value);
		result.push(value);
	}
	return result;
}

function uniqueBy<T>(
	values: readonly T[],
	key: (value: T) => string,
	label: string,
): Map<string, T> {
	const result = new Map<string, T>();
	for (const value of values) {
		const id = key(value);
		if (!id.trim()) throw new Error(`${label} ID cannot be empty`);
		if (result.has(id)) throw new Error(`duplicate ${label} ${id}`);
		result.set(id, value);
	}
	return result;
}

function assertExactKeys(
	expected: Set<string>,
	actual: Set<string>,
	label: string,
): void {
	const missing = [...expected].filter((value) => !actual.has(value));
	const unknown = [...actual].filter((value) => !expected.has(value));
	if (missing.length > 0 || unknown.length > 0)
		throw new Error(
			`${label} do not exactly cover the expected set` +
				` (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
		);
}

function validateReference(reference: ReviewDecisionLedgerReference): void {
	if (
		!RUN_ID_PATTERN.test(reference.runId) ||
		!DIGEST_PATTERN.test(reference.digest)
	)
		throw new Error("invalid decision ledger reference");
}

function ledgerPath(root: string, runId: string): string {
	if (!RUN_ID_PATTERN.test(runId))
		throw new Error("invalid decision ledger run ID");
	const path = resolve(root, `${runId}.json`);
	if (!isWithin(path, root))
		throw new Error("decision ledger escaped its root");
	return path;
}

function sameDigest(a: string, b: string): boolean {
	if (!DIGEST_PATTERN.test(a) || !DIGEST_PATTERN.test(b)) return false;
	const left = Buffer.from(a, "hex");
	const right = Buffer.from(b, "hex");
	return left.length === right.length && timingSafeEqual(left, right);
}

function overlaps(a: string, b: string): boolean {
	return isWithin(a, b) || isWithin(b, a);
}

function isWithin(candidate: string, parent: string): boolean {
	const rel = relative(parent, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalPath(input: string): string {
	let cursor = resolve(input);
	const missing: string[] = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		missing.unshift(basename(cursor));
		cursor = parent;
	}
	return resolve(realpathSync(cursor), ...missing);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function cloneJson<T>(value: T): T {
	return JSON.parse(canonicalJson(value)) as T;
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("ledger values must be finite");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
			.join(",")}}`;
	}
	throw new Error("ledger values must be JSON-compatible");
}
