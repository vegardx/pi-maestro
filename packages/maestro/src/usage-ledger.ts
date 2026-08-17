import { refreshRun } from "@agwab/pi-workflow";
import {
	canonicalTokenSnapshot,
	type TokenSnapshot,
	type TokenSnapshotInput,
	type UsageCheckpoint,
	type UsageLedgerV1,
	type UsageSource,
	usageSourceKey,
} from "@vegardx/pi-contracts";

export interface UsageDelta {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly cost?: number;
}

interface WorkflowTaskUsage {
	readonly inputTokens?: number | null;
	readonly outputTokens?: number | null;
	readonly cacheReadInputTokens?: number | null;
	readonly cacheCreationInputTokens?: number | null;
	readonly costUsd?: number | null;
	readonly attempts?: number | readonly { readonly unavailable?: true }[];
	readonly incomplete?: boolean;
	readonly aggregate?: WorkflowTaskUsage;
}

export interface WorkflowUsageRun {
	readonly runId: string;
	readonly status: string;
	readonly tasks: readonly {
		readonly taskId: string;
		readonly status: string;
		readonly usage?: WorkflowTaskUsage;
	}[];
}

export interface UsageLedgerOptions {
	readonly now?: () => number;
	readonly pollIntervalMs?: number;
	readonly readWorkflowRun?: (
		cwd: string,
		runId: string,
	) => Promise<WorkflowUsageRun>;
	readonly onChange?: () => void;
}

const ZERO = canonicalTokenSnapshot({});
const TERMINAL_TASKS = new Set([
	"completed",
	"failed",
	"interrupted",
	"skipped",
]);
const TERMINAL_RUNS = new Set([
	"completed",
	"failed",
	"interrupted",
	"blocked",
]);

