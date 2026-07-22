// The v2 inheritance-first resolver: inherit by default, tier resolution
// through profile→catalog ∩ residency ∩ agent allowlist, session fallback
// with a visible reason, effort clamping, and explain output.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	explainTier,
	fallbackNotice,
	resolveV2Model,
	V2ResolutionError,
} from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let cwd: string;
let prevAgentDir: string | undefined;

const SETTINGS = {
	models: {
		catalog: {
			daily: {
				fast: [{ model: "prov/quick", family: "openai", effort: "low" }],
				normal: [
					{
						model: "prov/sol",
						family: "openai",
						effort: "high",
						efforts: ["medium", "high"],
					},
					{ model: "prov/kimi", family: "moonshot" },
				],
				heavy: [{ model: "prov/opus", family: "anthropic", effort: "high" }],
			},
		},
		profiles: {
			main: { targets: ["prov/seat"], catalog: "daily" },
		},
		residency: { lists: { EEA: ["prov/sol", "prov/seat"] } },
	},
};

function writeSettings(settings: unknown): void {
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
}

/** Registry with every prov/* model known; `unavailable` fail auth. */
function fakeCtx(options: { unavailable?: readonly string[] } = {}) {
	const unavailable = new Set(options.unavailable ?? []);
	const model = (id: string) => ({
		provider: "prov",
		id,
		name: `prov/${id}`,
		reasoning: true,
		thinkingLevelMap: {},
	});
	return {
		cwd,
		model: model("seat"),
		getThinkingLevel: () => "medium",
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "prov" ? model(id) : undefined,
			getApiKeyAndHeaders: async (entry: { provider: string; id: string }) =>
				unavailable.has(`${entry.provider}/${entry.id}`)
					? { ok: false, error: "down" }
					: { ok: true, apiKey: "k", headers: {} },
		},
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "v2-resolver-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, ".agent");
	mkdirSync(join(cwd, ".agent"), { recursive: true });
	writeSettings(SETTINGS);
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	rmSync(cwd, { recursive: true, force: true });
});

describe("inheritance", () => {
	it("no tier → the caller's model, verbatim", async () => {
		const resolution = await resolveV2Model(fakeCtx(), {
			agent: "worker",
			inherit: { modelId: "prov/parent", effort: "high" },
		});
		expect(resolution).toMatchObject({
			source: "inherit",
			modelId: "prov/parent",
			effort: "high",
		});
	});

	it("no tier, no caller → the session model (the root's caller is the seat)", async () => {
		const resolution = await resolveV2Model(fakeCtx(), { agent: "worker" });
		expect(resolution).toMatchObject({
			source: "inherit",
			modelId: "prov/seat",
			effort: "medium",
		});
	});
});

describe("tier resolution", () => {
	it("walks the tier first-available with profile/catalog provenance", async () => {
		const resolution = await resolveV2Model(fakeCtx(), {
			agent: "worker",
			tier: "normal",
			inherit: { modelId: "prov/seat", effort: "medium" },
		});
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "prov/sol",
			family: "openai",
			tier: "normal",
			profileId: "main",
			catalogId: "daily",
		});
		// entry.effort=high is in its own allowlist → wins over inherited medium.
		expect(resolution.effort).toBe("high");
	});

	it("falls through unavailable entries in authored order", async () => {
		const resolution = await resolveV2Model(
			fakeCtx({ unavailable: ["prov/sol"] }),
			{ agent: "worker", tier: "normal" },
		);
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "prov/kimi",
			family: "moonshot",
		});
		expect(
			resolution.candidates?.find((fact) => fact.model === "prov/sol")?.reason,
		).toBe("not authenticated");
	});

	it("respects the agent tier allowlist for deliberate references", async () => {
		await expect(
			resolveV2Model(fakeCtx(), { agent: "worker", tier: "fast" }),
		).rejects.toThrow(V2ResolutionError);
		// explorer's allowlist includes fast.
		const resolution = await resolveV2Model(fakeCtx(), {
			agent: "explorer",
			tier: "fast",
		});
		expect(resolution.modelId).toBe("prov/quick");
	});

	it("residency strikes non-members before availability", async () => {
		writeSettings({
			models: {
				...SETTINGS.models,
				residency: { active: "EEA", lists: SETTINGS.models.residency.lists },
			},
		});
		const resolution = await resolveV2Model(fakeCtx(), {
			agent: "worker",
			tier: "normal",
		});
		// kimi is not in EEA → struck; sol is the only survivor.
		expect(resolution.modelId).toBe("prov/sol");
		expect(
			resolution.candidates?.find((fact) => fact.model === "prov/kimi")?.reason,
		).toContain("residency");
	});
});

