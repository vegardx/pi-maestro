// Subagent run-bus: the message union and run shapes shared between the
// subagents service (owner) and orchestrators like modes. The structured
// SpawnProfile is the spawn API — callers never set child env/args directly;
// the service maps a profile to a child invocation.

import type { FeatureFlagOverrides } from "./flags.js";
import type { RunId } from "./ids.js";
import type { ModeName } from "./modes.js";

export const RUN_STATUSES = [
	"queued",
	"running",
	"blocked",
	"succeeded",
	"failed",
	"stopped",
	"canceled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/** Statuses a run can settle in. */
export type TerminalRunStatus = Extract<
	RunStatus,
	"succeeded" | "failed" | "stopped" | "canceled"
>;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

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
	/** Named profile, e.g. "deliverable-worker" or "reviewer". */
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
	/** Deliberate feature-flag overrides propagated to the child. */
	readonly featureFlags?: FeatureFlagOverrides;
	/** Opaque metadata for the orchestrator. */
	readonly meta?: Readonly<Record<string, unknown>>;
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
	readonly tokensIn?: number;
	readonly tokensOut?: number;
}

export interface RunResult {
	readonly status: TerminalRunStatus;
	readonly summary?: string;
	readonly error?: string;
}

/** A run asking the orchestrator to decide (the contact_supervisor path). */
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
	readonly id: RunId;
	readonly parent?: RunId;
	readonly profile: SpawnProfile;
	readonly status: RunStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly result?: RunResult;
}

/** Live control surface returned by a spawn. */
export interface RunHandle {
	readonly id: RunId;
	status(): RunStatus;
	steer(guidance: string): void;
	stop(reason?: string): void;
	result(): Promise<RunResult>;
}
