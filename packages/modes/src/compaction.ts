import { createHash } from "node:crypto";
import type {
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { ModeName } from "@vegardx/pi-contracts";
import {
	isMaestroOwnedCompaction,
	MAESTRO_COMPACTION_MARKER,
} from "@vegardx/pi-contracts";
import { redactSecrets } from "@vegardx/pi-core";
import {
	type Deliverable,
	deliverables,
	effectiveDependsOn,
	type Plan,
	TERMINAL_STATUSES,
} from "./schema.js";

/** AgentMessage alias; `convertToLlm` consumes this shape (see summarise.ts). */
type AgentMessage = SessionMessageEntry["message"];

// ---------------------------------------------------------------------------
// Cooperative compaction ownership.
// ---------------------------------------------------------------------------
//
// modes and smart-compact both register `session_before_compact`. They
// cooperate through the shared marker in `@vegardx/pi-contracts`: a
// modes-triggered compaction sets `ctx.compact({ customInstructions: marker })`
// so smart-compact declines (returns undefined), and modes' handler — loaded
// AFTER smart-compact, so it has final say — produces the deliverable-slice
// summary. Manual `/compact` and pi-native threshold/overflow compactions
// carry no marker; modes returns undefined and the generic path handles them.
//
// This module is intentionally pure: rendering, tree introspection, and a
// builder that takes an injected `summarise` callback. The LLM client wiring
// lives in summarise.ts; the event handler lives in runtime.ts.

/** Schema version stamped on every modes compaction's details. */
export const COMPACTION_SCHEMA_VERSION = 1;

/** Bucket snapshot recorded on a modes compaction for diagnostics. */
export interface CompactionBucketSnapshot {
	readonly sys: number;
	readonly seed: number;
	readonly rollingSummary: number;
	readonly hotTail: number;
	readonly workingUsed: number;
	readonly summaryUsed: number;
}

/**
 * JSON-serializable details persisted on a modes `CompactionEntry`. Used for
 * diagnostics and invariants only — the summary TEXT is the cache-stable
 * prompt prefix; details never feed back into the prompt.
 */
export interface ModesCompactionDetails {
	readonly schemaVersion: number;
	readonly modesKind: "deliverable-slice";
	readonly planSlug: string;
	readonly deliverableId: string;
	/** 1-indexed slice number for this deliverable on the current branch. */
	readonly sliceNumber: number;
	/** Nonce that scoped this compaction's ownership marker. */
	readonly nonce: string;
	/** What triggered it: manual | threshold | overflow | modes-trigger. */
	readonly reason: string;
	readonly buckets?: CompactionBucketSnapshot;
	/** Length of the previous (frozen) summary prefix in characters. */
	readonly previousSummaryLength: number;
	/** SHA-256 hex prefix of the previous summary, for prefix-invariant checks. */
	readonly previousSummaryHash: string;
}

/** Read modes details off an entry, or undefined when it isn't a modes slice. */
export function readModesCompactionDetails(
	entry: SessionEntry,
): ModesCompactionDetails | undefined {
	if (entry.type !== "compaction") return undefined;
	const details = (entry as { details?: unknown }).details;
	if (!details || typeof details !== "object") return undefined;
	const d = details as Partial<ModesCompactionDetails>;
	if (d.modesKind !== "deliverable-slice") return undefined;
	if (typeof d.deliverableId !== "string") return undefined;
	return d as ModesCompactionDetails;
}

// ---------------------------------------------------------------------------
// Pending-kind ownership protocol.
// ---------------------------------------------------------------------------
//
// modes records what it is about to compact in `PendingModesCompaction`,
// then triggers `ctx.compact({ customInstructions: buildCompactionMarker(nonce) })`.
// The `session_before_compact` handler matches the incoming marker against the
// pending nonce to decide ownership. The nonce makes the match exact-once and
// guards against a stale marker leaking into pi's default prompt.

export interface PendingModesCompaction {
	readonly nonce: string;
	readonly deliverableId: string;
	readonly reason: string;
	readonly buckets?: CompactionBucketSnapshot;
}

/** The exact `customInstructions` value modes sets to claim a compaction. */
export function buildCompactionMarker(nonce: string): string {
	return `${MAESTRO_COMPACTION_MARKER} ${nonce}`;
}

export type CompactionDecision =
	| { readonly kind: "decline" }
	| { readonly kind: "own"; readonly pending: PendingModesCompaction }
	| { readonly kind: "leak-guard" };

/**
 * Decide how the modes handler should respond to a `session_before_compact`.
 *
 *   - no marker            → decline (return undefined; generic path wins)
 *   - marker matches pending → own (build the deliverable-slice summary)
 *   - marker but no/other pending → leak-guard (cancel; never let the marker
 *     fall through into pi's default "Additional focus" prompt)
 */
export function decideCompactionOwnership(
	customInstructions: string | undefined,
	pending: PendingModesCompaction | undefined,
): CompactionDecision {
	if (!isMaestroOwnedCompaction(customInstructions)) return { kind: "decline" };
	if (pending && customInstructions === buildCompactionMarker(pending.nonce)) {
		return { kind: "own", pending };
	}
	return { kind: "leak-guard" };
}

/** Short, stable SHA-256 hex prefix of `text` (12 chars). */
export function summaryHash(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Dependency-aware preamble inputs — pure tree walks.
// ---------------------------------------------------------------------------

/** Transitive dependency ancestors of `id` (deepest-first dedup, no cycles). */
export function transitiveDependencies(
	plan: Pick<Plan, "nodes">,
	id: string,
): Deliverable[] {
	const byId = new Map(deliverables(plan).map((d) => [d.id, d]));
	const seen = new Set<string>();
	const out: Deliverable[] = [];
	const visit = (current: string) => {
		for (const depId of effectiveDependsOn(plan, {
			id: current,
			dependsOn: byId.get(current)?.dependsOn,
		})) {
			if (seen.has(depId)) continue;
			seen.add(depId);
			const dep = byId.get(depId);
			if (dep) {
				out.push(dep);
				visit(depId);
			}
		}
	};
	visit(id);
	return out;
}

/**
 * Non-terminal deliverables that depend (directly or transitively) on `id`.
 * These are the future readers the summary should retain detail for.
 */
export function downstreamDependents(
	plan: Pick<Plan, "nodes">,
	id: string,
): Deliverable[] {
	const all = deliverables(plan);
	const dependents = new Set<string>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const d of all) {
			if (d.id === id || dependents.has(d.id)) continue;
			const deps = effectiveDependsOn(plan, d);
			if (deps.some((dep) => dep === id || dependents.has(dep))) {
				dependents.add(d.id);
				grew = true;
			}
		}
	}
	return all.filter(
		(d) => dependents.has(d.id) && !TERMINAL_STATUSES.includes(d.status),
	);
}

