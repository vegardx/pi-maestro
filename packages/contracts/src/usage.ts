// Token/cost accounting vocabulary. Snapshots are cumulative per source.
//
// Provider token categories are disjoint: `input` is uncached prompt input,
// `cacheRead` is prompt input served from cache, `cacheWrite` is prompt input
// written to cache, and `output` is completion output. Derived fields are never
// trusted from providers:
//
//   promptTokens = input + cacheRead + cacheWrite
//   totalTokens  = promptTokens + output

export interface TokenSnapshot {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly promptTokens: number;
	readonly totalTokens: number;
	readonly cost: number;
	readonly turns: number;
}

export type TokenSnapshotInput = Partial<TokenSnapshot>;

function counter(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

/** Normalize raw counters and derive canonical prompt/total arithmetic. */
export function canonicalTokenSnapshot(
	value: TokenSnapshotInput,
): TokenSnapshot {
	const input = counter(value.input);
	const output = counter(value.output);
	const cacheRead = counter(value.cacheRead);
	const cacheWrite = counter(value.cacheWrite);
	const promptTokens = input + cacheRead + cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		promptTokens,
		totalTokens: promptTokens + output,
		cost: counter(value.cost),
		turns: counter(value.turns),
	};
}

/** A cumulative counter lifetime. Generation prevents restart overwrites. */
export type UsageSource =
	| { readonly kind: "maestro" }
	| {
			readonly kind: "agent";
			readonly id: string;
			readonly generation?: number;
	  }
	| {
			readonly kind: "run";
			readonly id: string;
			readonly ownerId?: string;
			/** Fences stale owners but is deliberately excluded from the source key. */
			readonly ownerGeneration?: number;
	  };

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
