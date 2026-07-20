// v2 agent contracts: the typed envelope every spawned agent's result must
// fulfill, parsed by the parent/harness. See docs/design/v2-primitives.md and
// docs/design/spikes/contracts.md (the settled spike this implements).
//
// Two layers, strictly separated: the AGENT-authored envelope (what the model
// wrote inside its ```pi-contract fence) wrapped in a HARNESS-authored result
// (provenance, extraction facts, git-derived diff facts). Models never author
// the outer layer; the harness never invents the inner one. Mechanical facts
// (diffs, verdict projections) are derived, never model-asserted.
//
// This module is the library: ids, payload schemas, hand-rolled validators
// with ENFORCED bounds (v1 declared requiredMarkers/maxWords and never checked
// them), the fence extractor, the salvage tiers (re-homed v1 parsers from
// ./review.js), and the migrate-on-read helper. The steer-and-retry loop and
// transport wiring live with the executor (they need RPC machinery).

import { parseStructuredFindings, parseVerdict } from "./review.js";

// ─── Contract ids ────────────────────────────────────────────────────────────

export const CONTRACT_IDS = [
	"summary-and-diff", // worker
	"findings", // reviewer
	"report", // explorer
	"verdict", // callers: command-auditor; verify-findings / verify-delivery
	"plan-gate-report", // the plan→auto gate (renamed from v1's bounded-report)
] as const;
export type ContractId = (typeof CONTRACT_IDS)[number];

// ─── The two-layer result ────────────────────────────────────────────────────

/** What the agent writes inside its fenced block. */
export interface ContractEnvelope<
	Id extends ContractId = ContractId,
	P = unknown,
> {
	readonly contract: Id;
	/** Schema version of this contract id (integer; migrate-on-read). */
	readonly v: number;
	/** "complete" normally; "partial" when wrapping up under a watchdog steer. */
	readonly status: "complete" | "partial";
	readonly payload: P;
}

export type ExtractionTier =
	| "block" // sentinel fence parsed and validated
	| "retry-block" // ditto, after ≥1 corrective steer
	| "salvage-parse" // harness heuristics over free text (legacy parsers)
	| "fallback"; // harness-authored; agent contributed nothing parseable

/** What the harness persists on the plan ledger for the node. */
export interface ContractResult<
	Id extends ContractId = ContractId,
	P = unknown,
> {
	readonly envelope: ContractEnvelope<Id, P> | null; // null only when fallback
	readonly extraction: ExtractionTier;
	readonly attempts: number; // 1..3
	/** Full final-message text (prose + block) — HUD/humans read this. */
	readonly raw: string;
	readonly nodeId: string;
	readonly runId: string;
	readonly model: string; // resolved model that produced it
	readonly completedAt: string; // ISO
	/** Validation errors overridden by salvage, for explain output. */
	readonly diagnostics?: readonly string[];
}

// ─── summary-and-diff (worker) ───────────────────────────────────────────────

export interface SummaryAndDiffPayload {
	/** Markdown completion summary; truncated to the summary budget on store. */
	readonly summary: string;
	readonly outcome: "done" | "partial" | "blocked";
	/** One entry per task the node carried, in task order. */
	readonly tasks: readonly {
		readonly id: string;
		readonly state: "done" | "partial" | "not-done";
		readonly note?: string; // required when state !== "done"
	}[];
	/** Commands the worker ran to validate (tests, typecheck, lint). */
	readonly validation?: readonly {
		readonly command: string;
		readonly result: "pass" | "fail" | "not-run";
		readonly note?: string;
	}[];
	/** Work discovered but deliberately not done. */
	readonly followUps?: readonly string[];
	/** Required when outcome === "blocked". */
	readonly blockedReason?: string;
}

/**
 * The diff's shape in harness-side facts and hand-offs. Agents author NO diff
 * field at all — "ref" is what the harness verifies against git at collection
 * time; "patch" appears only in harness-materialized hand-offs (ensembles);
 * "none" distinguishes scratch nodes and empty outcomes from collection
 * failure (which is a fail-visible node error, not a DiffPayload).
 */
