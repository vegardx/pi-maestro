// Token/cost accounting vocabulary. Snapshots are cumulative per source.

export interface TokenSnapshot {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: number;
	readonly turns: number;
}

/** A cumulative counter lifetime. Generation prevents restart overwrites. */
export type UsageSource =
	| { readonly kind: "maestro" }
	| {
			readonly kind: "agent";
			readonly id: string;
			readonly generation?: number;
	  }
	| { readonly kind: "run"; readonly id: string; readonly ownerId?: string };

export function usageSourceKey(source: UsageSource): string {
	switch (source.kind) {
		case "maestro":
			return "maestro";
		case "agent":
			return source.generation === undefined
				? `agent:${source.id}`
				: `agent:${source.id}:generation:${source.generation}`;
		case "run":
			return source.ownerId
				? `run:${source.ownerId}:${source.id}`
				: `run:${source.id}`;
	}
}

/** Durable, retry-safe usage checkpoint for one producer. */
export interface UsageCheckpoint {
	readonly source: UsageSource;
	readonly revision: number;
	readonly snapshot: TokenSnapshot;
	readonly updatedAt: number;
}
