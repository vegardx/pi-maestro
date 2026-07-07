import {
	type TokenSnapshot,
	type UsageLedgerV1,
	type UsageSource,
	usageSourceKey,
} from "@vegardx/pi-contracts";

/** A partial pi-ai Usage (tokens + pre-computed cost). */
export interface UsageDelta {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly cost?: { readonly total?: number };
}

const ZERO: TokenSnapshot = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
	turns: 0,
};

/** Add a per-response Usage to a cumulative snapshot. Does NOT increment turns
 * (caller controls that — a turn can contain many assistant messages). */
export function accumulate(
	prev: TokenSnapshot | undefined,
	usage: UsageDelta,
): TokenSnapshot {
	const base = prev ?? ZERO;
	const input = base.input + (usage.input ?? 0);
	const output = base.output + (usage.output ?? 0);
	return {
		input,
		output,
		cacheRead: base.cacheRead + (usage.cacheRead ?? 0),
		cacheWrite: base.cacheWrite + (usage.cacheWrite ?? 0),
		totalTokens: input + output,
		cost: base.cost + (usage.cost?.total ?? 0),
		turns: base.turns,
	};
}

/** Increment the turn counter on a snapshot. Call once per actual turn_end. */
export function incrementTurns(prev: TokenSnapshot): TokenSnapshot {
	return { ...prev, turns: prev.turns + 1 };
}

/**
 * Central usage ledger (usage.v1). Every source records its cumulative
 * snapshot; `snapshot()` aggregates them so cost/tokens are attributable.
 */
export class UsageLedger implements UsageLedgerV1 {
	private bySource = new Map<string, TokenSnapshot>();

	record(source: UsageSource, snapshot: TokenSnapshot): void {
		this.bySource.set(usageSourceKey(source), snapshot);
	}

	/** Fold a per-turn delta into a source's snapshot (counts as one turn).
	 * For sources that report deltas (research children) rather than
	 * cumulative state (execution agents, which use record()). */
	add(source: UsageSource, delta: UsageDelta): void {
		const key = usageSourceKey(source);
		this.bySource.set(
			key,
			incrementTurns(accumulate(this.bySource.get(key), delta)),
		);
	}

	snapshot(): {
		bySource: ReadonlyMap<string, TokenSnapshot>;
		totals: TokenSnapshot;
	} {
		let totals = ZERO;
		for (const s of this.bySource.values()) {
			totals = {
				input: totals.input + s.input,
				output: totals.output + s.output,
				cacheRead: totals.cacheRead + s.cacheRead,
				cacheWrite: totals.cacheWrite + s.cacheWrite,
				totalTokens: totals.totalTokens + s.totalTokens,
				cost: totals.cost + s.cost,
				turns: totals.turns + s.turns,
			};
		}
		return { bySource: new Map(this.bySource), totals };
	}
}