export type DiffPayload =
	| {
			readonly kind: "ref";
			readonly branch: string;
			readonly baseSha: string;
			readonly headSha: string;
	  }
	| { readonly kind: "patch"; readonly baseSha: string; readonly text: string }
	| { readonly kind: "none"; readonly reason: "scratch-node" | "no-changes" };

/** Harness-derived at collection time; stored alongside the envelope. */
export interface DiffFact {
	readonly diff: DiffPayload;
	readonly stat: {
		readonly files: number;
		readonly insertions: number;
		readonly deletions: number;
	};
	/** True when the worktree still had uncommitted changes at collection. */
	readonly dirty: boolean;
}

// ─── findings (reviewer) ─────────────────────────────────────────────────────

/**
 * A review finding is a NEUTRAL observation: what the code actually does,
 * where, with what consequence — no severity, no category, no verdict
 * language. Interpretation belongs to the consumer: the requesting agent
 * (usually the worker whose diff was reviewed) judges what blocks and what
 * doesn't. Ratings authored by the reviewer would poison that judgment
 * (settled in the #254 review, 2026-07-20 — deviates from the contracts
 * spike, which carried v1's severity field forward).
 */
export interface ReviewFinding {
	readonly id: string;
	/** What the code actually does — observed, not judged. */
	readonly actual: string;
	/** What happens as a consequence — factual mechanism, not a rating. */
	readonly consequence?: string;
	readonly file?: string;
	readonly line?: number;
	/** The claim under review, when verifying one. */
	readonly claim?: string;
	readonly evidence?: readonly string[];
}

export function validateReviewFinding(value: unknown): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return ["finding must be an object"];
	const finding = value as Record<string, unknown>;
	const errors: string[] = [];
	if (typeof finding.id !== "string" || finding.id.trim().length === 0)
		errors.push("finding id is required");
	if (typeof finding.actual !== "string" || finding.actual.trim().length === 0)
		errors.push("finding actual (what the code does) is required");
	if (
		finding.line !== undefined &&
		(!Number.isInteger(finding.line) || (finding.line as number) < 1)
	)
		errors.push("finding line must be a positive integer");
	if (
		finding.evidence !== undefined &&
		(!Array.isArray(finding.evidence) ||
			!finding.evidence.every(
				(item) => typeof item === "string" && item.trim().length > 0,
			))
	)
		errors.push("finding evidence must be an array of non-empty strings");
	return errors;
}

export interface FindingsPayload {
	/** Empty array = clean review (a real result, not an omission). */
	readonly findings: readonly ReviewFinding[];
	/** What was actually examined — scope honesty, feeds the verifier. */
	readonly scope: {
		readonly reviewed: string;
		readonly notReviewed?: readonly string[];
	};
	/** Short prose wrap-up; the long form lives in `raw`. */
	readonly summary: string;
}

// ─── report (explorer) ───────────────────────────────────────────────────────

export type EvidenceRef =
	| {
			readonly kind: "file";
			readonly path: string;
			readonly line?: number;
			readonly note?: string;
	  }
	| {
			readonly kind: "url";
			readonly url: string;
			readonly title?: string;
			readonly accessed?: string;
	  }
	| {
			readonly kind: "command";
			readonly command: string;
			readonly observation: string;
	  };

export interface ReportPayload {
	/** The dense self-sufficient answer (v1's Digest). ≤ 600 chars. */
	readonly answer: string;
	/** Load-bearing facts, each independently checkable. */
	readonly facts: readonly {
		readonly text: string;
		readonly evidence: readonly EvidenceRef[];
	}[];
	/** What could not be determined — explicit, may be empty. */
	readonly unknowns: readonly string[];
	readonly confidence: "high" | "medium" | "low";
}

// ─── verdict (callers + verify duties) ───────────────────────────────────────

export interface VerdictPayload {
	readonly verdict: "pass" | "block";
	/** One sentence, always — a bare verdict is not reviewable. */
	readonly reason: string;
	/** Verify duties: one entry per claim/finding/task, scope-locked. */
	readonly checks?: readonly {
		readonly ref: string;
		readonly state: "verified" | "still-open" | "not-checkable";
		readonly evidence?: string;
	}[];
}

