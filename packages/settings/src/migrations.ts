// Reusable settings migrations — the component the #238/#239 stale-state
// incidents argued for. A migration is a pure transform over ONE settings
// file's raw object; the runner applies unapplied migrations in order per
// file (global + project), backs the file up before its first change, records
// applied ids in a per-file ledger (`settingsMigrations`), and reports
// everything fail-visible. A migration that throws stops that file's chain
// (order is a contract) and never touches the ledger, so it reruns next boot.
//
// A no-op (apply returned false) is NOT recorded and NOT persisted: recording
// it would both litter every repo with a ledger-only `.pi/settings.json` and,
// worse, permanently disarm a migration that becomes applicable later (e.g. a
// repo that gains model config after first boot). A no-op simply reruns each
// boot until it has real work — the transforms are pure and cheap.

import { copyFileSync, existsSync } from "node:fs";
import { settingsPath, updateSettingsFile } from "./writer.js";

export type SettingsScope = "global" | "project";

const LEDGER_KEY = "settingsMigrations";

export interface SettingsMigration {
	/** Unique, stable, sortable — convention: "<yyyy-mm-dd>-<slug>". */
	readonly id: string;
	readonly description: string;
	/**
	 * Mutate `raw` (one settings file's parsed object) in place. Return true
	 * when something changed, false when there was nothing to do. Must be
	 * idempotent — a false return is still recorded as applied.
	 */
	readonly apply: (
		raw: Record<string, unknown>,
		scope: SettingsScope,
	) => boolean;
}

export interface MigrationOutcome {
	readonly id: string;
	readonly scope: SettingsScope;
	readonly changed: boolean;
}

export interface MigrationFailure {
	readonly id: string;
	readonly scope: SettingsScope;
	readonly error: string;
}

export interface MigrationReport {
	readonly applied: readonly MigrationOutcome[];
	readonly failures: readonly MigrationFailure[];
	/** Backups written this run (one per file that changed), path → backup. */
	readonly backups: readonly { path: string; backupPath: string }[];
}

function ledgerOf(raw: Record<string, unknown>): string[] {
	const value = raw[LEDGER_KEY];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

/**
 * Run every unapplied migration against the global and project settings
 * files. Backups land next to the file as `<name>.bak-<migration-id>` before
 * the first change of a run — the escape hatch is a file copy, not archaeology.
 */
export function runSettingsMigrations(
	cwd: string,
	agentDir: string | undefined,
	migrations: readonly SettingsMigration[],
): MigrationReport {
	const applied: MigrationOutcome[] = [];
	const failures: MigrationFailure[] = [];
	const backups: { path: string; backupPath: string }[] = [];

	for (const scope of ["global", "project"] as const) {
		const path = settingsPath(scope, cwd, agentDir);
		for (const migration of migrations) {
			try {
				let recorded = false;
				updateSettingsFile(scope, cwd, agentDir, (raw) => {
					const ledger = ledgerOf(raw);
					if (ledger.includes(migration.id)) return false; // already applied
					if (!migration.apply(raw, scope)) return false; // no-op: don't persist
					if (existsSync(path)) {
						const backupPath = `${path}.bak-${migration.id}`;
						copyFileSync(path, backupPath);
						backups.push({ path, backupPath });
					}
					raw[LEDGER_KEY] = [...ledger, migration.id];
					recorded = true;
				});
				if (recorded) applied.push({ id: migration.id, scope, changed: true });
			} catch (error) {
				failures.push({
					id: migration.id,
					scope,
					error: error instanceof Error ? error.message : String(error),
				});
				// Order is a contract: later migrations may depend on this one.
				break;
			}
		}
	}
	return { applied, failures, backups };
}
