// v2 exec periphery (plan-schema cutover PR-6): the pieces between the state
// machine and the outside world — contract collection with the steer-and-
// retry loop (contracts spike §5), spawn-time model resolution recording
// (NodeResolution on the ledger), and persona-aware seed assembly. All
// injectable through the adapter's deps seam; real tmux/worktree/ship glue
// binds at the flip where the runtime context owns them.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ContractEnvelope,
	ContractId,
	ContractResult,
	ExtractionTier,
	NodeResolution,
	TierId,
} from "@vegardx/pi-contracts";
import {
	CONTRACT_DEFINITIONS,
	contractRetrySteer,
	parseContractEnvelope,
	validateContractEnvelope,
} from "@vegardx/pi-contracts";
import { resolveV2Model, type V2Resolution } from "@vegardx/pi-models";
import type { Persona } from "@vegardx/pi-subagents";
import type { PlanNode } from "./schema.js";

// ─── Contract collection (the validator + retry loop) ────────────────────────

/** How the collector talks to a live agent; absent agent → salvage only. */
export interface ContractTransport {
	/** Request the agent's final message / contract block. */
	request: (instruction: string) => Promise<string>;
	/** Send a corrective steer (no response expected). */
	steer: (content: string) => void;
}

export interface CollectContractOptions {
	readonly contract: ContractId;
	readonly nodeId: string;
	readonly runId: string;
	readonly model: string;
	/** Live transport, when the agent is reachable. Dead agents skip to salvage. */
	readonly transport?: ContractTransport;
	/** Pre-captured final text (transcript salvage for dead agents). */
	readonly raw?: string;
	readonly maxAttempts?: number;
	readonly now?: () => string;
}

/**
 * The cadence from the contracts spike §5: extract → validate → at most two
 * corrective steers (three attempts) → salvage via the registry's tolerant
 * parser → fail-visible fallback. Every tier is recorded with attempts and
 * diagnostics — a plan whose results all landed via salvage is visibly
 * degraded, never silently fine.
 */
export async function collectContract(
	opts: CollectContractOptions,
): Promise<ContractResult> {
	const definition = CONTRACT_DEFINITIONS[opts.contract];
	const now = opts.now ?? (() => new Date().toISOString());
	const maxAttempts = opts.maxAttempts ?? 3;
	const diagnostics: string[] = [];
	let raw = opts.raw ?? "";
	let attempts = 0;

	if (opts.transport) {
		for (attempts = 1; attempts <= maxAttempts; attempts++) {
			try {
				raw = await opts.transport.request(definition.instruction);
			} catch (cause) {
				diagnostics.push(
					`attempt ${attempts}: request failed (${cause instanceof Error ? cause.message : String(cause)})`,
				);
				break; // dead agent → salvage whatever we have
			}
			const parsed = parseContractEnvelope(raw);
			if (parsed.envelope) {
				if (parsed.envelope.contract !== opts.contract) {
					diagnostics.push(
						`attempt ${attempts}: block carries contract ${parsed.envelope.contract}, expected ${opts.contract}`,
					);
				} else {
					const errors = validateContractEnvelope(parsed.envelope, raw);
					if (errors.length === 0) {
						return {
							envelope: parsed.envelope,
							extraction: attempts === 1 ? "block" : "retry-block",
							attempts,
							raw,
							nodeId: opts.nodeId,
							runId: opts.runId,
							model: opts.model,
							completedAt: now(),
							...(diagnostics.length ? { diagnostics } : {}),
						};
					}
					diagnostics.push(`attempt ${attempts}: ${errors.join("; ")}`);
					if (attempts < maxAttempts)
						opts.transport.steer(contractRetrySteer(opts.contract, errors));
					continue;
				}
			} else {
				diagnostics.push(`attempt ${attempts}: ${parsed.errors.join("; ")}`);
			}
			if (attempts < maxAttempts)
				opts.transport.steer(
					contractRetrySteer(
						opts.contract,
						diagnostics.slice(-1), // the freshest failure, kept short
					),
				);
		}
	}

	// Salvage tier: the registry's tolerant parser over whatever text exists.
	const salvaged = definition.salvage(raw);
	if (salvaged !== null) {
		const envelope: ContractEnvelope = {
			contract: opts.contract,
			v: definition.latest,
			status: "partial", // harness-diagnosed, distinct from agent-authored
			payload: salvaged,
		};
		return {
			envelope,
			extraction: "salvage-parse",
			attempts: Math.min(Math.max(attempts, 1), maxAttempts),
			raw,
			nodeId: opts.nodeId,
			runId: opts.runId,
			model: opts.model,
			completedAt: now(),
			diagnostics,
		};
	}

	// Fallback: fail-visible, never fail-open — consumers apply their
	// per-contract defaults (inconclusive/escalate/hold), never approve.
	return {
		envelope: null,
		extraction: "fallback",
		attempts: Math.min(Math.max(attempts, 1), maxAttempts),
		raw,
		nodeId: opts.nodeId,
		runId: opts.runId,
		model: opts.model,
		completedAt: now(),
		diagnostics,
	};
}

