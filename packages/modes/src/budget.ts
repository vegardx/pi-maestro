// Pure context-budget accounting for modes execution. Deterministic and
// side-effect free so it can be unit-tested and so footer/telemetry rendering
// never mutates prompt content.
//
// Buckets per turn:
//   sys           = system prompt + active tool schema text
//   seed          = the byte-stable plan-seed custom message PLUS any
//                   dependency carry-forward summaries injected as custom
//                   messages (the SAME entries that are actually injected)
//   rollingSummary = latest modes compaction summary on the active branch
//   hotTail       = total - sys - seed - rollingSummary (when total is known)
//   workingUsed   = sys + hotTail        (drives the mid-deliverable trigger)
//   summaryUsed   = seed + rollingSummary (stable summary burden)
//
// The trigger must read `workingUsed`, never raw total, so stable summary/seed
// growth never self-triggers compaction.

/** Token estimate for arbitrary text. Matches pi's ~chars/4 heuristic. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export interface BucketInput {
	/** Authoritative total context tokens, or null when unknown. */
	readonly total: number | null;
	readonly sys: number;
	readonly seed: number;
	readonly rollingSummary: number;
}

export interface ContextBuckets {
	readonly total: number | null;
	readonly sys: number;
	readonly seed: number;
	readonly rollingSummary: number;
	readonly hotTail: number;
	readonly workingUsed: number;
	readonly summaryUsed: number;
}

/**
 * Compute the bucket breakdown. When `total` is null (e.g. right after
 * compaction, before the next LLM usage sample), `hotTail` is reported as 0 so
 * the trigger never fires on stale data; stable buckets are still reported.
 */
export function computeBuckets(input: BucketInput): ContextBuckets {
	const sys = Math.max(0, input.sys);
	const seed = Math.max(0, input.seed);
	const rollingSummary = Math.max(0, input.rollingSummary);
	const hotTail =
		input.total === null
			? 0
			: Math.max(0, input.total - sys - seed - rollingSummary);
	return {
		total: input.total,
		sys,
		seed,
		rollingSummary,
		hotTail,
		workingUsed: sys + hotTail,
		summaryUsed: seed + rollingSummary,
	};
}

export interface CalibrationInput {
	/** Authoritative total context tokens from a usage sample. */
	readonly total: number;
	readonly seed: number;
	readonly rollingSummary: number;
	/** Estimated tokens for the live message tail (everything but sys/seed/summary). */
	readonly hotTailEstimate: number;
}

/**
 * Derive the system-prompt+tools bucket from a usable provider usage sample:
 * `sys = max(0, total - (seed + rollingSummary + hotTailEstimate))`. This
 * anchors `sys` to real usage instead of estimating tool-schema bytes.
 */
export function calibrateSys(input: CalibrationInput): number {
	return Math.max(
		0,
		input.total - input.seed - input.rollingSummary - input.hotTailEstimate,
	);
}

/** Inputs that invalidate a prior sys calibration when any of them change. */
export interface CalibrationKey {
	readonly mode: string;
	readonly toolSignature: string;
	readonly systemPromptLength: number;
}

export function calibrationKey(key: CalibrationKey): string {
	return `${key.mode}|${key.toolSignature}|${key.systemPromptLength}`;
}

/**
 * Format the bucket breakdown for the footer:
 *   `total/limit (sys/summary/work)`
 * where summary = seed + rollingSummary and work = hotTail. Renders `?` for an
 * unknown total so the footer stays stable after compaction.
 */
export function formatBudget(buckets: ContextBuckets, limit: number): string {
	const total = buckets.total === null ? "?" : String(buckets.total);
	return `${total}/${limit} (${buckets.sys}/${buckets.summaryUsed}/${buckets.hotTail})`;
}
