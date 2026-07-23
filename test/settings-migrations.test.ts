// The reusable settings-migration component (#238/#239 follow-up) + the
// v1→v2 models migration. Pins: per-file ledger (applied once, ever), backup
// before first change, failures stop the chain WITHOUT ledger entries (retry
// next run), additive v2 derivation that never touches hand-authored v2.

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildV2FromV1, MODELS_V2_MIGRATION } from "@vegardx/pi-models";
import {
	runSettingsMigrations,
	type SettingsMigration,
} from "@vegardx/pi-settings";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;
let cwd: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "mig-home-"));
	cwd = mkdtempSync(join(tmpdir(), "mig-cwd-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

function readGlobal(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
}

function writeGlobal(value: unknown): void {
	writeFileSync(join(home, "settings.json"), JSON.stringify(value, null, 2));
}

const bump: SettingsMigration = {
	id: "2026-01-01-bump",
	description: "test bump",
	apply: (raw) => {
		raw.bumped = ((raw.bumped as number) ?? 0) + 1;
		return true;
	},
};

describe("runSettingsMigrations", () => {
	it("applies once, records the ledger, and backs up before the change", () => {
		writeGlobal({ existing: true });
		const first = runSettingsMigrations(cwd, home, [bump]);
		expect(first.applied).toContainEqual(
			expect.objectContaining({ id: bump.id, scope: "global", changed: true }),
		);
		expect(first.backups.some((b) => b.backupPath.includes(".bak-"))).toBe(
			true,
		);
		const backup = first.backups.find((b) =>
			b.path.startsWith(home),
		)?.backupPath;
		expect(backup && existsSync(backup)).toBe(true);
		// The backup holds the PRE-migration content.
		expect(JSON.parse(readFileSync(backup as string, "utf8"))).toEqual({
			existing: true,
		});
		const after = readGlobal();
		expect(after.bumped).toBe(1);
		expect(after.settingsMigrations).toEqual([bump.id]);

		// Second run: ledgered, untouched, no new backup.
		const second = runSettingsMigrations(cwd, home, [bump]);
		expect(second.applied.filter((a) => a.scope === "global")).toHaveLength(0);
		expect(readGlobal().bumped).toBe(1);
	});

	it("a no-op migration is neither recorded nor materializes a file", () => {
		const noop: SettingsMigration = {
			id: "2026-01-02-noop",
			description: "nothing to do",
			apply: () => false,
		};
		const report = runSettingsMigrations(cwd, home, [noop]);
		// Not reported as applied, and no ledger-only settings file created…
		expect(report.applied).toEqual([]);
		expect(existsSync(join(home, "settings.json"))).toBe(false);
		expect(existsSync(join(cwd, ".pi", "settings.json"))).toBe(false);
		// …so it stays armed: a later run that DOES have work applies it.
		writeGlobal({ existing: true });
		const bumpNoop: SettingsMigration = { ...noop, apply: () => true };
		runSettingsMigrations(cwd, home, [bumpNoop]);
		expect(readGlobal().settingsMigrations).toEqual([noop.id]);
	});

	it("booting in a repo with nothing to migrate leaves it untouched", () => {
		// The regression: the project scope is <cwd>/.pi/settings.json. A no-op
		// migration must not litter every repo with a ledger-only file.
		const report = runSettingsMigrations(cwd, home, [MODELS_V2_MIGRATION]);
		expect(report.failures).toEqual([]);
		expect(report.applied).toEqual([]);
		expect(existsSync(join(cwd, ".pi", "settings.json"))).toBe(false);
		expect(existsSync(join(home, "settings.json"))).toBe(false);
	});

	it("a throwing migration stops the file's chain without a ledger entry", () => {
		const boom: SettingsMigration = {
			id: "2026-01-03-boom",
			description: "fails",
			apply: () => {
				throw new Error("cannot parse");
			},
		};
		const report = runSettingsMigrations(cwd, home, [boom, bump]);
		const globalFailures = report.failures.filter((f) => f.scope === "global");
		expect(globalFailures).toEqual([
			expect.objectContaining({ id: boom.id, error: "cannot parse" }),
		]);
		// bump did NOT run after the failure (order is a contract)…
		const raw = existsSync(join(home, "settings.json")) ? readGlobal() : {};
		expect(raw.bumped).toBeUndefined();
		// …and boom is not ledgered, so it retries next run.
		expect(raw.settingsMigrations ?? []).toEqual([]);
	});
});

const V1_MODELS = {
	presets: {
		"radicalai-sit": {
			targets: ["sit-anthropic/claude-opus-4-8"],
			modelSets: {
				worker: "workers",
				classifier: "fast-pool",
				"plan-summarizer": "fast-pool",
				verifier: "review-pool",
				"security-review": "review-pool",
			},
		},
	},
	modelSets: {
		workers: {
			options: [
				{ id: "sol", model: "sit-openai/gpt-5.6-sol", effort: "medium" },
				{ id: "session", model: "session", effort: "auto" },
			],
		},
		"fast-pool": {
			options: [
				{ id: "luna", model: "sit-openai/gpt-5.6-luna", effort: "low" },
			],
		},
		"review-pool": {
			options: [
				{ id: "opus", model: "sit-anthropic/claude-opus-4-8", effort: "high" },
				{ id: "sol2", model: "sit-openai/gpt-5.6-sol", effort: "auto" },
			],
		},
	},
};

describe("the v1→v2 models migration", () => {
	it("derives catalogs/profiles: role→tier mapping, sentinel and auto dropped", () => {
		const built = buildV2FromV1(structuredClone(V1_MODELS) as never);
		expect(built).not.toBeNull();
		expect(built?.profiles).toEqual({
			"radicalai-sit": {
				targets: ["sit-anthropic/claude-opus-4-8"],
				catalog: "radicalai-sit",
			},
		});
		const tiers = built?.catalogs["radicalai-sit"];
		expect(tiers?.fast).toEqual([
			{ model: "sit-openai/gpt-5.6-luna", effort: "low" },
		]);
		// The session sentinel is dropped; sol keeps its concrete effort.
		expect(tiers?.normal).toEqual([
			{ model: "sit-openai/gpt-5.6-sol", effort: "medium" },
		]);
		// Dedup within a tier; "auto" effort dropped.
		expect(tiers?.heavy).toEqual([
			{ model: "sit-anthropic/claude-opus-4-8", effort: "high" },
			{ model: "sit-openai/gpt-5.6-sol" },
		]);
	});

	it("never touches hand-authored v2 and skips all-sentinel presets", () => {
		expect(
			buildV2FromV1({
				...structuredClone(V1_MODELS),
				catalogs: { mine: {} },
			} as never),
		).toBeNull();
		const built = buildV2FromV1({
			presets: {
				sessionOnly: { targets: [], modelSets: { worker: "s" } },
			},
			modelSets: { s: { options: [{ model: "session" }] } },
		} as never);
		expect(built).toBeNull();
	});

	it("end to end through the runner: additive, v1 kept, ledgered", () => {
		writeGlobal({ models: structuredClone(V1_MODELS) });
		const report = runSettingsMigrations(cwd, home, [MODELS_V2_MIGRATION]);
		expect(report.failures).toEqual([]);
		const models = readGlobal().models as Record<string, unknown>;
		expect(models.presets).toBeDefined(); // v1 kept for fallback paths
		expect(models.catalogs).toBeDefined();
		expect(models.profiles).toBeDefined();
		expect(readGlobal().settingsMigrations).toEqual([MODELS_V2_MIGRATION.id]);
	});
});

describe("explainModelSelectionV2 rendering", () => {
	it("explains inheritance-only when no v2 config exists", async () => {
		const { explainModelSelectionV2 } = await import("@vegardx/pi-settings");
		const text = await explainModelSelectionV2(
			{
				cwd,
				model: { provider: "sit-anthropic", id: "claude-opus-4-8" },
			} as never,
			"worker",
		);
		expect(text).toContain(
			"Seat (session model): sit-anthropic/claude-opus-4-8",
		);
		expect(text).toContain("INHERITS");
		expect(text).toContain("No v2 catalogs/profiles configured");
	});
});