/**
 * When checks are present the verdict is recomputed: block iff any check is
 * still-open. The recomputation wins; a mismatch is a diagnostic, not a
 * negotiation. "not-checkable" does not block but is surfaced.
 */
export function verdictFromChecks(
	payload: VerdictPayload,
): "pass" | "block" | null {
	if (!payload.checks || payload.checks.length === 0) return null;
	return payload.checks.some((check) => check.state === "still-open")
		? "block"
		: "pass";
}

// ─── plan-gate-report (plan→auto gate) ───────────────────────────────────────

export const PLAN_GATE_FINDING_KINDS = [
	"ambiguity", // double readings, vague verbs, unstated targets
	"delegation", // fan-out wanted but not stated (or vice versa)
	"dependency", // after/children don't match what tasks assume
	"branch-ownership", // branch facts don't match the shipping story
	"envelope", // fan-out/depth implied beyond caps
	"advisory-nudge", // e.g. branch-owning node without shipping-conventions
] as const;
export type PlanGateFindingKind = (typeof PLAN_GATE_FINDING_KINDS)[number];

export interface PlanGateFinding {
	readonly id: string;
	readonly severity: "blocking" | "advisory";
	/** Plan location: node id, and task index within it when task-scoped. */
	readonly node?: string;
	readonly task?: number;
	readonly kind: PlanGateFindingKind;
	/** The two-readings statement / what is unclear, concretely. */
	readonly problem: string;
	/** Concrete replacement text. Required for blocking findings. */
	readonly rewrite?: string;
}

export interface PlanGateReportPayload {
	readonly verdict: "proceed" | "revise"; // recomputed; kept for salvage/readability
	readonly findings: readonly PlanGateFinding[];
	/** ≤ 200 words; whole-report cap enforced on `raw`. */
	readonly summary: string;
}

/** Recomputed verdict: revise iff any blocking finding. Recomputation wins. */
export function planGateVerdict(
	payload: PlanGateReportPayload,
): "proceed" | "revise" {
	return payload.findings.some((finding) => finding.severity === "blocking")
		? "revise"
		: "proceed";
}

// ─── Fence extraction ────────────────────────────────────────────────────────

export const CONTRACT_FENCE_TAG = "pi-contract";

/**
 * Extract the LAST ```pi-contract fence from the text (the final assistant
 * message). A dedicated tag means illustrative ```json blocks in the prose
 * can never shadow the envelope. Returns null when no fence exists.
 */
export function extractContractBlock(text: string): string | null {
	const fences = [...text.matchAll(/```pi-contract\s*\n([\s\S]*?)```/g)];
	return fences.at(-1)?.[1]?.trim() ?? null;
}

export interface ParsedEnvelope {
	readonly envelope: ContractEnvelope | null;
	/** Empty = structurally valid (payload validation is separate). */
	readonly errors: readonly string[];
}