function positive(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

export function addUsage(
	previous: TokenSnapshot | undefined,
	delta: UsageDelta,
): TokenSnapshot {
	const base = previous ?? ZERO;
	return canonicalTokenSnapshot({
		input: base.input + positive(delta.input),
		output: base.output + positive(delta.output),
		cacheRead: base.cacheRead + positive(delta.cacheRead),
		cacheWrite: base.cacheWrite + positive(delta.cacheWrite),
		cost: base.cost + positive(delta.cost),
		turns: base.turns,
	});
}

export function workflowTaskSnapshot(usage: WorkflowTaskUsage): TokenSnapshot {
	const source = usage.aggregate ?? usage;
	const attempts = source.attempts;
	return canonicalTokenSnapshot({
		input: positive(source.inputTokens),
		output: positive(source.outputTokens),
		cacheRead: positive(source.cacheReadInputTokens),
		cacheWrite: positive(source.cacheCreationInputTokens),
		cost: positive(source.costUsd),
		turns: Array.isArray(attempts)
			? attempts.length
			: typeof attempts === "number"
				? attempts
				: undefined,
	});
}

function usageWasReported(usage: WorkflowTaskUsage | undefined): boolean {
	if (!usage) return false;
	const source = usage.aggregate ?? usage;
	return [
		source.inputTokens,
		source.outputTokens,
		source.cacheReadInputTokens,
		source.cacheCreationInputTokens,
		source.costUsd,
	].some((value) => typeof value === "number");
}

function usageIsIncomplete(usage: WorkflowTaskUsage): boolean {
	return (
		usage.incomplete === true ||
		usage.aggregate?.incomplete === true ||
		(Array.isArray(usage.attempts) &&
			usage.attempts.some((attempt) => attempt.unavailable === true))
	);
}

/**
 * Retry-safe central usage ledger. Every entry is cumulative and keyed by its
 * producer lifetime; recording a workflow task again replaces its prior
 * snapshot instead of adding the package rollup a second time.
 */
export class UsageLedger implements UsageLedgerV1 {
	readonly #entries = new Map<string, UsageCheckpoint>();
	readonly #unavailable = new Set<string>();
	readonly #pollers = new Map<string, ReturnType<typeof setInterval>>();
	readonly #now: () => number;
	readonly #pollIntervalMs: number;
	readonly #readWorkflowRun: (
		cwd: string,
		runId: string,
	) => Promise<WorkflowUsageRun>;
	readonly #onChange?: () => void;

	constructor(options: UsageLedgerOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
		this.#readWorkflowRun =
			options.readWorkflowRun ??
			((cwd, runId) => refreshRun(cwd, runId) as Promise<WorkflowUsageRun>);
		this.#onChange = options.onChange;
	}

	record(source: UsageSource, snapshot: TokenSnapshotInput): void {
		const key = usageSourceKey(source);
		const revision = (this.#entries.get(key)?.revision ?? 0) + 1;
		this.recordCheckpoint({
			source,
			revision,
			snapshot: canonicalTokenSnapshot(snapshot),
			updatedAt: this.#now(),
		});
	}

	recordUnavailable(source: UsageSource): void {
		const key = usageSourceKey(source);
		if (this.#unavailable.has(key)) return;
		this.#unavailable.add(key);
		this.#onChange?.();
	}

	recordCheckpoint(checkpoint: UsageCheckpoint): boolean {
		if (!Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1)
			return false;
		const key = usageSourceKey(checkpoint.source);
		const current = this.#entries.get(key);
		if (current && checkpoint.revision <= current.revision) return false;
		this.#entries.set(key, {
			...checkpoint,
			snapshot: canonicalTokenSnapshot(checkpoint.snapshot),
		});
		this.#onChange?.();
		return true;
	}

	add(source: UsageSource, delta: UsageDelta): void {
		const key = usageSourceKey(source);
		this.record(source, addUsage(this.#entries.get(key)?.snapshot, delta));
	}

	incrementTurns(source: UsageSource): void {
		const key = usageSourceKey(source);
		const previous = this.#entries.get(key)?.snapshot ?? ZERO;
		this.record(source, { ...previous, turns: previous.turns + 1 });
	}

	async ingestWorkflowRun(cwd: string, runId: string): Promise<boolean> {
		const run = await this.#readWorkflowRun(cwd, runId);
		if (run.runId !== runId)
			throw new Error(`workflow usage run identity mismatch: ${run.runId}`);
		for (const task of run.tasks) {
			const source: UsageSource = {
				kind: "run",
				ownerId: runId,
				id: task.taskId,
			};
			if (usageWasReported(task.usage)) {
				this.record(
					source,
					workflowTaskSnapshot(task.usage as WorkflowTaskUsage),
				);
				if (usageIsIncomplete(task.usage as WorkflowTaskUsage))
					this.recordUnavailable(source);
			} else if (TERMINAL_TASKS.has(task.status)) {
				this.recordUnavailable(source);
			}
		}
		return TERMINAL_RUNS.has(run.status);
	}

	trackWorkflowRun(cwd: string, runId: string): () => void {
		const key = `${cwd}\0${runId}`;
		let stopped = false;
		const stop = () => {
			if (stopped) return;
			stopped = true;
			const timer = this.#pollers.get(key);
			if (timer) clearInterval(timer);
			this.#pollers.delete(key);
		};
		if (this.#pollers.has(key)) return stop;
		const poll = () => {
			void this.ingestWorkflowRun(cwd, runId)
				.then((terminal) => {
					if (terminal) stop();
				})
				.catch(() => {
					// A partially-written run record or supervisor startup race is not an
					// unavailable provider report. The next poll gets another chance.
				});
		};
		const timer = setInterval(poll, this.#pollIntervalMs);
		timer.unref?.();
		this.#pollers.set(key, timer);
		poll();
		return stop;
	}

	dispose(): void {
		for (const timer of this.#pollers.values()) clearInterval(timer);
		this.#pollers.clear();
	}

	snapshot(): {
		bySource: ReadonlyMap<string, TokenSnapshot>;
		unavailableSources: ReadonlySet<string>;
		totals: TokenSnapshot;
	} {
		const bySource = new Map<string, TokenSnapshot>();
		let totals: TokenSnapshot = ZERO;
		for (const [key, checkpoint] of this.#entries) {
			bySource.set(key, checkpoint.snapshot);
			totals = addUsage(totals, checkpoint.snapshot);
			totals = canonicalTokenSnapshot({
				...totals,
				turns: totals.turns + checkpoint.snapshot.turns,
			});
		}
		return {
			bySource,
			unavailableSources: new Set(this.#unavailable),
			totals,
		};
	}
}