// ---------------------------------------------------------------------------
// Summariser contract + preamble.
// ---------------------------------------------------------------------------

export interface SummariseOutput {
	readonly text: string;
}

export type SummariseFn = (args: {
	messages: AgentMessage[];
	preamble: string;
	maxTokens: number;
	signal?: AbortSignal;
}) => Promise<SummariseOutput | null>;

/**
 * Build the summariser preamble for a mid-deliverable slice. Names the active
 * deliverable, its dependency chain (already-shipped context it builds on),
 * and the non-terminal dependents whose needs the limited output must serve.
 */
export function buildSummariserPreamble(args: {
	plan: Plan;
	deliverable: Deliverable;
	maxTokens: number;
	partN: number;
}): string {
	const { plan, deliverable, maxTokens, partN } = args;
	const deps = transitiveDependencies(plan, deliverable.id);
	const dependents = downstreamDependents(plan, deliverable.id);

	const lines: string[] = [
		"You are summarising work on a software project so the active deliverable",
		"can continue without re-reading the full conversation.",
		"",
		`Active deliverable \`${deliverable.id}\` — ${deliverable.title}`,
		`Goal: ${deliverable.body}`,
		"",
		"This deliverable is NOT done — context grew large enough to trigger a",
		"mid-deliverable compaction. Summarise the work-so-far accurately; work",
		"continues after this slice. Do NOT claim the deliverable is finished.",
	];
	if (partN > 1) {
		lines.push(
			"",
			`This is **part ${partN}**. Earlier parts are already captured verbatim`,
			"in the rolling summary above — focus on what THIS slice adds; do not",
			"restate work covered by previous parts.",
		);
	}
	if (deps.length > 0) {
		lines.push("", "Builds on these completed dependencies:");
		for (const d of deps) lines.push(`  - \`${d.id}\` — ${d.title}`);
	}
	if (dependents.length > 0) {
		lines.push(
			"",
			"Downstream deliverables depend on this one — information bearing on",
			"them MUST be retained verbatim (file paths, identifiers, schema",
			"fragments, decisions, error messages):",
		);
		for (const d of dependents)
			lines.push(`  - \`${d.id}\` — ${d.title}: ${d.body}`);
	}
	lines.push(
		"",
		"Write a structured summary covering:",
		"  ## Done",
		"  - what was completed (concise bullets)",
		"  ## Key decisions",
		"  - decisions and their rationale",
		"  ## Carry-forward context",
		"  - file paths, function names, schema fragments, identifiers, and",
		"    error messages relevant to the remaining work",
		"",
		`Stay within ~${maxTokens} output tokens — a MAXIMUM, not a quota. If the`,
		"slice contains little of value, return a short summary. Do not pad.",
	);
	return lines.join("\n");
}

