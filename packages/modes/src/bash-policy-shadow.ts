import type { BashCorpusCall, CorpusActor, CorpusMode } from "./bash-corpus.js";
import {
	type BashActor,
	type BashPolicyDecision,
	decideBashPolicy,
} from "./bash-policy.js";
import type {
	ShadowPolicy,
	ShadowPolicyDecision,
	ShadowReplayInput,
} from "./bash-shadow-replay.js";
import type { ExecutionPolicySettings } from "./settings.js";

export interface BashShadowReport {
	readonly total: number;
	readonly unknown: readonly string[];
	readonly unexplainedProtectedHostWrites: readonly string[];
	readonly disagreements: readonly {
		callId: string;
		mode: CorpusMode;
		actor: CorpusActor;
		decision: BashPolicyDecision;
	}[];
}

/** Adapter used by the inert baseline replay harness. */
export function createBashShadowPolicy(
	policy: ExecutionPolicySettings,
): ShadowPolicy {
	return {
		id: `bash-router-${policy.preset}`,
		evaluate(input) {
			return toShadowDecision(evaluateShadowInput(input, policy));
		},
	};
}

/**
 * Evaluate sanitized training/holdout calls as data only. Any protected-mode
 * direct route carrying a write-like effect is surfaced as a release blocker.
 */
export function auditBashShadowCorpus(
	calls: readonly BashCorpusCall[],
	policy: ExecutionPolicySettings,
): BashShadowReport {
	const unknown: string[] = [];
	const unexplainedProtectedHostWrites: string[] = [];
	const disagreements: BashShadowReport["disagreements"][number][] = [];
	for (const call of calls) {
		const decision = decideBashPolicy({
			command: call.command,
			mode: normalizeMode(call.mode),
			actor: normalizeActor(call.actor, call.posture),
			policy,
		});
		if (decision.effects.has("unknown")) unknown.push(call.id);
		if (
			(call.mode === "recon" || call.mode === "plan") &&
			(decision.route === "direct" || decision.route === "host-read") &&
			[
				"workspace-write",
				"repository-code",
				"local-git",
				"remote-write",
				"destructive",
				"privileged",
			].some((effect) => decision.effects.has(effect as never))
		)
			unexplainedProtectedHostWrites.push(call.id);
		if (
			call.outcome.status === "success" &&
			(decision.route === "deny" || decision.route === "confirm")
		) {
			disagreements.push({
				callId: call.id,
				mode: call.mode,
				actor: call.actor,
				decision,
			});
		}
	}
	return {
		total: calls.length,
		unknown: unknown.sort(),
		unexplainedProtectedHostWrites: unexplainedProtectedHostWrites.sort(),
		disagreements: disagreements.sort((a, b) =>
			a.callId.localeCompare(b.callId),
		),
	};
}

function evaluateShadowInput(
	input: ShadowReplayInput,
	policy: ExecutionPolicySettings,
): BashPolicyDecision {
	return decideBashPolicy({
		command: input.command,
		mode: normalizeMode(input.mode),
		actor: normalizeActor(input.actor, input.posture),
		policy,
	});
}

function toShadowDecision(decision: BashPolicyDecision): ShadowPolicyDecision {
	return {
		route: decision.route,
		reason: decision.reason,
		confidence: decision.confidence,
		...(decision.suggestedTool
			? { suggestedTool: decision.suggestedTool }
			: {}),
		effects: [...decision.effects],
	};
}

function normalizeMode(
	mode: CorpusMode,
): "recon" | "plan" | "auto" | "hack" | "agent" {
	return mode === "unknown" ? "auto" : mode;
}

function normalizeActor(
	actor: CorpusActor,
	posture: BashCorpusCall["posture"],
): BashActor {
	if (posture === "read-only" || actor === "reviewer") return "reviewer";
	if (actor === "worker" || actor === "agent") return "worker";
	return "maestro";
}
