import { createHash } from "node:crypto";
import type {
	AgentPosture,
	BashCorpusCall,
	CorpusActor,
	CorpusMode,
} from "./bash-corpus.js";

export type ShadowRoute =
	| "direct"
	| "host-read"
	| "lightweight"
	| "strong"
	| "confirm"
	| "deny"
	| "unknown";

export interface ShadowReplayInput {
	readonly callId: string;
	readonly command: string;
	readonly cwd?: string;
	readonly mode: CorpusMode;
	readonly actor: CorpusActor;
	readonly posture: AgentPosture;
	readonly nearbyTools: readonly string[];
}

export interface ShadowPolicyDecision {
	readonly route: ShadowRoute;
	readonly reason: string;
	readonly confidence?: "low" | "medium" | "high";
	readonly suggestedTool?: string;
	readonly effects?: readonly string[];
}

/** A policy is a pure observer. The corpus module supplies no execution capability. */
export interface ShadowPolicy {
	readonly id: string;
	evaluate(input: Readonly<ShadowReplayInput>): ShadowPolicyDecision;
}

export interface ShadowDecisionRecord {
	readonly callId: string;
	readonly policyId: string;
	readonly decision: ShadowPolicyDecision;
}

export interface ShadowPolicySummary {
	readonly policyId: string;
	readonly routes: Readonly<Record<ShadowRoute, number>>;
	readonly failures: number;
}

export interface ShadowComparison {
	readonly callId: string;
	readonly baselineRoute: ShadowRoute;
	readonly candidateRoute: ShadowRoute;
}

export interface ShadowBaselineReport {
	readonly version: 1;
	readonly corpusDigest: string;
	readonly totalCalls: number;
	readonly policies: readonly ShadowPolicySummary[];
	readonly decisions: readonly ShadowDecisionRecord[];
	readonly comparisons: readonly ShadowComparison[];
	readonly omitted: {
		readonly decisions: number;
		readonly comparisons: number;
	};
}

export interface ShadowReplayOptions {
	/** Policy used as the comparison anchor. Defaults to the first policy. */
	readonly baselinePolicyId?: string;
	readonly maxDecisions?: number;
	readonly maxComparisons?: number;
}

const ROUTES: readonly ShadowRoute[] = [
	"direct",
	"host-read",
	"lightweight",
	"strong",
	"confirm",
	"deny",
	"unknown",
];

/**
 * Evaluate policy functions over inert records. The seam intentionally accepts
 * no process, shell, filesystem, network, or tool executor dependency.
 */
export function replayShadowPolicies(
	calls: readonly BashCorpusCall[],
	policies: readonly ShadowPolicy[],
	options: ShadowReplayOptions = {},
): ShadowBaselineReport {
	const policyIds = new Set<string>();
	for (const policy of policies) {
		if (policy.id.trim() === "" || policyIds.has(policy.id)) {
			throw new Error(
				`shadow policy ids must be unique and non-empty: ${policy.id}`,
			);
		}
		policyIds.add(policy.id);
	}
	const baselinePolicyId = options.baselinePolicyId ?? policies[0]?.id;
	if (baselinePolicyId !== undefined && !policyIds.has(baselinePolicyId)) {
		throw new Error(`unknown baseline policy: ${baselinePolicyId}`);
	}

	const sortedCalls = [...calls].sort((a, b) => a.id.localeCompare(b.id));
	const allDecisions: ShadowDecisionRecord[] = [];
	const summaries = new Map<
		string,
		{ routes: Record<ShadowRoute, number>; failures: number }
	>();
	for (const policy of policies) {
		summaries.set(policy.id, { routes: emptyRoutes(), failures: 0 });
	}

	for (const call of sortedCalls) {
		const input = Object.freeze<ShadowReplayInput>({
			callId: call.id,
			command: call.command,
			cwd: call.cwd,
			mode: call.mode,
			actor: call.actor,
			posture: call.posture,
			nearbyTools: Object.freeze([...call.nearbyTools]),
		});
		for (const policy of policies) {
			let decision: ShadowPolicyDecision;
			try {
				decision = normalizeDecision(policy.evaluate(input));
			} catch (error) {
				decision = {
					route: "unknown",
					reason: `policy-error:${error instanceof Error ? error.name : "unknown"}`,
					confidence: "low",
				};
				summaries.get(policy.id)!.failures++;
			}
			summaries.get(policy.id)!.routes[decision.route]++;
			allDecisions.push({ callId: call.id, policyId: policy.id, decision });
		}
	}

	const allComparisons = buildComparisons(allDecisions, baselinePolicyId);
	const maxDecisions = Math.max(0, options.maxDecisions ?? 500);
	const maxComparisons = Math.max(0, options.maxComparisons ?? 200);
	return {
		version: 1,
		corpusDigest: digestCalls(sortedCalls),
		totalCalls: sortedCalls.length,
		policies: policies.map((policy) => ({
			policyId: policy.id,
			routes: summaries.get(policy.id)!.routes,
			failures: summaries.get(policy.id)!.failures,
		})),
		decisions: allDecisions.slice(0, maxDecisions),
		comparisons: allComparisons.slice(0, maxComparisons),
		omitted: {
			decisions: Math.max(0, allDecisions.length - maxDecisions),
			comparisons: Math.max(0, allComparisons.length - maxComparisons),
		},
	};
}

export function shadowBaselineDigest(report: ShadowBaselineReport): string {
	return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

function buildComparisons(
	decisions: readonly ShadowDecisionRecord[],
	baselinePolicyId: string | undefined,
): ShadowComparison[] {
	if (!baselinePolicyId) return [];
	const baseline = new Map(
		decisions
			.filter((record) => record.policyId === baselinePolicyId)
			.map((record) => [record.callId, record.decision.route]),
	);
	return decisions
		.filter(
			(record) =>
				record.policyId !== baselinePolicyId &&
				baseline.get(record.callId) !== record.decision.route,
		)
		.map((record) => ({
			callId: record.callId,
			baselineRoute: baseline.get(record.callId) ?? "unknown",
			candidateRoute: record.decision.route,
		}));
}

function normalizeDecision(
	decision: ShadowPolicyDecision,
): ShadowPolicyDecision {
	const route = ROUTES.includes(decision.route) ? decision.route : "unknown";
	return {
		route,
		reason:
			typeof decision.reason === "string"
				? decision.reason.slice(0, 500)
				: "missing-reason",
		...(decision.confidence ? { confidence: decision.confidence } : {}),
		...(decision.suggestedTool
			? { suggestedTool: decision.suggestedTool.slice(0, 100) }
			: {}),
		...(decision.effects
			? { effects: [...decision.effects].sort().slice(0, 32) }
			: {}),
	};
}

function emptyRoutes(): Record<ShadowRoute, number> {
	return Object.fromEntries(ROUTES.map((route) => [route, 0])) as Record<
		ShadowRoute,
		number
	>;
}

function digestCalls(calls: readonly BashCorpusCall[]): string {
	const hash = createHash("sha256");
	for (const call of calls) {
		hash.update(call.id).update("\0").update(call.command).update("\0");
	}
	return hash.digest("hex");
}