/** Parse + structurally validate the envelope from a final message. */
export function parseContractEnvelope(text: string): ParsedEnvelope {
	const block = extractContractBlock(text);
	if (block === null)
		return { envelope: null, errors: ["no ```pi-contract block found"] };
	let value: unknown;
	try {
		value = JSON.parse(block);
	} catch (cause) {
		return {
			envelope: null,
			errors: [
				`pi-contract block is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
			],
		};
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { envelope: null, errors: ["envelope must be a JSON object"] };
	const env = value as Record<string, unknown>;
	const errors: string[] = [];
	if (!CONTRACT_IDS.includes(env.contract as ContractId))
		errors.push(
			`contract must be one of ${CONTRACT_IDS.join(", ")} (got ${JSON.stringify(env.contract)})`,
		);
	if (!Number.isInteger(env.v) || (env.v as number) < 1)
		errors.push("v must be a positive integer");
	if (env.status !== "complete" && env.status !== "partial")
		errors.push('status must be "complete" or "partial"');
	if (
		typeof env.payload !== "object" ||
		env.payload === null ||
		Array.isArray(env.payload)
	)
		errors.push("payload must be an object");
	if (errors.length > 0) return { envelope: null, errors };
	return { envelope: env as unknown as ContractEnvelope, errors: [] };
}

// ─── Contract definitions (registry) ─────────────────────────────────────────

export interface ContractDefinition<P = unknown> {
	readonly id: ContractId;
	readonly latest: number;
	/** Rendered into agent-type prompts and retry steers. Single source of truth. */
	readonly instruction: string;
	/** Hard caps — ENFORCED by validators (v1 declared, never checked). */
	readonly bounds?: {
		readonly maxRawWords?: number;
		readonly maxSummaryChars?: number;
	};
	/** validate(payload, v): error strings; [] = valid. */
	readonly validate: (value: unknown, v: number) => string[];
	/** Free-text salvage (tier 3): the v1 tolerant parsers. Null = unsalvageable. */
	readonly salvage: (raw: string) => P | null;
	/** Migration chain: migrations[i] upgrades v=i+1 → v=i+2. */
	readonly migrations: ReadonlyArray<(payload: unknown) => unknown>;
}

/** Upgrade a persisted payload to the latest shape, in memory (never on disk). */
export function upgradeContractPayload(
	definition: ContractDefinition,
	payload: unknown,
	fromV: number,
): unknown {
	if (fromV > definition.latest)
		throw new Error(
			`${definition.id} v${fromV} is newer than latest v${definition.latest}`,
		);
	let upgraded = payload;
	for (let v = fromV; v < definition.latest; v++) {
		const migrate = definition.migrations[v - 1];
		if (!migrate)
			throw new Error(`${definition.id} has no migration from v${v}`);
		upgraded = migrate(upgraded);
	}
	return upgraded;
}

export function countWords(text: string): number {
	return text.split(/\s+/).filter((word) => word.length > 0).length;
}

// ── validators (hand-rolled, contracts-package style) ──

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function validateSummaryAndDiffPayload(value: unknown): string[] {
	if (!isRecord(value)) return ["payload must be an object"];
	const errors: string[] = [];
	if (!nonEmptyString(value.summary)) errors.push("summary is required");
	if (!["done", "partial", "blocked"].includes(value.outcome as string))
		errors.push("outcome must be done|partial|blocked");
	if (!Array.isArray(value.tasks)) errors.push("tasks must be an array");
	else
		value.tasks.forEach((task, i) => {
			if (!isRecord(task)) {
				errors.push(`tasks[${i}] must be an object`);
				return;
			}
			if (!nonEmptyString(task.id)) errors.push(`tasks[${i}].id is required`);
			if (!["done", "partial", "not-done"].includes(task.state as string))
				errors.push(`tasks[${i}].state must be done|partial|not-done`);
			else if (task.state !== "done" && !nonEmptyString(task.note))
				errors.push(`tasks[${i}].note is required when state is ${task.state}`);
		});
	if (value.validation !== undefined) {
		if (!Array.isArray(value.validation))
			errors.push("validation must be an array");
		else
			value.validation.forEach((entry, i) => {
				if (!isRecord(entry) || !nonEmptyString(entry.command))
					errors.push(`validation[${i}].command is required`);
				else if (!["pass", "fail", "not-run"].includes(entry.result as string))
					errors.push(`validation[${i}].result must be pass|fail|not-run`);
			});
	}
	if (value.outcome === "blocked" && !nonEmptyString(value.blockedReason))
		errors.push("blockedReason is required when outcome is blocked");
	return errors;
}

export function validateFindingsPayload(value: unknown): string[] {
	if (!isRecord(value)) return ["payload must be an object"];
	const errors: string[] = [];
	if (!Array.isArray(value.findings)) errors.push("findings must be an array");
	else
		value.findings.forEach((finding, i) => {
			for (const err of validateReviewFinding(finding))
				errors.push(`findings[${i}]: ${err}`);
			// Ratings are rejected, not ignored: a reviewer that writes severity
			// is trying to pre-judge the consumer's interpretation.
			if (isRecord(finding) && finding.severity !== undefined)
				errors.push(
					`findings[${i}]: severity is not a reviewer's call — report what the code does; the consumer judges`,
				);
		});
	if (!isRecord(value.scope) || !nonEmptyString(value.scope.reviewed))
		errors.push("scope.reviewed is required");
	if (!nonEmptyString(value.summary)) errors.push("summary is required");
	return errors;
}

