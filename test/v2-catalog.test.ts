// v2 catalog/profile/agent-tier config: parsing, validation, merge, profile
// activation, the legacy models.profiles guard (v2 shapes pass, pre-cutover
// shapes still throw), and the new domain write keys.

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	activeV2Profile,
	readModelsConfig,
	readV2Config,
} from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeDomainValue } from "../packages/settings/src/domain.js";

let cwd: string;
let prevAgentDir: string | undefined;

const DAILY = {
	fast: [
		{
			model: "github-copilot/gpt-5.5",
			family: "openai",
			effort: "low",
			notes: "Sweeps, gates, classification.",
		},
	],
	normal: [
		{ model: "radicalai/gpt-5.6-sol", family: "openai", effort: "high" },
		{ model: "radicalai-sit/kimi-k3", family: "moonshot" },
	],
	heavy: [
		{
			model: "github-copilot/claude-opus-4.8",
			family: "anthropic",
			effort: "high",
			efforts: ["medium", "high"],
		},
	],
};

function writeSettings(models: unknown, agents?: unknown): void {
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ models, ...(agents ? { agents } : {}) }),
	);
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "v2-catalog-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, ".agent");
	mkdirSync(join(cwd, ".agent"), { recursive: true });
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	rmSync(cwd, { recursive: true, force: true });
});

describe("v2 catalog config", () => {
	it("parses catalogs, profiles, and agent tiers with defaults applied", () => {
		writeSettings(
			{
				catalog: { daily: DAILY },
				profiles: {
					fable: {
						targets: ["radicalai/eu-ndr/anthropic.claude-fable-5"],
						catalog: "daily",
					},
				},
			},
			{ worker: { models: ["normal"] } },
		);
		const config = readV2Config(cwd);
		expect(config).toBeDefined();
		expect(config?.catalogs.daily.normal).toHaveLength(2);
		expect(config?.catalogs.daily.heavy[0].family).toBe("anthropic");
		expect(config?.profiles.fable.catalog).toBe("daily");
		// Authored allowlist wins for worker; the others keep defaults.
		expect(config?.agents.worker.models).toEqual(["normal"]);
		expect(config?.agents.explorer.models).toEqual(["fast", "normal"]);
		expect(config?.agents.reviewer.models).toEqual(["normal", "heavy"]);
	});

	it("rejects unknown tiers, session refs, and duplicate models", () => {
		writeSettings({ catalog: { bad: { turbo: [] } } });
		expect(() => readV2Config(cwd)).toThrow("unknown tier turbo");

		writeSettings({ catalog: { bad: { fast: [{ model: "session" }] } } });
		expect(() => readV2Config(cwd)).toThrow("concrete provider/model");

		writeSettings({
			catalog: {
				bad: { fast: [{ model: "p/m" }, { model: "p/m" }] },
			},
		});
		expect(() => readV2Config(cwd)).toThrow("duplicate model");
	});

	it("enforces profile rules: known catalog, unique targets, one default", () => {
		writeSettings({
			catalog: { daily: DAILY },
			profiles: { fable: { catalog: "nope" } },
		});
		expect(() => readV2Config(cwd)).toThrow("unknown catalog nope");

		writeSettings({
			catalog: { daily: DAILY },
			profiles: {
				a: { targets: ["p/m"], catalog: "daily" },
				b: { targets: ["p/m"], catalog: "daily" },
			},
		});
		expect(() => readV2Config(cwd)).toThrow("overlaps");

		writeSettings({
			catalog: { daily: DAILY },
			profiles: {
				a: { catalog: "daily" },
				b: { catalog: "daily" },
			},
		});
		expect(() => readV2Config(cwd)).toThrow("only one default profile");
	});

	it("activates by target first, then the default profile", () => {
		writeSettings({
			catalog: { daily: DAILY },
			profiles: {
				fable: { targets: ["prov/fable"], catalog: "daily" },
				fallback: { catalog: "daily" },
			},
		});
		const config = readV2Config(cwd);
		expect(activeV2Profile(config, "prov/fable")?.id).toBe("fable");
		expect(activeV2Profile(config, "prov/other")?.id).toBe("fallback");
		expect(activeV2Profile(config, undefined)?.id).toBe("fallback");
	});

	it("reads canonical models.catalogs / models.agents keys (migration + editor)", () => {
		writeSettings({
			catalogs: { daily: DAILY },
			profiles: { fable: { catalog: "daily" } },
			agents: { worker: { models: ["heavy"] } },
		});
		const config = readV2Config(cwd);
		expect(Object.keys(config?.catalogs ?? {})).toEqual(["daily"]);
		expect(config?.agents.worker.models).toEqual(["heavy"]);
		// Legacy root-level agents.<type>.models is still read; models.agents wins.
		writeSettings(
			{
				catalogs: { daily: DAILY },
				profiles: { fable: { catalog: "daily" } },
				agents: { worker: { models: ["heavy"] } },
			},
			{ worker: { models: ["normal"] }, explorer: { models: ["fast"] } },
		);
		const merged = readV2Config(cwd);
		expect(merged?.agents.worker.models).toEqual(["heavy"]);
		expect(merged?.agents.explorer.models).toEqual(["fast"]);
	});

	it("merges legacy models.catalog with canonical models.catalogs, plural winning", () => {
		writeSettings({
			catalog: { legacy: DAILY, both: DAILY },
			catalogs: {
				both: { fast: [{ model: "p/canonical" }] },
			},
			profiles: { fable: { catalog: "legacy" } },
		});
		const config = readV2Config(cwd);
		expect(Object.keys(config?.catalogs ?? {}).sort()).toEqual([
			"both",
			"legacy",
		]);
		expect(config?.catalogs.both.fast).toEqual([{ model: "p/canonical" }]);
	});

	it("skips null entries (deletion markers) without failing the config", () => {
		writeSettings({
			catalog: { daily: DAILY, dead: null },
			profiles: { gone: null, live: { catalog: "daily" } },
		});
		const config = readV2Config(cwd);
		expect(Object.keys(config?.catalogs ?? {})).toEqual(["daily"]);
		expect(Object.keys(config?.profiles ?? {})).toEqual(["live"]);
	});
});