/** Locked title format for a mid-deliverable slice section. */
export function renderDeliverableSection(args: {
	deliverable: Deliverable;
	body: string;
	partN: number;
}): string {
	const { deliverable, body, partN } = args;
	return `## Deliverable \`${deliverable.id}\` — ${deliverable.title} (part ${partN}, in progress)\n\n${body}`;
}

/**
 * Append-only concatenation. The whole point of the scheme: previous summary
 * text is reused byte-for-byte, never regenerated.
 */
export function buildSummary(prevSummary: string, newSection: string): string {
	if (!prevSummary) return newSection;
	return `${prevSummary}\n\n${newSection}`;
}

// ---------------------------------------------------------------------------
// Tree introspection — read-only walks of the session entries.
// ---------------------------------------------------------------------------

/** Latest compaction summary on the entries, or "". */
export function findLatestCompactionSummary(entries: SessionEntry[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "compaction")
			return (e as { summary?: string }).summary ?? "";
	}
	return "";
}

/** Count modes deliverable-slice compactions for a deliverable on the branch. */
export function countDeliverableSlicesOnBranch(
	entries: SessionEntry[],
	planSlug: string,
	deliverableId: string,
): number {
	let n = 0;
	for (const e of entries) {
		const d = readModesCompactionDetails(e);
		if (d && d.planSlug === planSlug && d.deliverableId === deliverableId) n++;
	}
	return n;
}

// ---------------------------------------------------------------------------
// Deliverable-slice builder for `session_before_compact`.
// ---------------------------------------------------------------------------
//
// pi's `preparation` supplies everything needed to stay append-only and
// cut-point aligned:
//   - messagesToSummarize / turnPrefixMessages: the RAW slice pi will drop,
//     spanning from the previous kept boundary to the new cut point. These
//     exclude compaction entries, so the summariser never re-summarises a
//     prior summary.
//   - previousSummary: the latest compaction summary, reused byte-for-byte as
//     the prefix so the prompt prefix stays cache-stable across slices.
//   - firstKeptEntryId / tokensBefore: passed back verbatim; pi computed them.

export interface BuildDeliverableSliceOptions {
	readonly entries: SessionEntry[];
	readonly plan: Plan;
	readonly deliverableId: string;
	readonly summarise: SummariseFn;
	/** RAW messages pi will drop (preparation.messagesToSummarize + turnPrefix). */
	readonly rawMessages: AgentMessage[];
	/** preparation.previousSummary — the frozen prefix, reused byte-for-byte. */
	readonly previousSummary?: string;
	/** preparation.firstKeptEntryId. */
	readonly firstKeptEntryId: string;
	/** preparation.tokensBefore. */
	readonly tokensBefore: number;
	/** Output token cap for the summariser. */
	readonly maxTokens: number;
	readonly nonce: string;
	readonly reason: string;
	readonly buckets?: CompactionBucketSnapshot;
	readonly signal?: AbortSignal;
}

