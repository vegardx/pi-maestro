// v2 model config (families/rosters/bindings/region/allowances): parsing,
// validation, merge, binding activation, null deletion markers, and the domain
// write keys the /maestro editor persists through.

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
	activeV2Binding,
	familyOfModel,
	readV2Config,
} from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeDomainValue } from "../packages/settings/src/domain.js";

let cwd: string;
let prevAgentDir: string | undefined;

const FAMILIES = {
	OpenAI: {
		aliases: {
			"GPT 5.6 Sol": {
				attach: ["radicalai/gpt-5.6-sol", "github-copilot/gpt-5.5"],
				effort: "high",
				efforts: ["medium", "high"],
				notes: "Daily driver.",
			},
		},
	},
	Anthropic: {
		aliases: {
			"Opus 4.8": { attach: ["github-copilot/claude-opus-4.8"] },
		},
	},
};

const ROSTERS = {
	daily: {
		light: ["OpenAI/GPT 5.6 Sol"],
		standard: ["OpenAI/GPT 5.6 Sol", "Anthropic/Opus 4.8"],
		heavy: ["Anthropic/Opus 4.8"],
	},
};

function writeSettings(models: unknown): void {
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ models }));
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

describe("v2 model config", () => {
	it("parses families, rosters, bindings, and allowances with defaults applied", () => {
		writeSettings({
			families: FAMILIES,
			rosters: ROSTERS,
			bindings: { main: { roster: "daily" } },
			allowances: { worker: { tiers: ["standard"] } },
		});
		const config = readV2Config(cwd);
		expect(config).toBeDefined();
		expect(Object.keys(config?.families ?? {})).toEqual([
			"OpenAI",
			"Anthropic",
		]);
		expect(config?.families.OpenAI.aliases["GPT 5.6 Sol"].attach).toHaveLength(
			2,
		);
		expect(config?.rosters.daily.standard).toHaveLength(2);
		expect(config?.bindings.main.roster).toBe("daily");
		// Authored allowance wins for worker; the rest keep defaults.
		expect(config?.allowances.worker.tiers).toEqual(["standard"]);
		expect(config?.allowances.explorer.tiers).toEqual(["light", "standard"]);
		expect(config?.allowances.advisor.tiers).toEqual(["heavy", "standard"]);
	});

	it("preserves family insertion order (the diversity rank)", () => {
		writeSettings({
			families: {
				Grok: { aliases: { A: { attach: ["p/grok"] } } },
				OpenAI: { aliases: { B: { attach: ["p/gpt"] } } },
			},
		});
		expect(Object.keys(readV2Config(cwd)?.families ?? {})).toEqual([
			"Grok",
			"OpenAI",
		]);
	});

	it("rejects bad shapes: empty attach, no aliases, unknown tier, bad ref, dup", () => {
		writeSettings({ families: { F: { aliases: { A: { attach: [] } } } } });
		expect(() => readV2Config(cwd)).toThrow("attach must be");

		writeSettings({ families: { F: { aliases: {} } } });
		expect(() => readV2Config(cwd)).toThrow("has no aliases");

		writeSettings({
			families: FAMILIES,
			rosters: { bad: { turbo: [] } },
		});
		expect(() => readV2Config(cwd)).toThrow("unknown tier turbo");

		writeSettings({
			families: FAMILIES,
			rosters: { bad: { standard: ["noslash"] } },
		});
		expect(() => readV2Config(cwd)).toThrow('"Family/Alias" ref');

		writeSettings({
			families: FAMILIES,
			rosters: {
				bad: { standard: ["OpenAI/GPT 5.6 Sol", "OpenAI/GPT 5.6 Sol"] },
			},
		});
		expect(() => readV2Config(cwd)).toThrow("duplicate ref");
	});

	it("cross-validates roster refs, binding rosters, targets, and default count", () => {
		writeSettings({
			families: FAMILIES,
			rosters: { daily: { standard: ["OpenAI/Missing"] } },
		});
		expect(() => readV2Config(cwd)).toThrow("unknown alias OpenAI/Missing");

		writeSettings({
			families: FAMILIES,
			rosters: ROSTERS,
			bindings: { main: { roster: "nope" } },
		});
		expect(() => readV2Config(cwd)).toThrow("unknown roster nope");

		writeSettings({
			families: FAMILIES,
			rosters: ROSTERS,
			bindings: {
				a: { roster: "daily", targets: ["p/m"] },
				b: { roster: "daily", targets: ["p/m"] },
			},
		});
		expect(() => readV2Config(cwd)).toThrow("overlaps");

		writeSettings({
			families: FAMILIES,
			rosters: ROSTERS,
			bindings: { a: { roster: "daily" }, b: { roster: "daily" } },
		});
		expect(() => readV2Config(cwd)).toThrow("only one default binding");
	});

	it("rejects an active region with no configured list", () => {
		writeSettings({
			families: FAMILIES,
			region: { active: "EEA", lists: {} },
		});
		expect(() => readV2Config(cwd)).toThrow("Active region EEA");
	});

	it("activates a binding by target first, then the default", () => {
		writeSettings({
			families: FAMILIES,
			rosters: ROSTERS,
			bindings: {
				pinned: { targets: ["prov/fable"], roster: "daily" },
				fallback: { roster: "daily" },
			},
		});
		const config = readV2Config(cwd);
		expect(activeV2Binding(config, "prov/fable")?.id).toBe("pinned");
		expect(activeV2Binding(config, "prov/other")?.id).toBe("fallback");
		expect(activeV2Binding(config, undefined)?.id).toBe("fallback");
	});

	it("looks a model up to its family/alias (author-family, footer identity)", () => {
		writeSettings({ families: FAMILIES });
		const config = readV2Config(cwd);
		expect(familyOfModel(config, "github-copilot/gpt-5.5")).toEqual({
			family: "OpenAI",
			alias: "GPT 5.6 Sol",
		});
		expect(familyOfModel(config, "p/unknown")).toBeUndefined();
	});

	it("skips null entries (deletion markers) without failing the config", () => {
		writeSettings({
			families: { ...FAMILIES, Dead: null },
			rosters: ROSTERS,
			bindings: { main: { roster: "daily" }, gone: null },
		});
		const config = readV2Config(cwd);
		expect(Object.keys(config?.families ?? {})).toEqual([
			"OpenAI",
			"Anthropic",
		]);
		expect(Object.keys(config?.bindings ?? {})).toEqual(["main"]);
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

	function write(key: string, value: unknown): string[] {
		return writeDomainValue(ctx(), key, "global", JSON.stringify(value));
	}

	it("writes a whole family and a single alias through the validated path", () => {
		expect(write("models.families.OpenAI", FAMILIES.OpenAI)).toEqual([]);
		expect(
			write("models.families.OpenAI.aliases.Mini", {
				attach: ["p/mini"],
			}),
		).toEqual([]);
		const written = agentSettings() as {
			models?: {
				families?: Record<string, { aliases?: Record<string, unknown> }>;
			};
		};
		expect(written.models?.families?.OpenAI?.aliases?.Mini).toBeDefined();
	});

	it("writes rosters, bindings, allowances, and region, rejecting bad shapes", () => {
		expect(write("models.families.OpenAI", FAMILIES.OpenAI)).toEqual([]);
		expect(
			write("models.rosters.daily.standard", ["OpenAI/GPT 5.6 Sol"]),
		).toEqual([]);
		expect(write("models.bindings.main", { roster: "daily" })).toEqual([]);
		expect(write("models.allowances.worker", { tiers: ["standard"] })).toEqual(
			[],
		);
		expect(write("models.region.active", "off")).toEqual([]);

		expect(write("models.rosters.bad.turbo", ["A/B"]).join(" ")).toContain(
			"unknown tier",
		);
		expect(
			write("models.rosters.bad.standard", ["noslash"]).join(" "),
		).toContain('"Family/Alias"');
		expect(
			write("models.allowances.worker", { tiers: ["turbo"] }).join(" "),
		).toContain("light|standard|heavy");
	});
});