describe("legacy models.profiles guard", () => {
	it("v1 reader passes v2 profile shapes through untouched", () => {
		writeSettings({
			catalog: { daily: DAILY },
			profiles: { fable: { catalog: "daily" } },
			modelSets: {
				impl: {
					options: [{ id: "a", model: "p/m", effort: "low", summary: "s" }],
				},
			},
			presets: { main: { targets: ["p/x"], modelSets: { worker: "impl" } } },
		});
		const v1 = readModelsConfig(cwd);
		expect(Object.keys(v1?.presets ?? {})).toEqual(["main"]);
	});

	it("v1 reader still throws on pre-cutover profile shapes", () => {
		writeSettings({
			profiles: { Old: { worker: { pool: ["a", "b"] } } },
		});
		expect(() => readModelsConfig(cwd)).toThrow("pre-cutover");
	});
});

describe("domain writes for v2 keys", () => {
	function ctx() {
		return { cwd, ui: { notify: () => {} } } as never;
	}

	function agentSettings(): Record<string, unknown> {
		return JSON.parse(
			readFileSync(join(cwd, ".agent", "settings.json"), "utf-8"),
		);
	}

	it("writes a whole catalog through the validated path", () => {
		const errors = writeDomainValue(
			ctx(),
			"models.catalog.daily",
			"global",
			JSON.stringify(DAILY),
		);
		expect(errors).toEqual([]);
		const written = agentSettings() as {
			models?: { catalog?: Record<string, unknown> };
		};
		expect(written.models?.catalog?.daily).toBeDefined();
	});

	it("rejects unknown tiers and non-concrete refs at write time", () => {
		expect(
			writeDomainValue(
				ctx(),
				"models.catalog.bad",
				"global",
				JSON.stringify({ turbo: [] }),
			).join(" "),
		).toContain("unknown tier");
		expect(
			writeDomainValue(
				ctx(),
				"models.catalog.bad",
				"global",
				JSON.stringify({ fast: [{ model: "session" }] }),
			).join(" "),
		).toContain("concrete");
	});

	it("writes profiles and agent tier allowlists, rejecting bad tiers", () => {
		expect(
			writeDomainValue(
				ctx(),
				"models.profiles.fable",
				"global",
				JSON.stringify({ catalog: "daily", targets: ["p/fable"] }),
			),
		).toEqual([]);
		expect(
			writeDomainValue(
				ctx(),
				"agents.worker.models",
				"global",
				JSON.stringify(["normal", "heavy"]),
			),
		).toEqual([]);
		const written = agentSettings() as {
			models?: { profiles?: Record<string, unknown> };
			agents?: { worker?: { models?: string[] } };
		};
		expect(written.models?.profiles?.fable).toMatchObject({
			catalog: "daily",
		});
		expect(written.agents?.worker?.models).toEqual(["normal", "heavy"]);

		expect(
			writeDomainValue(
				ctx(),
				"agents.worker.models",
				"global",
				JSON.stringify(["turbo"]),
			).join(" "),
		).toContain("fast|normal|heavy");
	});
});
