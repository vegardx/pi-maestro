import type { ModeName } from "@vegardx/pi-contracts";
import { renderPlanSeed } from "./markdown.js";
import type { Plan } from "./schema.js";

export interface CompactionPolicyInput {
	readonly mode: ModeName;
	readonly executing: boolean;
}

export function shouldOwnCompaction(input: CompactionPolicyInput): boolean {
	return input.executing && (input.mode === "auto" || input.mode === "ask");
}

export interface CompactionSeedOptions {
	readonly activeDeliverableId?: string;
	readonly maxChars?: number;
}

export function buildCompactionSeed(
	plan: Plan,
	options: CompactionSeedOptions = {},
): string {
	const seed = renderPlanSeed(plan, options.activeDeliverableId);
	if (!options.maxChars || seed.length <= options.maxChars) return seed;
	return `${seed.slice(0, Math.max(0, options.maxChars - 16))}\n…[truncated]`;
}

export function buildCompactionInstructions(
	plan: Plan,
	activeDeliverableId?: string,
): string {
	return [
		"Preserve Maestro plan state exactly.",
		"Keep deliverable ids, statuses, branches, PRs, issues, summaries, and unresolved errors.",
		"Do not invent completed work-items; only carry forward decisions already recorded.",
		"",
		buildCompactionSeed(plan, { activeDeliverableId }),
	].join("\n");
}

export interface CrashSnapshotInput {
	readonly error: unknown;
	readonly mode: ModeName;
	readonly plan?: Plan;
	readonly activeDeliverableId?: string;
	readonly cwd?: string;
}

export interface CrashSnapshot {
	readonly at: string;
	readonly mode: ModeName;
	readonly cwd?: string;
	readonly planSlug?: string;
	readonly activeDeliverableId?: string;
	readonly error: string;
	readonly stack?: string;
}

export function createCrashSnapshot(
	input: CrashSnapshotInput,
	now: () => string = () => new Date().toISOString(),
): CrashSnapshot {
	const error =
		input.error instanceof Error ? input.error : new Error(String(input.error));
	return {
		at: now(),
		mode: input.mode,
		cwd: redact(input.cwd),
		planSlug: input.plan?.slug,
		activeDeliverableId: input.activeDeliverableId,
		error: redact(error.message) ?? "",
		stack: redact(error.stack),
	};
}

function redact(value: string | undefined): string | undefined {
	return value
		?.replace(/[A-Za-z0-9_=-]{32,}/g, "[redacted]")
		.replace(/(token|api[_-]?key|secret)=\S+/gi, "$1=[redacted]");
}
