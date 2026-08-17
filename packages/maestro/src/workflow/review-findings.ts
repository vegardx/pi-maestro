// Deterministic boundary between reviewer output and the implementer.
// Reviewer/runtime identity is enriched by maestro, retained in private
// provenance, and never copied into the sanitized finding projection.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import type {
	FindingContributor,
	FindingEvidence,
	FindingProvenance,
	RawReviewFinding,
	SanitizedFinding,
} from "./private-artifacts.js";

export interface ReviewerFindingSubmission {
	readonly taskId: string;
	/** Untrusted model output. Expected shape: an array of claim/evidence objects. */
	readonly findings: unknown;
}

/** Trusted runtime identity, resolved by Maestro rather than reviewer output. */
export interface ApprovedReviewerTask {
	readonly lens: string;
	readonly stageId: string;
	readonly taskId: string;
	readonly resolvedModel: string;
}

export interface ReviewFindingNormalizationContext {
	readonly approvedRepositories: readonly string[];
	readonly approvedReviewerTasks: readonly ApprovedReviewerTask[];
}

export interface NormalizedReviewFindings {
	/** The complete value allowed into the implementer stage. */
	readonly sanitizedFindings: readonly SanitizedFinding[];
	/** Seat-private normalized raw findings. */
	readonly rawFindings: readonly RawReviewFinding[];
	/** Seat-private canonical-finding to reviewer membership. */
	readonly provenance: readonly FindingProvenance[];
}

interface FindingGroup {
	readonly key: string;
	readonly rawFindings: RawReviewFinding[];
}

/**
 * Validate untrusted reviewer findings, conservatively deduplicate exact
 * normalized claim/location overlaps, and produce stable order-independent
 * public/private projections.
 *
 * Deduplication is deliberately mechanical: normalized claim plus evidence
 * locations. It does not ask another model to judge equivalence and therefore
 * cannot introduce severity, votes, or remediation into the result.
 */
export function normalizeRawReviewFindings(
	submissions: readonly ReviewerFindingSubmission[],
	context: ReviewFindingNormalizationContext,
): NormalizedReviewFindings {
	const repositoryIds = approvedRepositoryIds(context.approvedRepositories);
	const reviewerTasks = approvedReviewerTasks(context.approvedReviewerTasks);
	const taskKeys = new Set<string>();
	const rawById = new Map<string, RawReviewFinding>();
	const groups = new Map<string, FindingGroup>();

	for (const submission of submissions) {
		const taskId = requiredText(submission.taskId, "review task ID");
		for (const forbidden of ["lens", "stageId", "resolvedModel"])
			if (forbidden in submission)
				throw new Error(
					`reviewer submission ${taskId} cannot supply orchestrator-owned ${forbidden}`,
				);
		const task = reviewerTasks.get(taskId);
		if (!task)
			throw new Error(`reviewer submission names unknown task ${taskId}`);
		if (taskKeys.has(taskId))
			throw new Error(`duplicate reviewer task output ${taskId}`);
		taskKeys.add(taskId);
		if (!Array.isArray(submission.findings))
			throw new Error(`reviewer task ${taskId} findings must be an array`);

		const findingKeys = new Set<string>();
		for (const [index, value] of submission.findings.entries()) {
			const parsed = parseFinding(
				value,
				`${taskId} finding ${index}`,
				repositoryIds,
			);
			const key = dedupKey(parsed);
			if (findingKeys.has(key))
				throw new Error(`reviewer task ${taskId} repeated one finding`);
			findingKeys.add(key);
			const rawId = `raw-${sha256(
				rawFindingIdentity({ ...task, ...parsed, rawId: "" }),
			).slice(0, 32)}`;
			if (rawById.has(rawId)) throw new Error(`duplicate raw finding ${rawId}`);
			const raw: RawReviewFinding = {
				rawId,
				lens: task.lens,
				claim: parsed.claim,
				evidence: parsed.evidence,
				stageId: task.stageId,
				taskId,
				resolvedModel: task.resolvedModel,
			};
			rawById.set(rawId, raw);
			const group = groups.get(key) ?? { key, rawFindings: [] };
			group.rawFindings.push(raw);
			groups.set(key, group);
		}
	}
	if (
		taskKeys.size !== reviewerTasks.size ||
		[...reviewerTasks.keys()].some((taskId) => !taskKeys.has(taskId))
	)
		throw new Error("reviewer outputs must exactly cover approved tasks");

	const sanitizedFindings: SanitizedFinding[] = [];
	const provenance: FindingProvenance[] = [];
	for (const group of groups.values()) {
		const claim = group.rawFindings
			.map(({ claim }) => claim)
			.sort(compareText)[0] as string;
		const evidence = mergeEvidence(
			group.rawFindings.flatMap((finding) => [...finding.evidence]),
		);
		const id = canonicalFindingId({ claim, evidence });
		sanitizedFindings.push({ id, claim, evidence });
		provenance.push({
			findingId: id,
			contributors: group.rawFindings
				.map(contributorFromRaw)
				.sort((a, b) => compareText(a.rawFindingId, b.rawFindingId)),
		});
	}

	sanitizedFindings.sort((a, b) => compareText(a.id, b.id));
	provenance.sort((a, b) => compareText(a.findingId, b.findingId));
	const result: NormalizedReviewFindings = {
		sanitizedFindings,
		rawFindings: [...rawById.values()].sort((a, b) =>
			compareText(a.rawId, b.rawId),
		),
		provenance,
	};
	validateNormalizedReviewFindings(result, context);
	return result;
}

