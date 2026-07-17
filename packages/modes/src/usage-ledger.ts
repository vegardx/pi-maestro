import {
	canonicalTokenSnapshot,
	type TokenSnapshot,
	type UsageCheckpoint,
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

const ZERO = canonicalTokenSnapshot({});

const rawCounter = (value: number | undefined): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Add a per-response Usage to a cumulative snapshot. Does NOT increment turns
 * (caller controls that — a turn can contain many assistant messages). */
export function accumulate(
	prev: TokenSnapshot | undefined,
	usage: UsageDelta,
): TokenSnapshot {
	const base = prev ?? ZERO;
	return canonicalTokenSnapshot({
		input: base.input + rawCounter(usage.input),
		output: base.output + rawCounter(usage.output),
		cacheRead: base.cacheRead + rawCounter(usage.cacheRead),
		cacheWrite: base.cacheWrite + rawCounter(usage.cacheWrite),
		cost: base.cost + rawCounter(usage.cost?.total),
		turns: base.turns,
	});
}

/** Increment the turn counter on a snapshot. Call once per actual turn_end. */
export function incrementTurns(prev: TokenSnapshot): TokenSnapshot {
	return canonicalTokenSnapshot({ ...prev, turns: prev.turns + 1 });
}

/**
 * Coerce a raw or partial snapshot into canonical disjoint token categories.
 * Supplied prompt/total fields are ignored because providers disagree about
 * whether cache buckets are included in `totalTokens`.
 */
export function normalizeSnapshot(
	snapshot: Partial<TokenSnapshot>,
): TokenSnapshot {
	return canonicalTokenSnapshot(snapshot);
}

export interface UsageLedgerOptions {
	/** Called after an accepted checkpoint; persistence can remain outside core. */
	readonly onAccepted?: (checkpoint: UsageCheckpoint) => void;
	readonly now?: () => number;
}

interface LedgerEntry {
	readonly checkpoint: UsageCheckpoint;
	readonly ownerGeneration?: number;
}

/**
 * Central usage ledger (usage.v1). Each source is one cumulative counter
 * lifetime. Checkpoints are revisioned, monotonic, and safe to replay.
 */
export class UsageLedger implements UsageLedgerV1 {
	private readonly entries = new Map<string, LedgerEntry>();
	private readonly onAccepted?: (checkpoint: UsageCheckpoint) => void;
	private readonly now: () => number;

	constructor(options: UsageLedgerOptions = {}) {
		this.onAccepted = options.onAccepted;
		this.now = options.now ?? Date.now;
	}

	/** Compatibility ingestion for local cumulative sources. */
	record(source: UsageSource, snapshot: Partial<TokenSnapshot>): void {
		const key = usageSourceKey(source);
		const revision = (this.entries.get(key)?.checkpoint.revision ?? 0) + 1;
		this.recordCheckpoint({
			source,
			revision,
			snapshot: normalizeSnapshot(snapshot),
			updatedAt: this.now(),
		});
	}

	/** Accept a cumulative checkpoint only when its revision and owner are fresh. */
	recordCheckpoint(checkpoint: UsageCheckpoint): boolean {
		if (!Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1)
			return false;
		const source = checkpoint.source;
		const key = usageSourceKey(source);
		const current = this.entries.get(key);
		const ownerGeneration =
			source.kind === "run" ? source.ownerGeneration : undefined;
		if (
			current?.ownerGeneration !== undefined &&
			ownerGeneration !== undefined &&
			ownerGeneration < current.ownerGeneration
		)
			return false;
		if (
			current &&
			(current.ownerGeneration === ownerGeneration ||
				ownerGeneration === undefined ||
				current.ownerGeneration === undefined) &&
			checkpoint.revision <= current.checkpoint.revision
		)
			return false;

		const normalized: UsageCheckpoint = {
			...checkpoint,
			snapshot: normalizeSnapshot(checkpoint.snapshot),
		};
		// Persistence is authoritative: write before publishing the in-memory
		// projection so a failed atomic checkpoint cannot be acknowledged.
		this.onAccepted?.(normalized);
		this.entries.set(key, { checkpoint: normalized, ownerGeneration });
		return true;
	}

	/** Restore persisted state without writing it back through the persistence hook. */
	restore(checkpoints: readonly UsageCheckpoint[]): number {
		let restored = 0;
		for (const checkpoint of checkpoints) {
			// Inline acceptance avoids replaying restored checkpoints to disk.
			const key = usageSourceKey(checkpoint.source);
			const current = this.entries.get(key);
			const ownerGeneration =
				checkpoint.source.kind === "run"
					? checkpoint.source.ownerGeneration
					: undefined;
			if (
				!Number.isSafeInteger(checkpoint.revision) ||
				checkpoint.revision < 1 ||
				(current && checkpoint.revision <= current.checkpoint.revision)
			)
				continue;
			this.entries.set(key, {
				checkpoint: {
					...checkpoint,
					snapshot: normalizeSnapshot(checkpoint.snapshot),
				},
				ownerGeneration,
			});
			restored++;
		}
		return restored;
	}

	/** Fold a local per-turn delta into a run source and count one turn. */
	add(source: UsageSource, delta: UsageDelta): void {
		const key = usageSourceKey(source);
		const current = this.entries.get(key)?.checkpoint;
		const snapshot = incrementTurns(accumulate(current?.snapshot, delta));
		this.recordCheckpoint({
			source,
			revision: (current?.revision ?? 0) + 1,
			snapshot,
			updatedAt: this.now(),
		});
	}

	checkpoints(): readonly UsageCheckpoint[] {
		return [...this.entries.values()].map(({ checkpoint }) => checkpoint);
	}

	snapshot(): {
		bySource: ReadonlyMap<string, TokenSnapshot>;
		totals: TokenSnapshot;
	} {
		const bySource = new Map<string, TokenSnapshot>();
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;
		let turns = 0;
		for (const [key, { checkpoint }] of this.entries) {
			const s = checkpoint.snapshot;
			bySource.set(key, s);
			input += s.input;
			output += s.output;
			cacheRead += s.cacheRead;
			cacheWrite += s.cacheWrite;
			cost += s.cost;
			turns += s.turns;
		}
		return {
			bySource,
			totals: canonicalTokenSnapshot({
				input,
				output,
				cacheRead,
				cacheWrite,
				cost,
				turns,
			}),
		};
	}
}
