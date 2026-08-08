// Maestro-private review artifacts.
//
// Workflow tasks receive only SanitizedReviewProjection. The opaque reference
// is useful to the seat, but deliberately carries neither a path nor review
// provenance. Raw reviewer output and model/task identity stay in a separate
// maestro state root, never in a coordinated repository or pi-workflow's
// shared state tree.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
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

export interface FindingEvidence {
	readonly path: string;
	readonly line?: number;
	readonly observation: string;
}

export interface SanitizedFinding {
	readonly id: string;
	readonly claim: string;
	readonly evidence: readonly FindingEvidence[];
}

export interface RawReviewFinding {
	readonly rawId: string;
	readonly lens: string;
	readonly claim: string;
	readonly evidence: readonly FindingEvidence[];
	readonly stageId: string;
	readonly taskId: string;
	readonly resolvedModel: string;
}

export interface FindingContributor {
	readonly rawFindingId: string;
	readonly lens: string;
	readonly stageId: string;
	readonly taskId: string;
	readonly resolvedModel: string;
}

export interface FindingProvenance {
	readonly findingId: string;
	readonly contributors: readonly FindingContributor[];
}

export interface ReviewDecision {
	readonly findingId: string;
	readonly decision: "changed" | "no_change";
	readonly reasoning: string;
	readonly commitRefs?: readonly string[];
}

export interface PrivateArtifactReference {
	/** Random identifier, not a filename supplied by a caller. */
	readonly id: string;
	/** SHA-256 of the complete private envelope. */
	readonly digest: string;
}

/** The only review value intended to cross into an implementer stage. */
export interface SanitizedReviewProjection {
	readonly findings: readonly SanitizedFinding[];
}

/** Seat-owned handle plus the strictly smaller implementer projection. */
export interface StoredPrivateReview {
	readonly reference: PrivateArtifactReference;
	readonly projection: SanitizedReviewProjection;
}

export interface JoinedReviewFinding {
	readonly finding: SanitizedFinding;
	readonly decision: ReviewDecision;
	readonly provenance: FindingProvenance;
}

/** Seat-only result, created after the implementer has closed its decisions. */
export interface JoinedPrivateReview {
	readonly findings: readonly JoinedReviewFinding[];
	readonly rawFindings: readonly RawReviewFinding[];
}

export interface PrivateArtifactStoreOptions {
	/** State owned by the depth-0 maestro seat, outside all working trees. */
	readonly maestroStateRoot: string;
	/** Source repositories and coordinated linked worktrees. */
	readonly coordinatedRepositoryRoots: readonly string[];
	/** Every shared `.pi/workflows` root used by the workflow runtime. */
	readonly sharedWorkflowRoots: readonly string[];
}

interface PrivateReviewEnvelope {
	readonly version: 1;
	readonly id: string;
	readonly sanitizedFindings: readonly SanitizedFinding[];
	readonly rawFindings: readonly RawReviewFinding[];
	readonly provenance: readonly FindingProvenance[];
}

const ID_PATTERN = /^[a-f0-9]{32}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/**
 * This store prevents accidental disclosure and detects at-rest tampering. It
 * is not, by itself, a read-security boundary against a malicious process
 * running as the same host user: such a process can ignore mode bits and seek
 * out the maestro state directory. Actual hostile-agent confidentiality still
 * requires the process sandbox to omit this root from its readable paths (or a
 * separate OS identity). The adapter makes that root singular and explicit so
 * the sandbox can enforce the boundary.
 */
export class PrivateArtifactStore {
	readonly #root: string;

	constructor(options: PrivateArtifactStoreOptions) {
		if (options.coordinatedRepositoryRoots.length === 0)
			throw new Error("private artifact storage requires coordinated roots");
		if (options.sharedWorkflowRoots.length === 0)
			throw new Error("private artifact storage requires workflow state roots");

		const stateRoot = canonicalPath(options.maestroStateRoot);
		const artifactRoot = join(stateRoot, "private-artifacts");
		const forbidden = [
			...options.coordinatedRepositoryRoots,
			...options.sharedWorkflowRoots,
		].map(canonicalPath);
		for (const root of forbidden) {
			if (overlaps(artifactRoot, root))
				throw new Error(
					"private artifact storage must be disjoint from repositories and workflow state",
				);
		}

		mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") chmodSync(artifactRoot, 0o700);
		this.#root = realpathSync(artifactRoot);
	}

	putReview(input: {
		readonly sanitizedFindings: readonly SanitizedFinding[];
		readonly rawFindings: readonly RawReviewFinding[];
		readonly provenance: readonly FindingProvenance[];
	}): StoredPrivateReview {
		const id = randomBytes(16).toString("hex");
		const envelope = cloneJson<PrivateReviewEnvelope>({
			version: 1,
			id,
			sanitizedFindings: input.sanitizedFindings,
			rawFindings: input.rawFindings,
			provenance: input.provenance,
		});
		validateEnvelope(envelope);
		const payload = canonicalJson(envelope);
		const digest = sha256(payload);
		this.#write(id, payload);
		return {
			reference: { id, digest },
			projection: {
				findings: cloneJson(envelope.sanitizedFindings),
			},
		};
	}