const EVIDENCE_KINDS = ["file", "url", "command"] as const;

export function validateReportPayload(value: unknown): string[] {
	if (!isRecord(value)) return ["payload must be an object"];
	const errors: string[] = [];
	if (!nonEmptyString(value.answer)) errors.push("answer is required");
	else if (value.answer.length > 600)
		errors.push(`answer must be ≤ 600 chars (got ${value.answer.length})`);
	if (!Array.isArray(value.facts)) errors.push("facts must be an array");
	else
		value.facts.forEach((fact, i) => {
			if (!isRecord(fact) || !nonEmptyString(fact.text)) {
				errors.push(`facts[${i}].text is required`);
				return;
			}
			if (!Array.isArray(fact.evidence) || fact.evidence.length === 0)
				errors.push(`facts[${i}].evidence must be a non-empty array`);
			else
				fact.evidence.forEach((ref, j) => {
					if (
						!isRecord(ref) ||
						!EVIDENCE_KINDS.includes(
							ref.kind as (typeof EVIDENCE_KINDS)[number],
						)
					)
						errors.push(
							`facts[${i}].evidence[${j}].kind must be file|url|command`,
						);
				});
		});
	if (!Array.isArray(value.unknowns)) errors.push("unknowns must be an array");
	if (!["high", "medium", "low"].includes(value.confidence as string))
		errors.push("confidence must be high|medium|low");
	return errors;
}

export function validateVerdictPayload(value: unknown): string[] {
	if (!isRecord(value)) return ["payload must be an object"];
	const errors: string[] = [];
	if (!["pass", "block"].includes(value.verdict as string))
		errors.push("verdict must be pass|block");
	if (!nonEmptyString(value.reason)) errors.push("reason is required");
	if (value.checks !== undefined) {
		if (!Array.isArray(value.checks)) errors.push("checks must be an array");
		else
			value.checks.forEach((check, i) => {
				if (!isRecord(check) || !nonEmptyString(check.ref))
					errors.push(`checks[${i}].ref is required`);
				else if (
					!["verified", "still-open", "not-checkable"].includes(
						check.state as string,
					)
				)
					errors.push(
						`checks[${i}].state must be verified|still-open|not-checkable`,
					);
			});
	}
	return errors;
}

export function validatePlanGateReportPayload(value: unknown): string[] {
	if (!isRecord(value)) return ["payload must be an object"];
	const errors: string[] = [];
	if (!["proceed", "revise"].includes(value.verdict as string))
		errors.push("verdict must be proceed|revise");
	if (!Array.isArray(value.findings)) errors.push("findings must be an array");
	else
		value.findings.forEach((finding, i) => {
			if (!isRecord(finding)) {
				errors.push(`findings[${i}] must be an object`);
				return;
			}
			if (!nonEmptyString(finding.id))
				errors.push(`findings[${i}].id is required`);
			if (!["blocking", "advisory"].includes(finding.severity as string))
				errors.push(`findings[${i}].severity must be blocking|advisory`);
			if (
				!PLAN_GATE_FINDING_KINDS.includes(finding.kind as PlanGateFindingKind)
			)
				errors.push(
					`findings[${i}].kind must be one of ${PLAN_GATE_FINDING_KINDS.join(", ")}`,
				);
			if (!nonEmptyString(finding.problem))
				errors.push(`findings[${i}].problem is required`);
			if (finding.severity === "blocking" && !nonEmptyString(finding.rewrite))
				errors.push(`findings[${i}].rewrite is required for blocking findings`);
		});
	if (!nonEmptyString(value.summary)) errors.push("summary is required");
	else if (countWords(value.summary) > 200)
		errors.push(
			`summary must be ≤ 200 words (got ${countWords(value.summary)})`,
		);
	return errors;
}