/** Extraction-tier → severity for explain output (informational). */
export function extractionQuality(tier: ExtractionTier): "clean" | "degraded" {
	return tier === "block" || tier === "retry-block" ? "clean" : "degraded";
}

// ─── Spawn-time model resolution → ledger record ─────────────────────────────

export interface ResolveNodeModelOptions {
	readonly node: Pick<PlanNode, "id" | "agent" | "sessionGeneration">;
	/** The caller's model — the inheritance default (parent node or seat). */
	readonly inherit?: { modelId: string; effort?: string };
	/** A tier requested by persona instruction/policy row, when any. */
	readonly tier?: TierId;
	readonly now?: () => string;
}

/**
 * Resolve via the inheritance-first resolver and shape the ledger record.
 * The caller (adapter) records it via engine.recordResolution and surfaces
 * fallbackNotice deduped per agent.
 */
export async function resolveNodeModel(
	ctx: ExtensionContext,
	opts: ResolveNodeModelOptions,
): Promise<{ resolution: NodeResolution; resolved: V2Resolution }> {
	const resolved = await resolveV2Model(ctx, {
		agent: opts.node.agent,
		...(opts.tier ? { tier: opts.tier } : {}),
		...(opts.inherit
			? {
					inherit: {
						modelId: opts.inherit.modelId,
						...(opts.inherit.effort
							? { effort: opts.inherit.effort as never }
							: {}),
					},
				}
			: {}),
	});
	const now = opts.now ?? (() => new Date().toISOString());
	const source =
		resolved.source === "tier"
			? ("persona-tier" as const)
			: resolved.source === "fallback"
				? ("session-fallback" as const)
				: ("inherit" as const);
	const resolution: NodeResolution = {
		model: resolved.modelId,
		family: resolved.family ?? "",
		...(source === "persona-tier" && resolved.tier
			? { tier: resolved.tier }
			: {}),
		source,
		...(resolved.effort ? { effort: resolved.effort } : {}),
		...(resolved.fallbackReason
			? { fallbackReason: resolved.fallbackReason }
			: {}),
		resolvedAt: now(),
		generation: opts.node.sessionGeneration ?? 0,
	};
	return { resolution, resolved };
}

// ─── Persona-aware seed head ─────────────────────────────────────────────────

/**
 * The persona layer of a node's seed: the playbook prompt first (the agent's
 * operating instructions — cache-stable head), then the skill names the
 * harness loaded (node skills ∪ persona frontmatter skills). The task body
 * built by the executor follows. Proper system-prompt injection can replace
 * this at the flip if the pi CLI grows the flag; content is identical.
 */
export function personaSeedHead(
	persona: Pick<Persona, "prompt" | "skills"> | undefined,
	nodeSkills: readonly string[],
): string {
	if (!persona) return "";
	const skills = [...new Set([...persona.skills, ...nodeSkills])];
	const parts = [persona.prompt.trim()];
	if (skills.length > 0)
		parts.push(`## Loaded skills\n${skills.map((s) => `- ${s}`).join("\n")}`);
	return `${parts.join("\n\n")}\n\n---\n`;
}
