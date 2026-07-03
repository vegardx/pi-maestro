// Pure gates for the mid-deliverable compaction trigger and the
// post-compaction resume. Side-effect free so the budget math and the
// resume decision tree are unit-testable in isolation; the runtime layer
// owns the I/O (ctx.compact, sendMessage, notify).

import type { ExecutionStage, ModeName } from "@vegardx/pi-contracts";

// ---------------------------------------------------------------------------
// Mid-deliverable trigger gate.
// ---------------------------------------------------------------------------

export interface MidDeliverableTriggerInput {
	readonly mode: ModeName;
	/** Re-entrancy guard: a modes-owned compaction is already running. */
	readonly compactionInFlight: boolean;
	readonly hasActiveDeliverable: boolean;
	/** `sys + hotTail` from the bucket breakdown; null when total is unknown. */
	readonly workingUsed: number | null;
	readonly workingTokens: number;
}

/**
 * Fire a mid-deliverable compaction iff modes is driving execution and the
 * WORKING budget (`sys + hotTail`) — not raw total, and not the stable
 * `seed + rollingSummary` summary burden — has crossed `workingTokens`.
 *
 * Cheapest checks first so most `turn_end` events short-circuit. The caller
 * owns the `compactionInFlight` flag and the post-timeout cooldown.
 */
export function shouldCompactMidDeliverable(
	input: MidDeliverableTriggerInput,
): boolean {
	if (input.mode !== "auto") return false;
	if (input.compactionInFlight) return false;
	if (!input.hasActiveDeliverable) return false;
	if (typeof input.workingUsed !== "number") return false;
	return input.workingUsed > input.workingTokens;
}

// ---------------------------------------------------------------------------
// Compaction completion wrapper.
// ---------------------------------------------------------------------------

/**
 * Adapt pi's `onComplete`/`onError` callbacks into a single promise that
 * settles exactly once. Rejects on abort or after `timeoutMs` so a stuck
 * summariser can't pin the auto loop. After a timeout/abort pi may still be
 * compacting in the background, so the caller should apply a cooldown before
 * re-triggering.
 */
export function awaitCompaction(deps: {
	start: (opts: {
		onComplete: () => void;
		onError: (err: Error) => void;
	}) => void;
	signal?: AbortSignal;
	timeoutMs: number;
}): Promise<void> {
	const { start, signal, timeoutMs } = deps;
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => finish(new Error("aborted"));
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (err) reject(err);
			else resolve();
		};
		if (signal?.aborted) {
			finish(new Error("aborted"));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(
			() => finish(new Error(`compaction timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		timer.unref?.();
		start({ onComplete: () => finish(), onError: (err) => finish(err) });
	});
}

// ---------------------------------------------------------------------------
// Post-compaction resume gate.
// ---------------------------------------------------------------------------

export interface ResumeAfterCompactionInput {
	/** True iff the modes-owned compaction resolved without throwing. */
	readonly compacted: boolean;
	/** Execution stage captured at trigger time. */
	readonly stageAtEntry: ExecutionStage | null | undefined;
	/** Mode captured at trigger time. */
	readonly modeAtEntry: ModeName | null | undefined;
	/** Active deliverable id captured at trigger time. */
	readonly deliverableAtEntry: string | null | undefined;
	/** Execution stage right now (after compaction resolved). */
	readonly currentStage: ExecutionStage | null | undefined;
	/** Mode right now. */
	readonly currentMode: ModeName | null | undefined;
	/** Active deliverable id right now. */
	readonly currentDeliverable: string | null | undefined;
	/** Incomplete gating tasks in the active deliverable. */
	readonly remainingTaskCount: number;
}

export type CompactionResumeGate =
	| "compact-failed"
	| "stage-at-entry-not-executing"
	| "stage-drifted"
	| "mode-drifted"
	| "deliverable-drifted"
	| "no-remaining-tasks";

export type CompactionResumeDecision =
	| { readonly resume: true }
	| {
			readonly resume: false;
			readonly gate: CompactionResumeGate;
			/** True when stage drifted specifically to exec-complete mid-compaction. */
			readonly driftedToExecComplete: boolean;
	  };

/** Boolean form of {@link diagnoseResumeAfterCompaction}. */
export function shouldResumeAfterCompaction(
	input: ResumeAfterCompactionInput,
): boolean {
	return diagnoseResumeAfterCompaction(input).resume;
}

/**
 * Decide whether to kick a follow-up turn after a successful mid-deliverable
 * compaction, with a per-gate reason for diagnostics.
 *
 * Gates (in order):
 *   1. compacted               — on failure, let native/smart handle overflow.
 *   2. stageAtEntry executing  — we entered while genuinely executing.
 *   3. currentStage executing  — still executing now (no Shift+Tab/exec-complete drift).
 *   4. mode unchanged          — didn't leave ask/auto mid-flight.
 *   5. deliverable unchanged   — same active deliverable.
 *   6. remaining tasks > 0     — work left to resume.
 */
export function diagnoseResumeAfterCompaction(
	input: ResumeAfterCompactionInput,
): CompactionResumeDecision {
	if (!input.compacted) {
		return {
			resume: false,
			gate: "compact-failed",
			driftedToExecComplete: false,
		};
	}
	if (input.stageAtEntry !== "executing") {
		return {
			resume: false,
			gate: "stage-at-entry-not-executing",
			driftedToExecComplete: false,
		};
	}
	if (input.currentStage !== "executing") {
		return {
			resume: false,
			gate: "stage-drifted",
			driftedToExecComplete: input.currentStage === "exec-complete",
		};
	}
	if (input.modeAtEntry !== input.currentMode) {
		return {
			resume: false,
			gate: "mode-drifted",
			driftedToExecComplete: false,
		};
	}
	if (input.deliverableAtEntry !== input.currentDeliverable) {
		return {
			resume: false,
			gate: "deliverable-drifted",
			driftedToExecComplete: false,
		};
	}
	if (input.remainingTaskCount <= 0) {
		return {
			resume: false,
			gate: "no-remaining-tasks",
			driftedToExecComplete: false,
		};
	}
	return { resume: true };
}
