// Token/cost accounting vocabulary. A TokenSnapshot is a cumulative usage
// reading for one source; the usage.v1 ledger (see capabilities.ts) aggregates
// snapshots by source (maestro, agent) so accounting is real and
// attributable. Cost is pre-computed upstream (pi-ai Usage.cost.total).

export interface TokenSnapshot {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: number;
	readonly turns: number;
}

/** Who produced a usage reading. Keyed for the ledger's per-source map. */
export type UsageSource =
	| { readonly kind: "maestro" }
	| { readonly kind: "agent"; readonly id: string };

/** Stable string key for a UsageSource (ledger map key). */
export function usageSourceKey(source: UsageSource): string {
	switch (source.kind) {
		case "maestro":
			return "maestro";
		case "agent":
			return `agent:${source.id}`;
	}
}
