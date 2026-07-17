// Canonical identities and immutable execution assignments for every agent.
// Human aliases are presentation only; exact opaque target ids always win.

import type { ModelRole } from "./models.js";
import type { ThinkingLevel, ToolPolicy } from "./runs.js";

export const AGENT_KINDS = [
	"host",
	"worker",
	"delegate",
	"reviewer",
	"researcher",
	"advisor",
	"verifier",
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export type AgentTargetKind = "host" | "worker" | "run";
export type AgentTransport = "host" | "tmux" | "headless";

/** Runtime constraints are resolved before spawn, never inferred by a child. */
export interface AgentRuntimePolicy {
	readonly mode: "full" | "read-only";
	readonly transport: AgentTransport;
	readonly tools: ToolPolicy;
	readonly session: "persistent" | "ephemeral";
	readonly isolation: "host" | "lightweight" | "strong";
	readonly maxTurns?: number;
	readonly timeoutMs?: number;
}

/** One allowed concrete choice in a named model set. */
export interface AgentModelOption {
	readonly id: string;
	readonly modelId: string;
	readonly efforts: readonly ThinkingLevel[];
	readonly authenticated: boolean;
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

/** Concrete, validated assignment persisted before an agent can start. */
export interface ResolvedAgentAssignment {
	readonly agentId: string;
	readonly kind: AgentKind;
	readonly presetId: string;
	readonly modelSetId: string;
	readonly optionId: string;
	readonly modelId: string;
	readonly effort?: ThinkingLevel;
	readonly runtime: AgentRuntimePolicy;
	readonly resolvedAt: string;
	readonly source: "preset" | "explicit" | "session";
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
