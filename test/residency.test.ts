// Data-residency filtering: one active whitelist of provider/model refs
// constrains every model-set walk. "off" (alias "none") is the reserved
// no-filter state — residency has no opinion until a named list is active;
// "Global" is an ORDINARY curated list (catalogs use Global as a real
// residency category). The session sentinel is exempt (the session model is
// the user's explicit choice — the filter governs the fleet); an active
// name with no list fails CLOSED (nothing concrete passes) and is surfaced
// via residencyError.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	activeResidency,
	modelAllowedByResidency,
	readModelsConfig,
	residencyError,
	residencyNames,
	resolveExactModelSelection,
} from "../packages/models/src/index.js";

let cwd: string;
let prevAgentDir: string | undefined;

const SESSION = "ollama/local-model";

function writeSettings(models: Record<string, unknown>): void {
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ models }));
}

const MODELS = {
	modelSets: {
		pool: {
			options: [
				{
					id: "cloud",
					model: "radicalai-sit/kimi-k3",
					effort: "medium",
					summary: "Global cloud model.",
				},
				{
					id: "eu",
					model: "radicalai/eu-claude",
					effort: "medium",
					summary: "EU gateway model.",
				},
				{
					id: "own",
					model: "session",
					effort: "medium",
					summary: "Session fallback.",
				},
			],
		},
	},
	presets: {
		main: { targets: [SESSION], modelSets: { worker: "pool" } },
	},
};

function fakeCtx(): ExtensionContext {
	const entries = new Map(
		[SESSION, "radicalai-sit/kimi-k3", "radicalai/eu-claude"].map((ref) => {
			const slash = ref.indexOf("/");
			const entry = {
				provider: ref.slice(0, slash),
				id: ref.slice(slash + 1),
				name: ref,
				api: "openai-completions",
				reasoning: true,
				thinkingLevelMap: {},
			};
			return [ref, entry];
		}),
	);
	return {
		cwd,
		model: entries.get(SESSION),
		modelRegistry: {
			find: (provider: string, id: string) => entries.get(`${provider}/${id}`),
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "key",
				headers: {},
			}),
		},
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "residency-"));
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

describe("model residency", () => {
	it("filters non-matching concretes and selects within the whitelist", async () => {
		writeSettings({
			...MODELS,
			residency: {
				active: "EEA",
				lists: { EEA: ["radicalai/eu-*", "ollama/*"] },
			},
		});
		const res = await resolveExactModelSelection(fakeCtx(), {
			role: "worker",
		});
		expect(res.selected?.modelId).toBe("radicalai/eu-claude");
		const struck = res.candidates.find((c) => c.optionId === "cloud");
		expect(struck?.available).toBe(false);
		expect(struck?.reason).toBe("outside residency EEA");
	});

	it("session sentinel passes the filter even when its model would not", async () => {
		writeSettings({
			...MODELS,
			residency: {
				active: "EEA",
				// The whitelist matches NOTHING — even the session model's own ref.
				lists: { EEA: ["nothing/matches-this"] },
			},
		});
		const res = await resolveExactModelSelection(fakeCtx(), {
			role: "worker",
		});
		expect(res.selected?.modelId).toBe(SESSION);
		expect(res.selected?.optionId).toBe("own");
	});

	it("off (and alias None, any case) filters nothing", async () => {
		for (const active of ["off", "None", "OFF"]) {
			writeSettings({
				...MODELS,
				residency: { active, lists: { EEA: ["ollama/*"] } },
			});
			const res = await resolveExactModelSelection(fakeCtx(), {
				role: "worker",
			});
			expect(res.selected?.modelId).toBe("radicalai-sit/kimi-k3");
			expect(res.candidates.every((c) => c.available)).toBe(true);
		}
	});

	it("Global is an ordinary curated list, not a match-all", async () => {
		writeSettings({
			...MODELS,
			residency: {
				active: "Global",
				lists: { Global: ["radicalai-sit/kimi-k3"] },
			},
		});
		const res = await resolveExactModelSelection(fakeCtx(), {
			role: "worker",
		});
		expect(res.selected?.modelId).toBe("radicalai-sit/kimi-k3");
		const struck = res.candidates.find((c) => c.optionId === "eu");
		expect(struck?.available).toBe(false);
		expect(struck?.reason).toBe("outside residency Global");
	});

	it("fails closed on an active name with no configured list", async () => {
		writeSettings({
			...MODELS,
			residency: { active: "EAA-typo", lists: { EEA: ["ollama/*"] } },
		});
		const config = readModelsConfig(cwd);
		expect(residencyError(config)).toContain("EAA-typo");
		const res = await resolveExactModelSelection(fakeCtx(), {
			role: "worker",
		});
		// Every concrete is struck; only the session sentinel survives.
		expect(res.selected?.modelId).toBe(SESSION);
		for (const optionId of ["cloud", "eu"]) {
			const struck = res.candidates.find((c) => c.optionId === optionId);
			expect(struck?.available).toBe(false);
			expect(struck?.reason).toContain("outside residency");
		}
	});

	it("exposes names and the active value for menu/footer surfaces", () => {
		writeSettings({
			...MODELS,
			residency: { active: "EEA", lists: { EEA: ["ollama/*"] } },
		});
		const config = readModelsConfig(cwd);
		expect(residencyNames(config)).toEqual(["off", "EEA"]);
		expect(activeResidency(config)).toBe("EEA");
		expect(modelAllowedByResidency(config, "ollama/gemma4:31b-mlx")).toBe(true);
		expect(modelAllowedByResidency(config, "radicalai-sit/kimi-k3")).toBe(
			false,
		);
	});
});
