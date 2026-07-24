// The v2 inheritance-first resolver: inherit by default; tier resolution
// through binding→roster, each alias resolving to a concrete attachment
// (own-gateway preference, else first available), bounded by the agent's tier
// allowance; region striking; session-model floor with a visible reason;
// effort clamping; and explain output.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	defaultTierForAgent,
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
		families: {
			OpenAI: {
				aliases: {
					// The SAME logical model served on two gateways (order = fallback).
					Sol: {
						attach: ["gw1/sol", "gw2/sol"],
						effort: "high",
						efforts: ["medium", "high"],
					},
					Quick: { attach: ["gw1/quick"], effort: "low" },
				},
			},
			Moonshot: { aliases: { Kimi: { attach: ["gw2/kimi"] } } },
			Anthropic: {
				aliases: { Opus: { attach: ["gw1/opus"], effort: "high" } },
			},
		},
		rosters: {
			daily: {
				light: ["OpenAI/Quick"],
				standard: ["OpenAI/Sol", "Moonshot/Kimi"],
				heavy: ["Anthropic/Opus"],
			},
		},
		bindings: { main: { roster: "daily" } },
		// The built-in worker default is now empty (inherit the session model), so
		// these tier-mechanics tests configure worker explicitly. The default is
		// covered separately in "default worker allowance".
		allowances: { worker: { tiers: ["standard", "heavy"] } },
	},
};

function writeSettings(settings: unknown): void {
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
}

/** Registry knowing every gw1/* and gw2/* model; `unavailable` fail auth. */
function fakeCtx(
	options: { unavailable?: readonly string[]; seat?: string } = {},
) {
	const unavailable = new Set(options.unavailable ?? []);
	const seatRef = options.seat ?? "gw2/seat";
	const slash = seatRef.indexOf("/");
	const seatProvider = seatRef.slice(0, slash);
	const seatId = seatRef.slice(slash + 1);
	const known = new Set(["gw1", "gw2"]);
	const model = (provider: string, id: string) => ({
		provider,
		id,
		name: `${provider}/${id}`,
		reasoning: true,
		thinkingLevelMap: {},
	});
	return {
		cwd,
		model: model(seatProvider, seatId),
		getThinkingLevel: () => "medium",
		modelRegistry: {
			find: (provider: string, id: string) =>
				known.has(provider) ? model(provider, id) : undefined,
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
			inherit: { modelId: "gw1/parent", effort: "high" },
		});
		expect(resolution).toMatchObject({
			source: "inherit",
			modelId: "gw1/parent",
			effort: "high",
		});
	});

	it("no tier, no caller → the session model (the root's caller is the seat)", async () => {
		const resolution = await resolveV2Model(fakeCtx(), { agent: "worker" });
		expect(resolution).toMatchObject({
			source: "inherit",
			modelId: "gw2/seat",
			effort: "medium",
		});
	});
});

describe("alias resolution", () => {
	it("prefers an attachment on the resolving agent's own gateway", async () => {
		// Seat is gw2; Sol lists gw1/sol FIRST, but gw2 is the agent's gateway.
		const resolution = await resolveV2Model(fakeCtx({ seat: "gw2/seat" }), {
			agent: "worker",
			tier: "standard",
			inherit: { modelId: "gw2/seat", effort: "medium" },
		});
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw2/sol",
			family: "OpenAI",
			alias: "Sol",
			attachmentProvider: "gw2",
			tier: "standard",
			bindingId: "main",
			rosterId: "daily",
		});
		// Sol's effort high is in its own allowlist → wins over inherited medium.
		expect(resolution.effort).toBe("high");
	});

	it("falls to the first available attachment when the own gateway is down", async () => {
		const resolution = await resolveV2Model(
			fakeCtx({ seat: "gw2/seat", unavailable: ["gw2/sol"] }),
			{ agent: "worker", tier: "standard" },
		);
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw1/sol",
			alias: "Sol",
			attachmentProvider: "gw1",
		});
	});

	it("walks to the next alias when the first alias has no attachment available", async () => {
		const resolution = await resolveV2Model(
			fakeCtx({ unavailable: ["gw1/sol", "gw2/sol"] }),
			{ agent: "worker", tier: "standard" },
		);
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw2/kimi",
			family: "Moonshot",
			alias: "Kimi",
		});
		expect(
			resolution.candidates?.find((fact) => fact.ref === "OpenAI/Sol")
				?.available,
		).toBe(false);
	});

	it("returns effort verbatim for an alias with a fixed effort and no allowlist", async () => {
		const resolution = await resolveV2Model(fakeCtx(), {
			agent: "explorer",
			tier: "light",
		});
		expect(resolution.modelId).toBe("gw1/quick");
		expect(resolution.effort).toBe("low");
	});
});