/** Validate private contributor membership before durable storage or joining. */
export function validateNormalizedReviewFindings(
	result: NormalizedReviewFindings,
	context: ReviewFindingNormalizationContext,
): void {
	const repositoryIds = approvedRepositoryIds(context.approvedRepositories);
	const reviewerTasks = approvedReviewerTasks(context.approvedReviewerTasks);
	const sanitizedById = uniqueBy(
		result.sanitizedFindings,
		({ id }) => id,
		"canonical finding",
	);
	const rawById = uniqueBy(
		result.rawFindings,
		({ rawId }) => rawId,
		"raw finding",
	);
	const provenanceById = uniqueBy(
		result.provenance,
		({ findingId }) => findingId,
		"finding provenance",
	);
	assertSameKeys(sanitizedById, provenanceById, "provenance");

	const usedRawIds = new Set<string>();
	const expectedByFinding = new Map<string, SanitizedFinding>();
	for (const [findingId, finding] of sanitizedById) {
		parseFinding(finding, `canonical finding ${findingId}`, repositoryIds);
		if (canonicalFindingId(finding) !== findingId)
			throw new Error(
				`canonical finding ${findingId} has an invalid content ID`,
			);
		const membership = provenanceById.get(findingId);
		if (!membership || membership.contributors.length === 0)
			throw new Error(`canonical finding ${findingId} has no contributors`);
		const groupRawFindings: RawReviewFinding[] = [];
		for (const contributor of membership.contributors) {
			if (usedRawIds.has(contributor.rawFindingId))
				throw new Error(
					`raw finding ${contributor.rawFindingId} contributes more than once`,
				);
			const raw = rawById.get(contributor.rawFindingId);
			if (!raw)
				throw new Error(
					`contributor names unknown raw finding ${contributor.rawFindingId}`,
				);
			if (!sameContributor(raw, contributor))
				throw new Error(
					`contributor metadata does not match raw finding ${raw.rawId}`,
				);
			const expectedTask = reviewerTasks.get(raw.taskId);
			if (!expectedTask || !sameApprovedTask(raw, expectedTask))
				throw new Error(
					`raw finding ${raw.rawId} has unapproved task identity`,
				);
			const parsedRaw = parseFinding(
				raw,
				`raw finding ${raw.rawId}`,
				repositoryIds,
			);
			if (
				canonicalJson(parsedRaw) !==
				canonicalJson({ claim: raw.claim, evidence: raw.evidence })
			)
				throw new Error(`raw finding ${raw.rawId} is not normalized`);
			if (`raw-${sha256(rawFindingIdentity(raw)).slice(0, 32)}` !== raw.rawId)
				throw new Error(`raw finding ${raw.rawId} has an invalid content ID`);
			if (dedupKey(raw) !== dedupKey(finding))
				throw new Error(
					`raw finding ${raw.rawId} belongs to another canonical finding`,
				);
			groupRawFindings.push(raw);
			usedRawIds.add(raw.rawId);
		}
		const expectedClaim = groupRawFindings
			.map(({ claim }) => claim)
			.sort(compareText)[0] as string;
		const expectedEvidence = mergeEvidence(
			groupRawFindings.flatMap(({ evidence }) => [...evidence]),
		);
		const expectedFinding: SanitizedFinding = {
			id: canonicalFindingId({
				claim: expectedClaim,
				evidence: expectedEvidence,
			}),
			claim: expectedClaim,
			evidence: expectedEvidence,
		};
		expectedByFinding.set(findingId, expectedFinding);
	}
	if (usedRawIds.size !== rawById.size)
		throw new Error("every raw finding must contribute exactly once");
	for (const [findingId, finding] of sanitizedById) {
		if (
			canonicalJson(finding) !== canonicalJson(expectedByFinding.get(findingId))
		)
			throw new Error(
				`canonical finding ${findingId} does not match its raw findings`,
			);
	}
}

