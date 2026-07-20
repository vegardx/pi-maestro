// The watcher (design §The watcher, settled 2026-07-20): a `watch` tool any
// agent invokes with a prose goal. Compile-once → read-only probe + a
// deterministic TypeScript canonicalizer; the harness ticks the probe with no
// model involved; the LLM judges only on canonical-state change. Watches are
// process-local to their owning session and raise to their creator. Silence
// is never success: probe failure and expiry always raise.

export type WatchLifetime = "one-shot" | "until-condition";

export const WATCH_STATUSES = [
	"active",
	"triggered",
	"expired",
	"failed",
	"cancelled",
] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

/** Deterministic caps — a watcher that can never expire is a leak. */
export interface WatchCaps {
	readonly maxDurationMs: number;
	/** Poll-interval floor; compiled intervals are clamped up to this. */
	readonly minIntervalMs: number;
	readonly maxRaises: number;
	/** A watcher refined this many times is confused — raise, don't narrow. */
	readonly maxRefinements: number;
}

export const DEFAULT_WATCH_CAPS: WatchCaps = {
	maxDurationMs: 60 * 60_000,
	minIntervalMs: 15_000,
	maxRaises: 10,
	maxRefinements: 5,
};

/** The compiled deterministic layer: what ticks between model calls. */
export interface WatchProbe {
	/** Read-only shell command (passes the bash policy at reviewer posture). */
	readonly command: string;
	readonly intervalMs: number;
	/**
	 * TypeScript program source: reads raw probe output on stdin, prints the
	 * canonical state string on stdout. "Changed" = printed string differs.
	 */
	readonly canonicalizer: string;
}

/** One self-refinement, logged with its rationale (auditable, capped). */
export interface WatchRefinement {
	readonly at: string;
	readonly rationale: string;
	readonly previousCanonicalizer: string;
}

export type WatchRaiseKind =
	| "triggered"
	| "state-change"
	| "probe-failed"
	| "expired"
	| "refinement-cap";

export interface WatchRaise {
	readonly watchId: string;
	readonly kind: WatchRaiseKind;
	readonly summary: string;
	/** Refinement rationales, so a wrongly-ignored signal is discoverable. */
	readonly refinementHistory?: readonly string[];
}

export interface WatchRecord {
	readonly id: string;
	readonly goal: string;
	readonly lifetime: WatchLifetime;
	readonly caps: WatchCaps;
	readonly probe: WatchProbe;
	readonly status: WatchStatus;
	readonly lastState?: string;
	readonly refinements: readonly WatchRefinement[];
	readonly raises: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly endedAt?: string;
	readonly endReason?: string;
}
