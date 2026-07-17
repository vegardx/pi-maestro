import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { type UsageCheckpoint, usageSourceKey } from "@vegardx/pi-contracts";
import { normalizeSnapshot } from "./usage-ledger.js";

export const USAGE_CHECKPOINT_SCHEMA_VERSION = 1 as const;

interface UsageCheckpointFile {
	readonly schemaVersion: typeof USAGE_CHECKPOINT_SCHEMA_VERSION;
	readonly checkpoints: readonly UsageCheckpoint[];
}

/** Single-writer atomic store for execution-lifetime cumulative checkpoints. */
export class UsageCheckpointStore {
	private readonly bySource = new Map<string, UsageCheckpoint>();

	constructor(readonly path: string) {}

	load(): readonly UsageCheckpoint[] {
		this.bySource.clear();
		if (!existsSync(this.path)) return [];
		let value: UsageCheckpointFile;
		try {
			value = JSON.parse(
				readFileSync(this.path, "utf8"),
			) as UsageCheckpointFile;
		} catch {
			return [];
		}
		if (
			value.schemaVersion !== USAGE_CHECKPOINT_SCHEMA_VERSION ||
			!Array.isArray(value.checkpoints)
		)
			throw new Error(
				`Unsupported Maestro usage checkpoint schema ${String(value.schemaVersion)} ` +
					`(expected ${USAGE_CHECKPOINT_SCHEMA_VERSION}).`,
			);
		for (const checkpoint of value.checkpoints) {
			if (!Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1)
				continue;
			const normalized: UsageCheckpoint = {
				...checkpoint,
				snapshot: normalizeSnapshot(checkpoint.snapshot),
			};
			const key = usageSourceKey(checkpoint.source);
			const current = this.bySource.get(key);
			if (!current || normalized.revision > current.revision)
				this.bySource.set(key, normalized);
		}
		return [...this.bySource.values()];
	}

	/** Persist before returning acceptance; equal/regressive revisions are no-ops. */
	accept(checkpoint: UsageCheckpoint): boolean {
		const key = usageSourceKey(checkpoint.source);
		const current = this.bySource.get(key);
		if (current && checkpoint.revision <= current.revision) return false;
		this.bySource.set(key, {
			...checkpoint,
			snapshot: normalizeSnapshot(checkpoint.snapshot),
		});
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${process.pid}.tmp`;
		const file: UsageCheckpointFile = {
			schemaVersion: USAGE_CHECKPOINT_SCHEMA_VERSION,
			checkpoints: [...this.bySource.values()],
		};
		writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		renameSync(tmp, this.path);
		return true;
	}
}