describe("seat-to-end", () => {
	// The seat is the session model (prov/seat — fakeCtx's `model`). A tier that
	// lists it must still prefer a real alternative and reach the seat last.
	const seatFirst = {
		models: {
			...SETTINGS.models,
			catalog: {
				daily: {
					...SETTINGS.models.catalog.daily,
					// seat authored FIRST, ahead of a real alternative.
					heavy: [
						{ model: "prov/seat", family: "openai" },
						{ model: "prov/opus", family: "anthropic", effort: "high" },
					],
				},
			},
		},
	};

	it("a tier that lists the seat resolves to the non-seat model first", async () => {
		writeSettings(seatFirst);
		const resolution = await resolveV2Model(fakeCtx(), {
			agent: "worker",
			tier: "heavy",
		});
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "prov/opus",
			family: "anthropic",
		});
		// The seat never enters tier contention — it is not a candidate here.
		expect(
			resolution.candidates?.some((fact) => fact.model === "prov/seat"),
		).toBe(false);
	});

	it("lands on the seat last, as a visible fallback, when alternatives are down", async () => {
		writeSettings(seatFirst);
		const resolution = await resolveV2Model(
			fakeCtx({ unavailable: ["prov/opus"] }),
			{ agent: "worker", tier: "heavy", inherit: { modelId: "prov/seat" } },
		);
		expect(resolution).toMatchObject({
			source: "fallback",
			modelId: "prov/seat",
			tier: "heavy",
		});
		expect(resolution.fallbackReason).toContain("unavailable");
		expect(fallbackNotice(resolution)).toContain("running on the session");
	});

	it("a tier holding only the seat falls back with an accurate reason", async () => {
		writeSettings({
			models: {
				...SETTINGS.models,
				catalog: {
					daily: {
						...SETTINGS.models.catalog.daily,
						heavy: [{ model: "prov/seat", family: "openai" }],
					},
				},
			},
		});
		const resolution = await resolveV2Model(fakeCtx(), {
			agent: "worker",
			tier: "heavy",
		});
		expect(resolution).toMatchObject({
			source: "fallback",
			modelId: "prov/seat",
		});
		expect(resolution.fallbackReason).toContain("only the session model");
	});
});

describe("session fallback", () => {
	it("an exhausted tier degrades to the seat with a visible reason", async () => {
		const resolution = await resolveV2Model(
			fakeCtx({ unavailable: ["prov/sol", "prov/kimi"] }),
			{ agent: "worker", tier: "normal", inherit: { modelId: "prov/seat" } },
		);
		expect(resolution).toMatchObject({
			source: "fallback",
			modelId: "prov/seat",
			tier: "normal",
		});
		expect(resolution.fallbackReason).toContain("unavailable");
		expect(fallbackNotice(resolution)).toContain("running on the session");
	});

	it("residency striking the whole tier also falls back — never fail-open", async () => {
		writeSettings({
			models: {
				...SETTINGS.models,
				residency: { active: "EEA", lists: { EEA: ["prov/seat"] } },
			},
		});
		const resolution = await resolveV2Model(fakeCtx(), {
			agent: "reviewer",
			tier: "heavy",
		});
		expect(resolution.source).toBe("fallback");
		expect(resolution.modelId).toBe("prov/seat");
	});
});

describe("failure semantics", () => {
	it("throws visibly when a tier is requested with no v2 config or no profile", async () => {
		writeSettings({});
		await expect(
			resolveV2Model(fakeCtx(), { agent: "worker", tier: "normal" }),
		).rejects.toThrow("no v2 catalog");

		writeSettings({
			models: {
				catalog: SETTINGS.models.catalog,
				profiles: { main: { targets: ["prov/other"], catalog: "daily" } },
			},
		});
		await expect(
			resolveV2Model(fakeCtx(), { agent: "worker", tier: "normal" }),
		).rejects.toThrow("no profile is active");
	});
});

describe("explain output", () => {
	it("renders every entry's fact and the allowlist verdict", async () => {
		const explained = await explainTier(fakeCtx(), "worker", "normal");
		expect(explained.allowed).toBe(true);
		expect(explained.profileId).toBe("main");
		expect(explained.candidates).toHaveLength(2);

		const fastForWorker = await explainTier(fakeCtx(), "worker", "fast");
		expect(fastForWorker.allowed).toBe(false);
	});
});