function approvedReviewerTasks(
	values: readonly ApprovedReviewerTask[],
): Map<string, ApprovedReviewerTask> {
	if (values.length === 0)
		throw new Error("finding normalization requires approved reviewer tasks");
	const result = new Map<string, ApprovedReviewerTask>();
	for (const value of values) {
		const task = {
			lens: requiredText(value.lens, "approved reviewer lens"),
			stageId: requiredText(value.stageId, "approved reviewer stage ID"),
			taskId: requiredText(value.taskId, "approved reviewer task ID"),
			resolvedModel: requiredText(
				value.resolvedModel,
				"approved reviewer model",
			),
		};
		if (result.has(task.taskId))
			throw new Error(`duplicate approved reviewer task ${task.taskId}`);
		result.set(task.taskId, task);
	}
	return result;
}

function rawFindingIdentity(
	raw: Omit<RawReviewFinding, "rawId"> | RawReviewFinding,
): string {
	return canonicalJson({
		lens: raw.lens,
		stageId: raw.stageId,
		taskId: raw.taskId,
		resolvedModel: raw.resolvedModel,
		finding: { claim: raw.claim, evidence: raw.evidence },
	});
}

function sameApprovedTask(
	raw: RawReviewFinding,
	task: ApprovedReviewerTask,
): boolean {
	return (
		raw.lens === task.lens &&
		raw.stageId === task.stageId &&
		raw.taskId === task.taskId &&
		raw.resolvedModel === task.resolvedModel
	);
}

function parseFinding(
	value: unknown,
	label: string,
	approvedRepositories: ReadonlySet<string>,
): Omit<SanitizedFinding, "id"> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const claim = normalizedText(value.claim, `${label} claim`);
	if (!Array.isArray(value.evidence) || value.evidence.length === 0)
		throw new Error(`${label} evidence must be a non-empty array`);
	const evidence = mergeEvidence(
		value.evidence.map((item, index) =>
			parseEvidence(item, `${label} evidence ${index}`, approvedRepositories),
		),
	);
	return { claim, evidence };
}

function parseEvidence(
	value: unknown,
	label: string,
	approvedRepositories: ReadonlySet<string>,
): FindingEvidence {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const repository = requiredText(value.repository, `${label} repository`);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(repository))
		throw new Error(`${label} repository must be a registry key`);
	if (!approvedRepositories.has(repository))
		throw new Error(`${label} names unknown repository ${repository}`);
	const rawPath = requiredText(value.path, `${label} path`).replaceAll(
		"\\",
		"/",
	);
	const path = posix.normalize(rawPath.replace(/^\.\//, ""));
	if (
		posix.isAbsolute(rawPath) ||
		/^[a-zA-Z]:/.test(rawPath) ||
		rawPath.startsWith("//") ||
		path === "." ||
		path === ".." ||
		path.startsWith("../") ||
		path.includes("\u0000")
	)
		throw new Error(`${label} path must stay within a repository`);
	const observation = normalizedText(value.observation, `${label} observation`);
	if (value.line === undefined) return { repository, path, observation };
	if (!Number.isInteger(value.line) || (value.line as number) < 1)
		throw new Error(`${label} line must be a positive integer`);
	return { repository, path, line: value.line as number, observation };
}

function approvedRepositoryIds(values: readonly string[]): Set<string> {
	if (values.length === 0)
		throw new Error("finding normalization requires approved repositories");
	const result = new Set<string>();
	for (const value of values) {
		const repository = requiredText(value, "approved repository");
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(repository))
			throw new Error(
				`approved repository ${repository} must be a registry key`,
			);
		if (result.has(repository))
			throw new Error(`duplicate approved repository ${repository}`);
		result.add(repository);
	}
	return result;
}