	joinAfterDecisions(
		reference: PrivateArtifactReference,
		decisions: readonly ReviewDecision[],
	): JoinedPrivateReview {
		const envelope = this.#read(reference);
		const decisionByFinding = uniqueByFinding(decisions, "decision");
		const provenanceByFinding = uniqueByFinding(
			envelope.provenance,
			"provenance",
		);
		const findingIds = new Set(envelope.sanitizedFindings.map(({ id }) => id));
		for (const findingId of decisionByFinding.keys()) {
			if (!findingIds.has(findingId))
				throw new Error(`decision names unknown finding ${findingId}`);
		}

		const findings = envelope.sanitizedFindings.map((finding) => {
			const decision = decisionByFinding.get(finding.id);
			const provenance = provenanceByFinding.get(finding.id);
			if (!decision) throw new Error(`missing decision for ${finding.id}`);
			if (!provenance) throw new Error(`missing provenance for ${finding.id}`);
			return { finding, decision, provenance };
		});
		return cloneJson({ findings, rawFindings: envelope.rawFindings });
	}

	#write(id: string, payload: string): void {
		const target = containedArtifactPath(this.#root, id);
		const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
		try {
			writeFileSync(temporary, payload, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			renameSync(temporary, target);
			if (process.platform !== "win32") chmodSync(target, 0o600);
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	#read(reference: PrivateArtifactReference): PrivateReviewEnvelope {
		if (
			!ID_PATTERN.test(reference.id) ||
			!DIGEST_PATTERN.test(reference.digest)
		)
			throw new Error("invalid private artifact reference");
		const path = containedArtifactPath(this.#root, reference.id);
		if (lstatSync(path).isSymbolicLink())
			throw new Error("private artifact cannot be a symbolic link");
		const payload = readFileSync(path, "utf8");
		const actual = Buffer.from(sha256(payload), "hex");
		const expected = Buffer.from(reference.digest, "hex");
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
			throw new Error("private artifact integrity check failed");
		const envelope = JSON.parse(payload) as PrivateReviewEnvelope;
		validateEnvelope(envelope);
		if (envelope.id !== reference.id)
			throw new Error("private artifact reference does not match its envelope");
		return envelope;
	}
}

function uniqueByFinding<T extends { readonly findingId: string }>(
	values: readonly T[],
	label: string,
): Map<string, T> {
	const result = new Map<string, T>();
	for (const value of values) {
		if (result.has(value.findingId))
			throw new Error(`duplicate ${label} for ${value.findingId}`);
		result.set(value.findingId, value);
	}
	return result;
}

function validateEnvelope(value: PrivateReviewEnvelope): void {
	if (
		value.version !== 1 ||
		!ID_PATTERN.test(value.id) ||
		!Array.isArray(value.sanitizedFindings) ||
		!Array.isArray(value.rawFindings) ||
		!Array.isArray(value.provenance)
	)
		throw new Error("invalid private review envelope");

	const sanitizedIds = uniqueByKey(
		value.sanitizedFindings,
		({ id }) => id,
		"sanitized finding",
	);
	const rawById = uniqueByKey(
		value.rawFindings,
		({ rawId }) => rawId,
		"raw finding",
	);
	const provenanceByFinding = uniqueByFinding(value.provenance, "provenance");
	if (sanitizedIds.size !== provenanceByFinding.size)
		throw new Error("private review provenance must exactly cover findings");
	for (const [findingId, provenance] of provenanceByFinding) {
		if (!sanitizedIds.has(findingId))
			throw new Error(`provenance names unknown finding ${findingId}`);
		if (provenance.contributors.length === 0)
			throw new Error(`provenance has no contributors for ${findingId}`);
		for (const contributor of provenance.contributors) {
			const raw = rawById.get(contributor.rawFindingId);
			if (!raw)
				throw new Error(
					`contributor names unknown raw finding ${contributor.rawFindingId}`,
				);
			if (
				raw.lens !== contributor.lens ||
				raw.stageId !== contributor.stageId ||
				raw.taskId !== contributor.taskId ||
				raw.resolvedModel !== contributor.resolvedModel
			)
				throw new Error(
					`contributor metadata does not match raw finding ${contributor.rawFindingId}`,
				);
		}
	}
}

function uniqueByKey<T>(
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

function containedArtifactPath(root: string, id: string): string {
	if (!ID_PATTERN.test(id)) throw new Error("invalid private artifact id");
	const path = resolve(root, `${id}.json`);
	if (!isWithin(path, root))
		throw new Error("private artifact escaped its root");
	return path;
}

function overlaps(a: string, b: string): boolean {
	return isWithin(a, b) || isWithin(b, a);
}

function isWithin(candidate: string, parent: string): boolean {
	const rel = relative(parent, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve symlinks in the nearest existing ancestor, including future paths. */
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

/** Stable JSON makes the reference digest independent of object insertion order. */
function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("private artifacts require finite numbers");
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
	throw new Error("private artifacts must contain JSON values only");
}