// ── salvage tiers (the v1 tolerant parsers, mapped to latest shapes) ──

function salvageSummaryAndDiff(raw: string): SummaryAndDiffPayload | null {
	const summary = raw.trim();
	if (!summary) return null;
	return { summary, outcome: "partial", tasks: [] };
}

function salvageFindings(raw: string): FindingsPayload | null {
	const structured = parseStructuredFindings(raw);
	const verdict = parseVerdict(raw);
	// A clean approve salvages to an empty findings list; pure silence does not
	// (a reviewer that said nothing recognizable must not read as "clean").
	if (structured.length === 0 && verdict.verdict !== "approve") return null;
	// Legacy output carries severity/category ratings — STRIP them: findings
	// are neutral observations; interpretation belongs to the consumer.
	const findings: ReviewFinding[] = structured.map((finding) => ({
		id: finding.id,
		actual: finding.actual,
		...(finding.file ? { file: finding.file } : {}),
		...(finding.line ? { line: finding.line } : {}),
		...(finding.claim ? { claim: finding.claim } : {}),
		...(finding.evidence ? { evidence: finding.evidence } : {}),
	}));
	return {
		findings,
		scope: { reviewed: "unknown (salvaged from free text)" },
		summary: raw.split("\n").find((line) => line.trim().length > 0) ?? "",
	};
}

function salvageReport(raw: string): ReportPayload | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	// v1 research-digest: a `## Digest` section is the dense answer.
	const digest = trimmed.match(/##\s*Digest\s*\n([\s\S]*?)(\n##\s|\n*$)/);
	const answer = (digest?.[1] ?? trimmed).trim().slice(0, 600);
	if (!answer) return null;
	return { answer, facts: [], unknowns: [], confidence: "low" };
}

function salvageVerdict(raw: string): VerdictPayload | null {
	const parsed = parseVerdict(raw);
	if (parsed.verdict === "none") return null; // unsalvageable → escalate
	return {
		verdict: parsed.verdict === "approve" ? "pass" : "block",
		reason:
			parsed.findings.join("; ") ||
			"salvaged from a VERDICT: line without structured reasons",
	};
}

function salvagePlanGateReport(raw: string): PlanGateReportPayload | null {
	const parsed = parseVerdict(raw);
	if (parsed.verdict === "none") return null; // gate stays closed
	return {
		verdict: parsed.verdict === "approve" ? "proceed" : "revise",
		findings: parsed.findings.map((bullet, index) => ({
			id: `P${index + 1}`,
			severity: "blocking" as const,
			kind: "ambiguity" as const,
			problem: bullet,
			rewrite: bullet,
		})),
		summary:
			raw
				.split("\n")
				.find((line) => line.trim().length > 0)
				?.slice(0, 500) ?? "salvaged",
	};
}

// ── the registry ──