describe("allowances", () => {
	it("bounds deliberate tier references to the agent's allowance", async () => {
		// worker is configured here as {standard, heavy} — light is out.
		await expect(
			resolveV2Model(fakeCtx(), { agent: "worker", tier: "light" }),
		).rejects.toThrow(V2ResolutionError);
		// explorer's allowance includes light.
		const resolution = await resolveV2Model(fakeCtx(), {
			agent: "explorer",
			tier: "light",
		});
		expect(resolution.modelId).toBe("gw1/quick");
	});
});

describe("default worker allowance", () => {
	it("an unconfigured worker has no default tier and inherits the session model", async () => {
		// No allowances block → every agent falls to the built-in defaults. The
		// worker default is empty (inherit), the support types keep their tiers.
		writeSettings({ models: { ...SETTINGS.models, allowances: {} } });
		expect(defaultTierForAgent(fakeCtx(), "worker")).toBeUndefined();
		expect(defaultTierForAgent(fakeCtx(), "explorer")).toBe("light");
		expect(defaultTierForAgent(fakeCtx(), "reviewer")).toBe("standard");
		expect(defaultTierForAgent(fakeCtx(), "advisor")).toBe("heavy");
		// With no tier, the worker resolves to the seat (source: inherit).
		const resolution = await resolveV2Model(fakeCtx({ seat: "gw2/seat" }), {
			agent: "worker",
		});
		expect(resolution).toMatchObject({
			source: "inherit",
			modelId: "gw2/seat",
		});
	});
});

describe("region", () => {
	it("strikes out-of-region attachments before availability", async () => {
		writeSettings({
			models: {
				...SETTINGS.models,
				region: { active: "EEA", lists: { EEA: ["gw1/*"] } },
			},
		});
		// Seat gw2 would prefer gw2/sol, but region allows only gw1/* → gw1/sol.
		const resolution = await resolveV2Model(fakeCtx({ seat: "gw2/seat" }), {
			agent: "worker",
			tier: "standard",
		});
		expect(resolution.modelId).toBe("gw1/sol");
	});

	it("a region that strikes the whole tier falls back — never fail-open", async () => {
		writeSettings({
			models: {
				...SETTINGS.models,
				region: { active: "EEA", lists: { EEA: ["gw9/*"] } },
			},
		});
		const resolution = await resolveV2Model(fakeCtx(), {
			agent: "worker",
			tier: "standard",
		});
		expect(resolution.source).toBe("fallback");
		expect(resolution.modelId).toBe("gw2/seat");
	});
});

describe("session fallback", () => {
	it("an exhausted tier degrades to the seat with a visible reason", async () => {
		const resolution = await resolveV2Model(
			fakeCtx({ unavailable: ["gw1/sol", "gw2/sol", "gw2/kimi"] }),
			{ agent: "worker", tier: "standard", inherit: { modelId: "gw2/seat" } },
		);
		expect(resolution).toMatchObject({
			source: "fallback",
			modelId: "gw2/seat",
			tier: "standard",
		});
		expect(resolution.fallbackReason).toContain("unavailable");
		expect(fallbackNotice(resolution)).toContain("running on the session");
	});

	it("an empty tier falls back with an accurate reason", async () => {
		writeSettings({
			models: {
				...SETTINGS.models,
				rosters: {
					daily: { ...SETTINGS.models.rosters.daily, heavy: [] },
				},
			},
		});
		const resolution = await resolveV2Model(fakeCtx(), {
			agent: "worker",
			tier: "heavy",
		});
		expect(resolution.source).toBe("fallback");
		expect(resolution.fallbackReason).toContain("empty");
	});
});

describe("failure semantics", () => {
	it("throws visibly when a tier is requested with no config or no binding", async () => {
		writeSettings({});
		await expect(
			resolveV2Model(fakeCtx(), { agent: "worker", tier: "standard" }),
		).rejects.toThrow("no v2 roster");

		writeSettings({
			models: {
				families: SETTINGS.models.families,
				rosters: SETTINGS.models.rosters,
				bindings: { main: { targets: ["gw9/other"], roster: "daily" } },
				// worker must allow standard to reach the binding check under test.
				allowances: { worker: { tiers: ["standard"] } },
			},
		});
		await expect(
			resolveV2Model(fakeCtx(), { agent: "worker", tier: "standard" }),
		).rejects.toThrow("no binding is active");
	});
});

describe("explain output", () => {
	it("renders every ref's fact and the allowance verdict", async () => {
		const explained = await explainTier(fakeCtx(), "worker", "standard");
		expect(explained.allowed).toBe(true);
		expect(explained.bindingId).toBe("main");
		expect(explained.rosterId).toBe("daily");
		expect(explained.candidates).toHaveLength(2);

		const lightForWorker = await explainTier(fakeCtx(), "worker", "light");
		expect(lightForWorker.allowed).toBe(false);
	});
});