export interface DeliverableSliceResult {
	readonly summary: string;
	readonly firstKeptEntryId: string;
	readonly tokensBefore: number;
	readonly details: ModesCompactionDetails;
}

/**
 * Pure builder for a mid-deliverable (slice) compaction. Returns the payload
 * pi expects from `session_before_compact`, or null when the summariser fails
 * (the caller then cancels the modes-triggered compaction).
 *
 * Throws if `deliverableId` is not in the plan (a wiring bug).
 */
export async function buildDeliverableSliceCompactionResult(
	opts: BuildDeliverableSliceOptions,
): Promise<DeliverableSliceResult | null> {
	const deliverable = deliverables(opts.plan).find(
		(d) => d.id === opts.deliverableId,
	);
	if (!deliverable) {
		throw new Error(
			`buildDeliverableSliceCompactionResult: deliverable ${opts.deliverableId} not found in plan ${opts.plan.slug}`,
		);
	}

	const partN =
		countDeliverableSlicesOnBranch(
			opts.entries,
			opts.plan.slug,
			opts.deliverableId,
		) + 1;

	let body = "(no recorded work)";
	if (opts.rawMessages.length > 0) {
		const preamble = buildSummariserPreamble({
			plan: opts.plan,
			deliverable,
			maxTokens: opts.maxTokens,
			partN,
		});
		const out = await opts.summarise({
			messages: opts.rawMessages,
			preamble,
			maxTokens: opts.maxTokens,
			signal: opts.signal,
		});
		if (out === null) return null;
		body = out.text.trim() || body;
	}

	const prev = opts.previousSummary ?? "";
	const section = redactSecrets(
		renderDeliverableSection({ deliverable, body, partN }),
	);
	const summary = buildSummary(prev, section);

	return {
		summary,
		firstKeptEntryId: opts.firstKeptEntryId,
		tokensBefore: opts.tokensBefore,
		details: {
			schemaVersion: COMPACTION_SCHEMA_VERSION,
			modesKind: "deliverable-slice",
			planSlug: opts.plan.slug,
			deliverableId: opts.deliverableId,
			sliceNumber: partN,
			nonce: opts.nonce,
			reason: opts.reason,
			buckets: opts.buckets,
			previousSummaryLength: prev.length,
			previousSummaryHash: summaryHash(prev),
		},
	};
}

// ---------------------------------------------------------------------------
// Crash snapshot — unchanged from the lifecycle phase.
// ---------------------------------------------------------------------------

export interface CrashSnapshotInput {
	readonly error: unknown;
	readonly mode: ModeName;
	readonly plan?: Plan;
	readonly activeDeliverableId?: string;
	readonly cwd?: string;
}

export interface CrashSnapshot {
	readonly at: string;
	readonly mode: ModeName;
	readonly cwd?: string;
	readonly planSlug?: string;
	readonly activeDeliverableId?: string;
	readonly error: string;
	readonly stack?: string;
}

export function createCrashSnapshot(
	input: CrashSnapshotInput,
	now: () => string = () => new Date().toISOString(),
): CrashSnapshot {
	const error =
		input.error instanceof Error ? input.error : new Error(String(input.error));
	return {
		at: now(),
		mode: input.mode,
		cwd: redact(input.cwd),
		planSlug: input.plan?.slug,
		activeDeliverableId: input.activeDeliverableId,
		error: redact(error.message) ?? "",
		stack: redact(error.stack),
	};
}

function redact(value: string | undefined): string | undefined {
	return value
		?.replace(/[A-Za-z0-9_=-]{32,}/g, "[redacted]")
		.replace(/(token|api[_-]?key|secret)=\S+/gi, "$1=[redacted]");
}
