import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
	ChildRunProjection,
	InterruptResult,
	RunId,
	RunRecord,
} from "@vegardx/pi-contracts";
import { RUN_RECORD_SCHEMA_VERSION } from "@vegardx/pi-contracts";

export const CHILD_PROJECTION_SCHEMA_VERSION = 1 as const;

export interface HostedChildProjection {
	readonly ownerId: string;
	readonly ownerGeneration: number;
	readonly confirmed: boolean;
	readonly projection: ChildRunProjection;
}

interface ProjectionFile {
	readonly schemaVersion: typeof CHILD_PROJECTION_SCHEMA_VERSION;
	readonly records: readonly HostedChildProjection[];
}

export interface ChildProjectionControl {
	steer(
		ownerId: string,
		generation: number,
		runId: RunId,
		guidance: string,
	): void;
	interrupt(
		ownerId: string,
		generation: number,
		runId: RunId,
		reason?: string,
	): Promise<InterruptResult>;
	capture(
		ownerId: string,
		generation: number,
		runId: RunId,
		lines?: number,
	): Promise<string | undefined>;
	stop(
		ownerId: string,
		generation: number,
		runId: RunId,
		reason?: string,
	): void;
}

/** Single-writer, atomically persisted host view of worker-owned runs. */
export class ChildProjectionStore {
	private readonly records = new Map<string, HostedChildProjection>();

	constructor(private readonly path: string) {
		this.load();
	}

	list(): readonly HostedChildProjection[] {
		return [...this.records.values()];
	}

	get(runId: string): HostedChildProjection | undefined {
		return this.records.get(runId);
	}

	/** Restore is pessimistic: previously-live records await owner reconciliation. */
	markLiveUnconfirmed(): void {
		let changed = false;
		for (const [id, record] of this.records) {
			if (terminal(record.projection.status) || !record.confirmed) continue;
			this.records.set(id, { ...record, confirmed: false });
			changed = true;
		}
		if (changed) this.persist();
	}

	apply(input: {
		readonly ownerId: string;
		readonly expectedGeneration: number;
		readonly ownerGeneration: number;
		readonly reconcile: boolean;
		readonly runs: readonly ChildRunProjection[];
	}): ReadonlyArray<{ readonly runId: string; readonly revision: number }> {
		if (input.ownerGeneration !== input.expectedGeneration) return [];
		const accepted: Array<{ runId: string; revision: number }> = [];
		const seen = new Set<string>();
		for (const projection of input.runs) {
			const runId = projection.runId as string;
			seen.add(runId);
			const previous = this.records.get(runId);
			if (
				previous &&
				(previous.ownerId !== input.ownerId ||
					previous.ownerGeneration > input.ownerGeneration ||
					(previous.ownerGeneration === input.ownerGeneration &&
						previous.projection.revision > projection.revision))
			)
				continue;
			this.records.set(runId, {
				ownerId: input.ownerId,
				ownerGeneration: input.ownerGeneration,
				confirmed: true,
				projection,
			});
			accepted.push({ runId, revision: projection.revision });
		}
		if (input.reconcile) {
			for (const [runId, record] of this.records) {
				if (
					record.ownerId === input.ownerId &&
					record.ownerGeneration === input.ownerGeneration &&
					!seen.has(runId) &&
					!terminal(record.projection.status)
				) {
					this.records.set(runId, { ...record, confirmed: false });
				}
			}
		}
		// Acknowledgement is returned only after the atomic rename completes.
		this.persist();
		return accepted;
	}

	asRunRecords(): RunRecord[] {
		return this.list().map(
			({ ownerId, ownerGeneration, confirmed, projection }) => ({
				schemaVersion: RUN_RECORD_SCHEMA_VERSION,
				id: projection.runId,
				...(projection.parent ? { parent: projection.parent } : {}),
				profile: {
					profile: projection.profile.profile,
					role:
						projection.profile.role ??
						projection.metadata?.role ??
						projection.kind,
					displayName:
						projection.profile.displayName ??
						projection.metadata?.displayName ??
						`${projection.kind}-${projection.runId}`,
					model: projection.model,
					thinking: projection.effort,
					transport:
						projection.profile.transport ??
						projection.metadata?.transport ??
						"headless",
					...(projection.profile.cwd ? { cwd: projection.profile.cwd } : {}),
					...(projection.profile.rootTurnId
						? { rootTurnId: projection.profile.rootTurnId }
						: {}),
					meta: {
						ownerId,
						ownerGeneration,
						confirmed,
						kind: projection.kind,
						usage: projection.usage,
						...(projection.assignment
							? { assignment: projection.assignment }
							: {}),
					},
				},
				status: projection.status,
				createdAt: projection.createdAt,
				updatedAt: projection.updatedAt,
				...(projection.completedAt !== undefined
					? { completedAt: projection.completedAt }
					: {}),
				...(projection.lastEventAt !== undefined
					? { lastEventAt: projection.lastEventAt }
					: {}),
				...(projection.metadata ? { metadata: projection.metadata } : {}),
				...(projection.result ? { result: projection.result } : {}),
			}),
		);
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		const value = JSON.parse(readFileSync(this.path, "utf8")) as ProjectionFile;
		if (value.schemaVersion !== CHILD_PROJECTION_SCHEMA_VERSION) {
			throw new Error(
				`Unsupported child projection schema ${String(value.schemaVersion)} (expected ${CHILD_PROJECTION_SCHEMA_VERSION})`,
			);
		}
		for (const record of value.records) {
			this.records.set(record.projection.runId as string, record);
		}
		this.markLiveUnconfirmed();
	}

	private persist(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${process.pid}.tmp`;
		const value: ProjectionFile = {
			schemaVersion: CHILD_PROJECTION_SCHEMA_VERSION,
			records: this.list(),
		};
		writeFileSync(tmp, JSON.stringify(value, null, 2));
		renameSync(tmp, this.path);
	}
}

function terminal(status: ChildRunProjection["status"]): boolean {
	return ["succeeded", "failed", "stopped", "canceled", "timed-out"].includes(
		status,
	);
}