export const CONTRACT_DEFINITIONS: {
	readonly [Id in ContractId]: ContractDefinition;
} = {
	"summary-and-diff": {
		id: "summary-and-diff",
		latest: 1,
		instruction:
			"End your final message with a ```pi-contract fenced JSON block: " +
			'{ "contract": "summary-and-diff", "v": 1, "status": "complete", ' +
			'"payload": { summary, outcome: done|partial|blocked, tasks: ' +
			"[{ id, state: done|partial|not-done, note? }], validation?: " +
			"[{ command, result: pass|fail|not-run }], followUps?, blockedReason? } }. " +
			"Do not describe your diff — the harness reads it from git.",
		validate: (value) => validateSummaryAndDiffPayload(value),
		salvage: salvageSummaryAndDiff,
		migrations: [],
	},
	findings: {
		id: "findings",
		latest: 1,
		bounds: { maxSummaryChars: 1200 },
		instruction:
			"End your final message with a ```pi-contract fenced JSON block: " +
			'{ "contract": "findings", "v": 1, "status": "complete", "payload": ' +
			"{ findings: [{ id, actual (what the code does), consequence?, " +
			"file?, line?, claim?, evidence? }], scope: { reviewed, notReviewed? }, " +
			"summary } }. An empty findings array means a clean review. Do NOT " +
			"rate severity, categorize, or write verdict language — report what " +
			"the code does with evidence; interpretation belongs to the consumer.",
		validate: (value) => validateFindingsPayload(value),
		salvage: salvageFindings,
		migrations: [],
	},
	report: {
		id: "report",
		latest: 1,
		bounds: { maxRawWords: 1500 },
		instruction:
			"End your final message with a ```pi-contract fenced JSON block: " +
			'{ "contract": "report", "v": 1, "status": "complete", "payload": ' +
			"{ answer (≤600 chars, dense and self-sufficient), facts: [{ text, " +
			"evidence: [{ kind: file|url|command, ... }] }], unknowns: [...], " +
			"confidence: high|medium|low } }.",
		validate: (value) => validateReportPayload(value),
		salvage: salvageReport,
		migrations: [],
	},
	verdict: {
		id: "verdict",
		latest: 1,
		instruction:
			"End your final message with a ```pi-contract fenced JSON block: " +
			'{ "contract": "verdict", "v": 1, "status": "complete", "payload": ' +
			"{ verdict: pass|block, reason (one sentence), checks?: [{ ref, " +
			"state: verified|still-open|not-checkable, evidence? }] }. With " +
			"checks present, verdict must be block iff any check is still-open.",
		validate: (value) => validateVerdictPayload(value),
		salvage: salvageVerdict,
		migrations: [],
	},
	"plan-gate-report": {
		id: "plan-gate-report",
		latest: 1,
		bounds: { maxRawWords: 700 },
		instruction:
			"End your final message with a ```pi-contract fenced JSON block: " +
			'{ "contract": "plan-gate-report", "v": 1, "status": "complete", ' +
			'"payload": { verdict: proceed|revise, findings: [{ id, severity: ' +
			"blocking|advisory, node?, task?, kind: ambiguity|delegation|" +
			"dependency|branch-ownership|envelope|advisory-nudge, problem, " +
			"rewrite (required when blocking) }], summary (≤200 words) } }. " +
			"Every blocking finding must carry a concrete rewrite.",
		validate: (value) => validatePlanGateReportPayload(value),
		salvage: salvagePlanGateReport,
		migrations: [],
	},
};

/**
 * Validate a structurally-parsed envelope against its contract definition:
 * version known, payload valid for that version, bounds respected on raw.
 */
export function validateContractEnvelope(
	envelope: ContractEnvelope,
	raw: string,
): string[] {
	const definition = CONTRACT_DEFINITIONS[envelope.contract];
	const errors: string[] = [];
	if (envelope.v > definition.latest)
		errors.push(
			`${envelope.contract} v${envelope.v} is newer than this harness supports (v${definition.latest})`,
		);
	errors.push(...definition.validate(envelope.payload, envelope.v));
	const bounds = definition.bounds;
	if (bounds?.maxRawWords !== undefined) {
		const words = countWords(raw);
		if (words > bounds.maxRawWords)
			errors.push(
				`final message must be ≤ ${bounds.maxRawWords} words (got ${words})`,
			);
	}
	if (bounds?.maxSummaryChars !== undefined) {
		const summary = (envelope.payload as { summary?: unknown }).summary;
		if (typeof summary === "string" && summary.length > bounds.maxSummaryChars)
			errors.push(
				`payload.summary must be ≤ ${bounds.maxSummaryChars} chars (got ${summary.length})`,
			);
	}
	return errors;
}

/**
 * Build the corrective steer for a failed extraction attempt — generated
 * from the validator errors, specific and short.
 */
export function contractRetrySteer(
	contract: ContractId,
	errors: readonly string[],
): string {
	const definition = CONTRACT_DEFINITIONS[contract];
	return (
		`Your final message must end with a \`\`\`pi-contract block for ` +
		`contract ${contract} v${definition.latest}. Problems: ${errors.join("; ")}. ` +
		"Re-emit only the corrected block."
	);
}