function mergeEvidence(values: readonly FindingEvidence[]): FindingEvidence[] {
	const bySemanticEvidence = new Map<string, FindingEvidence>();
	for (const evidence of values) {
		// One public evidence item per location avoids turning corroborating
		// reviewer wording into an implicit agreement count. Contributor-specific
		// observations remain available in the private raw findings.
		const key = canonicalJson({
			repository: evidence.repository,
			path: evidence.path,
			line: evidence.line ?? null,
		});
		const existing = bySemanticEvidence.get(key);
		if (!existing || compareEvidence(evidence, existing) < 0)
			bySemanticEvidence.set(key, evidence);
	}
	return [...bySemanticEvidence.values()]
		.sort(compareEvidence)
		.map((evidence) =>
			evidence.line === undefined
				? {
						repository: evidence.repository,
						path: evidence.path,
						observation: evidence.observation,
					}
				: {
						repository: evidence.repository,
						path: evidence.path,
						line: evidence.line,
						observation: evidence.observation,
					},
		);
}

function dedupKey(finding: {
	claim: string;
	evidence: readonly FindingEvidence[];
}): string {
	const locations = new Map<
		string,
		{ repository: string; path: string; line: number | null }
	>();
	for (const { repository, path, line } of finding.evidence) {
		const location = { repository, path, line: line ?? null };
		locations.set(canonicalJson(location), location);
	}
	return canonicalJson({
		claim: normalizedText(finding.claim, "finding claim").toLowerCase(),
		locations: [...locations.values()].sort((a, b) =>
			compareText(canonicalJson(a), canonicalJson(b)),
		),
	});
}

function canonicalFindingId(finding: {
	claim: string;
	evidence: readonly FindingEvidence[];
}): string {
	// The ID names the dedup group, not display wording. Corroboration can add a
	// differently worded observation without churning an existing decision ID.
	return `finding-${sha256(dedupKey(finding)).slice(0, 32)}`;
}

function contributorFromRaw(raw: RawReviewFinding): FindingContributor {
	return {
		rawFindingId: raw.rawId,
		lens: raw.lens,
		stageId: raw.stageId,
		taskId: raw.taskId,
		resolvedModel: raw.resolvedModel,
	};
}

function sameContributor(
	raw: RawReviewFinding,
	contributor: FindingContributor,
): boolean {
	return (
		raw.rawId === contributor.rawFindingId &&
		raw.lens === contributor.lens &&
		raw.stageId === contributor.stageId &&
		raw.taskId === contributor.taskId &&
		raw.resolvedModel === contributor.resolvedModel
	);
}

function normalizedText(value: unknown, label: string): string {
	return requiredText(value, label).replace(/\s+/gu, " ");
}

function requiredText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${label} must be non-empty text`);
	if (value.includes("\u0000")) throw new Error(`${label} cannot contain NUL`);
	return value.trim();
}

function uniqueBy<T>(
	values: readonly T[],
	keyOf: (value: T) => string,
	label: string,
): Map<string, T> {
	const result = new Map<string, T>();
	for (const value of values) {
		const key = keyOf(value);
		if (result.has(key)) throw new Error(`duplicate ${label} ${key}`);
		result.set(key, value);
	}
	return result;
}

function assertSameKeys<T, U>(
	a: ReadonlyMap<string, T>,
	b: ReadonlyMap<string, U>,
	label: string,
): void {
	if (a.size !== b.size || [...a.keys()].some((key) => !b.has(key)))
		throw new Error(`${label} must exactly cover canonical findings`);
}

function compareEvidence(a: FindingEvidence, b: FindingEvidence): number {
	return compareText(
		canonicalJson({
			repository: a.repository,
			path: a.path,
			line: a.line ?? null,
			observation: a.observation,
		}),
		canonicalJson({
			repository: b.repository,
			path: b.path,
			line: b.line ?? null,
			observation: b.observation,
		}),
	);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("finding data must be finite");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	throw new Error("finding data must be JSON-compatible");
}
