// Typed semantic agent kinds, immutable assignments, and runtime-policy
// composition. Semantic kinds describe WHAT an agent does; runtime policies
// describe HOW it is allowed to run. The two registries are intentionally
// independent so permissions/session/transport policy can be reused without
// duplicating prompts or routing guidance.

import type { RunId } from "./ids.js";
import type { ExactModelCandidateFact, ModelRole } from "./models.js";
import type {
	RunHandle,
	RunProcessMetadata,
	RunRecord,
	RunResult,
	RunStatus,
	RunWatchdogConfig,
	ThinkingLevel,
	ToolPolicy,
} from "./runs.js";
import type { TokenSnapshot } from "./usage.js";

export const AGENT_KINDS = [
	"host",
	"worker",
	"general",
	"codebase-research",
	"web-research",
	"plan-review",
	"practical-review",
	"adversarial-review",
	"correctness-review",
	"security-review",
	"test-review",
	"simplification-review",
	"verifier",
	"delivery-verifier",
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export type AgentTargetKind = "host" | "worker" | "run" | "watch";
export type AgentTransport = "host" | "tmux" | "headless";

/** Runtime constraints resolved before spawn, never inferred by a child. */
export interface AgentRuntimePolicy {
	readonly mode: "full" | "read-only";
	readonly transport: AgentTransport;
	readonly tools: ToolPolicy;
	readonly session: "persistent" | "ephemeral";
	readonly isolation: "host" | "lightweight" | "strong";
	readonly maxTurns?: number;
	readonly timeoutMs?: number;
}

/** Independently registered permission policy. */
export interface AgentPermissionPolicy {
	readonly id: string;
	readonly mode: AgentRuntimePolicy["mode"];
	readonly tools: ToolPolicy;
	readonly isolation: AgentRuntimePolicy["isolation"];
	readonly extraExtensions?: readonly "research-tools"[];
}

/** Independently registered session policy. */
export interface AgentSessionPolicy {
	readonly id: string;
	readonly session: AgentRuntimePolicy["session"];
	readonly maxTurns?: number;
}

/** Independently registered transport policy. */
export interface AgentTransportPolicy {
	readonly id: string;
	readonly transport: AgentTransport;
	readonly timeoutMs?: number;
}

/** A runtime policy composes the three orthogonal policy registries. */
export interface AgentRuntimePolicyDefinition {
	readonly id: string;
	readonly permissions: string;
	readonly session: string;
	readonly transport: string;
}

export type AgentReducerId =
	| "identity"
	| "research-digest"
	| "review-findings"
	| "verification";

export interface AgentOutputContract {
	readonly id: string;
	readonly description: string;
	readonly requiredMarkers?: readonly string[];
	readonly maxWords?: number;
}

export interface AgentSequencingGuidance {
	readonly mode: "parallel" | "serial";
	readonly guidance: string;
}

/**
 * An optional maestro slash command a persona exposes. The generic handler
 * spawns this kind against a target and surfaces its report (report-only — no
 * auto-remediation). `instruction` is prose the maestro follows to drive the
 * command, INCLUDING what a bare (no-argument) invocation does: offer options,
 * pick a default, or ask for a free-text brief. Only kinds meant to be invoked
 * maestro-side over a target should set this; worker-panel review lenses leave
 * it unset.
 */
export interface AgentKindCommand {
	/** Slash command name, e.g. "verify" or "code-review". */
	readonly name: string;
	/** Shown in /help. */
	readonly description: string;
	/** How the maestro drives it, including bare-invocation behavior. */
	readonly instruction: string;
	/**
	 * What the command runs against: `"changes"` reviews the repo's current
	 * changes in one spawn (default); `"deliverables"` fans out over the plan's
	 * started deliverables (each against its real diff), like `/verify`.
	 */
	readonly target?: "changes" | "deliverables";
}

/** Descriptor stored by the kind registry. Prompts are full authored policy. */
export interface AgentKindDefinition {
	readonly id: AgentKind;
	readonly routingSummary: string;
	readonly prompt: string;
	readonly runtimePolicy: string;
	readonly modelRole: ModelRole;
	readonly contracts: readonly AgentOutputContract[];
	readonly watchdog: RunWatchdogConfig;
	readonly sequencing: AgentSequencingGuidance;
	readonly reducer: AgentReducerId;
	/** Optional maestro slash command this persona exposes. */
	readonly command?: AgentKindCommand;
}

/** One authored exact choice in a named model set. */
export interface AgentModelOption {
	readonly id: string;
	readonly model: string;
	readonly effort: ThinkingLevel;
	readonly summary: string;
}

/** Ordered options; order is policy and the first compatible option is default. */
export interface AgentModelSet {
	readonly id: string;
	readonly role: ModelRole;
	readonly options: readonly AgentModelOption[];
}

/** Reusable policy + model-set reference used by planned agent specifications. */
export interface AgentModelPreset {
	readonly id: string;
	readonly kind: AgentKind;
	readonly modelSetId: string;
	readonly runtime: AgentRuntimePolicy;
	readonly defaultEffort?: ThinkingLevel;
}

/** Immutable explanation of how an exact assignment was selected. */
export interface AgentAssignmentProvenance {
	readonly source: "preset" | "explicit" | "session";
	readonly presetId: string;
	readonly modelSetId: string;
	readonly optionId: string;
	readonly resolvedAt: string;
}

/** Concrete, validated assignment persisted before an agent can start. */
export interface ResolvedAgentAssignment {
	/** Stable plan-scoped identity. It must not be regenerated when execution resumes. */
	readonly agentId: string;
	readonly kind: AgentKind;
	readonly presetId: string;
	readonly modelSetId: string;
	readonly optionId: string;
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
	readonly runtime: AgentRuntimePolicy;
	/** Specific work this assignment performs. */
	readonly focus: string;
	/** Why this kind/model belongs in the workflow. */
	readonly rationale: string;
	/** Contracts consumed from the immutable stage input. */
	readonly inputContracts: readonly string[];
	/** Contracts published after the assignment completes. */
	readonly outputContracts: readonly string[];
	readonly provenance: AgentAssignmentProvenance;
	readonly resolvedAt: string;
	readonly source: "preset" | "explicit" | "session";
}

/** Planning request: resolves policy and an exact model without starting a run. */
export interface AgentAssignmentRequest {
	readonly agentId: string;
	readonly kind: AgentKind;
	readonly focus: string;
	readonly rationale: string;
	readonly inputContracts: readonly string[];
	readonly outputContracts?: readonly string[];
	readonly model?: string;
	/**
	 * Deliberate tier reference (a catalog tier id, e.g. `fast`/`normal`/`heavy`).
	 * The discoverable middle ground between inheriting the session model (omit
	 * everything) and pinning one exact `model`: resolves to a concrete model
	 * from the agent type's tier allowlist. `model` wins if both are given.
	 */
	readonly tier?: string;
	readonly effort?: ThinkingLevel;
}

export interface AgentPlanningOptions {
	readonly kind: AgentKindDefinition;
	readonly candidates: readonly ExactModelCandidateFact[];
}

/** Request accepted by agents.v1. Defaults still resolve to an exact pair. */
export interface AgentRunRequest {
	readonly kind: AgentKind;
	readonly prompt: string;
	readonly model?: string;
	/** Deliberate tier id — see {@link AgentAssignmentRequest.tier}. */
	readonly tier?: string;
	readonly effort?: ThinkingLevel;
	readonly cwd?: string;
	readonly displayName?: string;
	readonly parent?: RunId;
	readonly rootTurnId?: string;
	readonly meta?: Readonly<Record<string, unknown>>;
}

export interface AgentRun {
	readonly runId: RunId;
	readonly assignment: ResolvedAgentAssignment;
	readonly handle: RunHandle;
}

/**
 * Durable, cumulative view of a run owned by another process. The owner keeps
 * the RunStore authoritative; maestros persist and render this projection.
 */
export interface ChildRunProjection {
	readonly runId: RunId;
	readonly revision: number;
	readonly parent?: RunId;
	readonly kind: AgentKind;
	readonly model: string;
	readonly effort: ThinkingLevel;
	readonly assignment?: ResolvedAgentAssignment;
	readonly status: RunStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly completedAt?: number;
	readonly lastEventAt?: number;
	readonly activity?: string;
	readonly metadata?: RunProcessMetadata;
	readonly profile: Pick<
		import("./runs.js").SpawnProfile,
		"profile" | "role" | "displayName" | "cwd" | "transport" | "rootTurnId"
	>;
	readonly usage: TokenSnapshot;
	readonly result?: RunResult;
}

/** Worker-local source consumed by the worker RPC bridge. */
export interface ChildRunProjectionSourceV1 {
	list(): readonly ChildRunProjection[];
	subscribe(listener: (projection: ChildRunProjection) => void): () => void;
	steer(runId: RunId, guidance: string): void;
	interrupt(
		runId: RunId,
		reason?: string,
	): Promise<import("./runs.js").InterruptResult>;
	capture(runId: RunId, lines?: number): Promise<string | undefined>;
	stop(runId: RunId, reason?: string): void;
}

/** Unified programmatic API. Model-facing tooling is a projection of this. */
export interface AgentsCapabilityV1 {
	/** Resolve one persistable assignment without spawning it. */
	resolve(request: AgentAssignmentRequest): Promise<ResolvedAgentAssignment>;
	/** Inspect authored exact choices and availability for a semantic kind. */
	options(kind: AgentKind): Promise<AgentPlanningOptions>;
	run(request: AgentRunRequest): Promise<AgentRun>;
	batch(requests: readonly AgentRunRequest[]): Promise<readonly AgentRun[]>;
	list(): readonly RunRecord[];
	status(runId: RunId): RunRecord | undefined;
	steer(runId: RunId, guidance: string): void;
	/**
	 * Drive a persistent (standby) child and wait for its reply: deliver the
	 * message as a follow-up, block until the child goes idle, and resolve with
	 * that turn's assistant text. Undefined when the run cannot be asked (not
	 * standby, unknown, or already settled).
	 */
	ask(runId: RunId, message: string): Promise<string | undefined>;
	interrupt(runId: RunId, reason?: string): Promise<void>;
	capture(runId: RunId, lines?: number): Promise<string | undefined>;
	result(runId: RunId): Promise<RunResult | undefined>;
	kinds(): readonly AgentKindDefinition[];
}

export function validateResolvedAgentAssignment(value: unknown): string[] {
	if (!isRecord(value)) return ["assignment must be an object"];
	const errors: string[] = [];
	for (const key of [
		"agentId",
		"presetId",
		"modelSetId",
		"optionId",
		"modelId",
	] as const) {
		if (!nonEmpty(value[key]))
			errors.push(`assignment.${key} must be non-empty`);
	}
	if (!AGENT_KINDS.includes(value.kind as AgentKind))
		errors.push("assignment.kind is unsupported");
	if (!isRecord(value.runtime)) errors.push("assignment.runtime is required");
	for (const key of ["focus", "rationale"] as const) {
		if (!nonEmpty(value[key]))
			errors.push(`assignment.${key} must be non-empty`);
	}
	for (const key of ["inputContracts", "outputContracts"] as const) {
		if (!Array.isArray(value[key])) {
			errors.push(`assignment.${key} must be an array`);
			continue;
		}
		const contracts = value[key] as unknown[];
		if (contracts.some((contract) => !nonEmpty(contract)))
			errors.push(`assignment.${key} must contain non-empty contract ids`);
		if (new Set(contracts).size !== contracts.length)
			errors.push(`assignment.${key} must not contain duplicates`);
	}
	if (!isRecord(value.provenance)) {
		errors.push("assignment.provenance is required");
	} else {
		for (const key of [
			"presetId",
			"modelSetId",
			"optionId",
			"resolvedAt",
			"source",
		] as const) {
			if (value.provenance[key] !== value[key])
				errors.push(
					`assignment.provenance.${key} must match assignment.${key}`,
				);
		}
	}
	if (value.effort !== undefined && !nonEmpty(value.effort))
		errors.push("assignment.effort must be non-empty when present");
	if (
		!nonEmpty(value.resolvedAt) ||
		!Number.isFinite(Date.parse(String(value.resolvedAt)))
	)
		errors.push("assignment.resolvedAt must be an ISO timestamp");
	if (!["preset", "explicit", "session"].includes(String(value.source)))
		errors.push("assignment.source is unsupported");
	return errors;
}

export interface AgentTarget {
	readonly id: string;
	readonly kind: AgentTargetKind;
	readonly agentKind?: AgentKind;
	readonly displayName: string;
	readonly role: string;
	readonly status: string;
	readonly transport: AgentTransport;
	readonly parentId?: string;
	readonly rootTurnId?: string;
	readonly pid?: number;
	readonly processGroup?: number;
	readonly tmuxSession?: string;
	readonly tmuxPane?: string;
	readonly sessionFile?: string;
	readonly cwd?: string;
	readonly model?: string;
	readonly assignment?: ResolvedAgentAssignment;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly completedAt?: number;
	readonly capabilities: {
		readonly view: boolean;
		readonly capture: boolean;
		readonly steer: boolean;
		readonly interrupt: boolean;
		readonly shutdown: boolean;
	};
}

export type AgentTargetResolution =
	| { readonly ok: true; readonly target: AgentTarget }
	| {
			readonly ok: false;
			readonly reason: "not-found";
			readonly selector: string;
	  }
	| {
			readonly ok: false;
			readonly reason: "ambiguous";
			readonly selector: string;
			readonly matches: readonly AgentTarget[];
	  };

export function resolveAgentTarget(
	targets: readonly AgentTarget[],
	selector: string,
): AgentTargetResolution {
	const value = selector.trim();
	const exact = targets.find((target) => target.id === value);
	if (exact) return { ok: true, target: exact };
	const matches = targets.filter((target) => {
		if (target.displayName === value || target.role === value) return true;
		if (target.kind !== "worker") return false;
		const key = target.id.slice("worker:".length);
		return key === value || key === `${value}/worker`;
	});
	if (matches.length === 1) return { ok: true, target: matches[0] };
	if (matches.length > 1)
		return { ok: false, reason: "ambiguous", selector: value, matches };
	return { ok: false, reason: "not-found", selector: value };
}

export function descendantsOf(
	targets: readonly AgentTarget[],
	rootId: string,
): AgentTarget[] {
	const result: AgentTarget[] = [];
	const pending = [rootId];
	while (pending.length > 0) {
		const parent = pending.shift();
		for (const target of targets) {
			if (
				target.parentId !== parent ||
				result.some((item) => item.id === target.id)
			)
				continue;
			result.push(target);
			pending.push(target.id);
		}
	}
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
