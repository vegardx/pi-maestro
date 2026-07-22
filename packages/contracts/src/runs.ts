// Subagent run-bus: the message union and run shapes shared between the
// subagents service (owner) and maestros like modes. The structured
// SpawnProfile is the spawn API — callers never set child env/args directly;
// the service maps a profile to a child invocation.

import type { FeatureFlagOverrides } from "./flags.js";
import type { RunId } from "./ids.js";
import type { ModeName } from "./modes.js";

/** Current status.json payload schema. There is no legacy hydration path. */
export const RUN_RECORD_SCHEMA_VERSION = 2 as const;

export const RUN_STATUSES = [
	"queued",
	"starting",
	"running",
	"blocked",
	"interrupting",
	"succeeded",
	"failed",
	"stopped",
	"canceled",
	"timed-out",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Statuses a run can settle in. Monotonic lifecycle:
 * queued → starting → running (⇄ blocked) → [interrupting] → terminal.
 * `stopped` is an explicit interrupt (terminal — NEVER auto-retried);
 * `timed-out` is a deadline kill (startup, RPC, stall, or hard cap — also
 * terminal, also never auto-retried); `canceled` never started.
 */
export type TerminalRunStatus = Extract<
	RunStatus,
	"succeeded" | "failed" | "stopped" | "canceled" | "timed-out"
>;

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type RunTransport = "headless" | "tmux";

export interface RunProcessMetadata {
	readonly transport: RunTransport;
	readonly parent?: RunId;
	readonly rootTurnId?: string;
	readonly pid?: number;
	readonly processGroup?: number;
	readonly tmuxSession?: string;
	readonly tmuxPane?: string;
	readonly sessionFile?: string;
	readonly cwd?: string;
	/**
	 * Caller identity — set once by the service at spawn from the profile.
	 * Transports publish only process facts (pid/session/…) and must never
	 * overwrite these (metadata messages merge, so omitting preserves them).
	 */
	readonly role?: string;
	readonly displayName?: string;
	readonly retainUntil?: number;
}

export type InterruptOutcome =
	| "accepted"
	| "already-idle"
	| "already-interrupting"
	| "disconnected"
	| "timed-out"
	| "escalated-term"
	| "escalated-kill";

export interface InterruptResult {
	readonly outcome: InterruptOutcome;
	readonly targetId: string;
	readonly detail?: string;
	readonly partialText?: string;
}

export interface ToolPolicy {
	readonly allow?: readonly string[];
	readonly deny?: readonly string[];
}

/**
 * The structured spawn API. The subagents service maps this to a child
 * invocation: pi-native fields (model/tools/thinking/mode/cwd/session/
 * appendSystemPrompt) become RpcClient args/flags; enablement + featureFlags
 * become child env, computed explicitly per spawn (never inherited).
 */
export interface SpawnProfile {
	/** Named profile, e.g. "deliverable-agent" or "reviewer". */
	readonly profile: string;
	readonly cwd?: string;
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
	readonly mode?: ModeName;
	readonly tools?: ToolPolicy;
	readonly appendSystemPrompt?: string;
	/** `false` => spawn with --no-session. */
	readonly session?: boolean;
	/** Override the child's session storage directory. */
	readonly sessionDir?: string;
	/**
	 * Explicit session file the child spawns with (`--session <file>`). pi
	 * creates it if absent and RESUMES it (appending the new prompt to the
	 * prior transcript) if present — so a one-shot run can later be re-entered
	 * with a follow-up. Takes precedence over `session: false`.
	 */
	readonly sessionFile?: string;
	/**
	 * Spawn with --no-extensions so the child loads NONE of the globally
	 * configured extensions — only the paths in `extraExtensions`. Keeps the
	 * child's tool namespace deterministic (no collisions with whatever the
	 * user has installed globally).
	 */
	readonly isolateExtensions?: boolean;
	/** Extension paths loaded into the child via -e (works with or without
	 *  isolateExtensions). */
	readonly extraExtensions?: readonly string[];
	/** Deliberate feature-flag overrides propagated to the child. */
	readonly featureFlags?: FeatureFlagOverrides;
	/**
	 * Liveness watchdog the runner enforces for this run. Distinguishes a
	 * WEDGED child (event silence → stop at `stallMs`, salvage last text)
	 * from a SLOW one (steered once with `wrapUpSteer` at `softMs`), with
	 * `hardMs` as the only true timeout. Absent ⇒ no watchdog (callers own
	 * their policy).
	 */
	readonly watchdog?: RunWatchdogConfig;
	/** Execution transport. Long-running work should select tmux explicitly. */
	readonly transport?: RunTransport;
	/** Human-facing identity and lineage for the unified target registry. */
	readonly role?: string;
	readonly displayName?: string;
	readonly parent?: RunId;
	readonly rootTurnId?: string;
	readonly retainUntil?: number;
	/**
	 * Persistent standby: after the initial prompt settles the child is kept
	 * ALIVE, holding its context, so the caller can drive it with `ask`
	 * follow-ups until the run is stopped/interrupted (reaped when the parent
	 * ends). Absent/false ⇒ the one-shot lifecycle (prompt → settle → gone).
	 * The lifecycle property behind the persistent agent types (worker driving
	 * subagents, advisor) — see docs/design/multi-model-agents.md §4.
	 */
	readonly standby?: boolean;
	/** Opaque metadata for the maestro. */
	readonly meta?: Readonly<Record<string, unknown>>;
}

/** Watchdog thresholds for one run (all optional; absent checks are skipped). */
export interface RunWatchdogConfig {
	/** Event silence that counts as wedged → stop + salvage. */
	readonly stallMs?: number;
	/** Elapsed time after which the child is steered ONCE to wrap up. */
	readonly softMs?: number;
	/** Absolute wall-clock backstop → stop + salvage. */
	readonly hardMs?: number;
	/** The wrap-up steer message sent at softMs (requires softMs). */
	readonly wrapUpSteer?: string;
}

export interface RunSpawnRequest {
	readonly id: RunId;
	readonly prompt: string;
	readonly profile: SpawnProfile;
	/** Spawning run, when nested. */
	readonly parent?: RunId;
}

export interface RunProgress {
	readonly text?: string;
	/** Per-turn deltas, not cumulative — consumers accumulate. */
	readonly tokensIn?: number;
	readonly tokensOut?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	/** Pre-computed cost for the turn (pi-ai Usage.cost.total). */
	readonly cost?: number;
}

export interface RunResult {
	readonly status: TerminalRunStatus;
	/**
	 * The child's final text. On a watchdog-stopped run this is the SALVAGED
	 * partial text (last completed assistant message), delivered so a stopped
	 * run still contributes what it learned — `error` says why it stopped.
	 */
	readonly summary?: string;
	readonly error?: string;
	readonly stop?: StopRecord;
}

export const STOP_KINDS = [
	"completed",
	"failed",
	"canceled",
	"interrupted",
	"timed-out",
] as const;
export type StopKind = (typeof STOP_KINDS)[number];

/** Durable terminal provenance, recorded once at the first terminal transition. */
export interface StopRecord {
	readonly kind: StopKind;
	readonly requestedAt?: number;
	readonly completedAt: number;
	readonly requestedBy?: string;
	readonly reason?: string;
	readonly outcome?: InterruptOutcome;
	readonly recoverable: boolean;
}

/** A run asking the maestro to decide (the contact_supervisor path). */
export interface SupervisorDecisionRequest {
	readonly question: string;
	readonly options?: readonly string[];
	readonly context?: string;
}

export interface SupervisorDecision {
	readonly answer: string;
}

/** The message union flowing on the run-bus. */
export type RunBusMessage =
	| { readonly type: "spawn"; readonly run: RunSpawnRequest }
	| {
			readonly type: "status";
			readonly runId: RunId;
			readonly status: RunStatus;
			readonly at: number;
	  }
	| {
			readonly type: "progress";
			readonly runId: RunId;
			readonly delta: RunProgress;
	  }
	| {
			readonly type: "steer";
			readonly runId: RunId;
			readonly guidance: string;
	  }
	| {
			readonly type: "interrupt";
			readonly runId: RunId;
			readonly reason?: string;
			readonly phase?: "requested" | "acknowledged" | "term" | "kill";
	  }
	| {
			readonly type: "metadata";
			readonly runId: RunId;
			readonly metadata: RunProcessMetadata;
	  }
	| {
			readonly type: "capture";
			readonly runId: RunId;
			readonly text: string;
	  }
	| {
			readonly type: "stop";
			readonly runId: RunId;
			readonly reason?: string;
	  }
	| {
			readonly type: "result";
			readonly runId: RunId;
			readonly result: RunResult;
	  }
	| {
			readonly type: "needDecision";
			readonly runId: RunId;
			readonly request: SupervisorDecisionRequest;
	  }
	| {
			readonly type: "agentEvent";
			readonly runId: RunId;
			readonly event: unknown;
	  };

export type RunBusMessageType = RunBusMessage["type"];

/** Persisted record of a run. */
export interface RunRecord {
	readonly schemaVersion: typeof RUN_RECORD_SCHEMA_VERSION;
	readonly id: RunId;
	readonly parent?: RunId;
	readonly profile: SpawnProfile;
	readonly status: RunStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** Set once on the first accepted terminal transition. */
	readonly completedAt?: number;
	readonly stop?: StopRecord;
	readonly result?: RunResult;
	readonly metadata?: RunProcessMetadata;
	readonly lastEventAt?: number;
}

/** Live control surface returned by a spawn. */
export interface RunHandle {
	readonly id: RunId;
	status(): RunStatus;
	steer(guidance: string): void;
	/**
	 * Request→response on a PERSISTENT (standby) child: deliver `message` as a
	 * follow-up, wait for the child to go idle, and resolve with that turn's
	 * final assistant text. Only present for standby spawns; a one-shot run has
	 * no live context to re-enter. See docs/design/multi-model-agents.md §4.
	 */
	ask?(message: string): Promise<string>;
	interrupt?(reason?: string): Promise<InterruptResult>;
	/** Compatibility alias for terminal one-shot interruption. */
	stop(reason?: string): void;
	result(): Promise<RunResult>;
	/**
	 * Timestamp of the child's most recent event (any tool start, delta, or
	 * turn end) — the liveness signal a watchdog distinguishes "stalled" from
	 * "slow but working" with. Optional: fakes and remote transports may not
	 * track it.
	 */
	lastEventAt?(): number;
	/**
	 * The child's last completed assistant text so far — salvage for runs a
	 * watchdog has to stop. Optional, best-effort.
	 */
	partialText?(): Promise<string | undefined>;
}
