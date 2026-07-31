// The v2 inheritance-first resolver: inherit by default; tier resolution
// through binding→roster, each alias resolving to a concrete attachment
// (own-gateway preference, else first available), bounded by the persona's
// tier allowance; region striking; session-model floor with a visible reason;
// effort clamping; the `direct: "other-family"` selector; and explain output.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	defaultTierFor,
	explainTier,
	fallbackNotice,
	ModelResolutionError,
	resolveModel,
	resolveModels,
	resolveOtherFamily,
	spreadFor,
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
		// The built-in deliverable-worker default is empty (inherit the session
		// model), so these tier-mechanics tests configure it explicitly. The
		// default is covered separately in "default persona allowances".
		allowances: { "deliverable-worker": { tiers: ["standard", "heavy"] } },
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
		const resolution = await resolveModel(fakeCtx(), {
			persona: "deliverable-worker",
			inherit: { modelId: "gw1/parent", effort: "high" },
		});
		expect(resolution).toMatchObject({
			source: "inherit",
			modelId: "gw1/parent",
			effort: "high",
		});
	});

	it("no tier, no caller → the session model (the root's caller is the seat)", async () => {
		const resolution = await resolveModel(fakeCtx(), {
			persona: "deliverable-worker",
		});
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
		const resolution = await resolveModel(fakeCtx({ seat: "gw2/seat" }), {
			persona: "deliverable-worker",
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
		const resolution = await resolveModel(
			fakeCtx({ seat: "gw2/seat", unavailable: ["gw2/sol"] }),
			{ persona: "deliverable-worker", tier: "standard" },
		);
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw1/sol",
			alias: "Sol",
			attachmentProvider: "gw1",
		});
	});

	it("walks to the next alias when the first alias has no attachment available", async () => {
		const resolution = await resolveModel(
			fakeCtx({ unavailable: ["gw1/sol", "gw2/sol"] }),
			{ persona: "deliverable-worker", tier: "standard" },
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
		const resolution = await resolveModel(fakeCtx(), {
			persona: "codebase-research",
			tier: "light",
		});
		expect(resolution.modelId).toBe("gw1/quick");
		expect(resolution.effort).toBe("low");
	});
});

describe("allowances", () => {
	it("bounds deliberate tier references to the persona's allowance", async () => {
		// deliverable-worker is configured here as {standard, heavy} — light is out.
		await expect(
			resolveModel(fakeCtx(), { persona: "deliverable-worker", tier: "light" }),
		).rejects.toThrow(ModelResolutionError);
		// codebase-research's allowance includes light.
		const resolution = await resolveModel(fakeCtx(), {
			persona: "codebase-research",
			tier: "light",
		});
		expect(resolution.modelId).toBe("gw1/quick");
	});

	it("resolves a persona-keyed allowance authored in settings", async () => {
		// A free-text persona key is a first-class allowance — nothing enumerates
		// valid personas at parse time.
		writeSettings({
			models: {
				...SETTINGS.models,
				allowances: { "deep-research": { tiers: ["heavy"] } },
			},
		});
		expect(defaultTierFor(fakeCtx(), "deep-research")).toBe("heavy");
		const resolution = await resolveModel(fakeCtx(), {
			persona: "deep-research",
			tier: "heavy",
		});
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw1/opus",
			family: "Anthropic",
		});
	});

	it("a persona with no allowance has no default tier and inherits", async () => {
		expect(defaultTierFor(fakeCtx(), "never-heard-of-it")).toBeUndefined();
		const resolution = await resolveModel(fakeCtx(), {
			persona: "never-heard-of-it",
			inherit: { modelId: "gw1/parent" },
		});
		expect(resolution).toMatchObject({
			source: "inherit",
			modelId: "gw1/parent",
		});
	});
});

describe("default persona allowances", () => {
	it("an unconfigured deliverable-worker has no default tier and inherits the session model", async () => {
		// No allowances block → every persona falls to the built-in defaults. The
		// deliverable-worker default is empty (inherit), the support personas
		// keep their tiers.
		writeSettings({ models: { ...SETTINGS.models, allowances: {} } });
		expect(defaultTierFor(fakeCtx(), "deliverable-worker")).toBeUndefined();
		expect(defaultTierFor(fakeCtx(), "codebase-research")).toBe("light");
		expect(defaultTierFor(fakeCtx(), "code-review")).toBe("standard");
		expect(defaultTierFor(fakeCtx(), "standby")).toBe("heavy");
		// With no tier, the worker resolves to the seat (source: inherit).
		const resolution = await resolveModel(fakeCtx({ seat: "gw2/seat" }), {
			persona: "deliverable-worker",
		});
		expect(resolution).toMatchObject({
			source: "inherit",
			modelId: "gw2/seat",
		});
	});

	it("retired agent-type keys stop matching and degrade to the defaults", async () => {
		// The old worker/explorer/reviewer/advisor keys are just unknown personas
		// now: parsed fine (free text), matched by nothing that spawns, and the
		// built-in persona defaults answer instead — graceful, never a crash.
		writeSettings({
			models: {
				...SETTINGS.models,
				allowances: { reviewer: { tiers: ["light"] } },
			},
		});
		expect(defaultTierFor(fakeCtx(), "code-review")).toBe("standard");
		expect(defaultTierFor(fakeCtx(), "reviewer")).toBe("light");
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
		const resolution = await resolveModel(fakeCtx({ seat: "gw2/seat" }), {
			persona: "deliverable-worker",
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
		const resolution = await resolveModel(fakeCtx(), {
			persona: "deliverable-worker",
			tier: "standard",
		});
		expect(resolution.source).toBe("fallback");
		expect(resolution.modelId).toBe("gw2/seat");
	});

	// Mirrors the real SIT tripwire (see reference-gateway-region-models): a
	// functional but NON-EEA model (US-data-share Fable, here gw2/fable) leads the
	// heavy tier; under EEA it is struck and resolution lands on the EEA-legal
	// model (gw1/opus); flip the active region to Global and it resolves the gated
	// model itself — a real positive and a true negative in one config.
	describe("the tripwire", () => {
		const TRIPWIRE = {
			models: {
				families: {
					Anthropic: {
						aliases: {
							Fable: { attach: ["gw2/fable"] },
							Opus: { attach: ["gw1/opus"] },
						},
					},
				},
				rosters: {
					daily: {
						light: ["Anthropic/Opus"],
						standard: ["Anthropic/Opus"],
						heavy: ["Anthropic/Fable", "Anthropic/Opus"],
					},
				},
				bindings: { main: { roster: "daily" } },
				allowances: { "code-review": { tiers: ["heavy"] } },
				region: {
					active: "EEA",
					lists: { Global: ["gw1/*", "gw2/*"], EEA: ["gw1/*"] },
				},
			},
		};

		it("EEA skips the non-EEA model and lands on the EEA-legal one", async () => {
			writeSettings(TRIPWIRE);
			const resolution = await resolveModel(fakeCtx({ seat: "gw1/seat" }), {
				persona: "code-review",
				tier: "heavy",
			});
			expect(resolution.modelId).toBe("gw1/opus");
			const fable = resolution.candidates?.find(
				(fact) => fact.ref === "Anthropic/Fable",
			);
			expect(fable?.available).toBe(false);
			expect(fable?.reason).toContain("outside region EEA");
		});

		it("Global resolves the gated model itself (it is functional)", async () => {
			writeSettings({
				models: {
					...TRIPWIRE.models,
					region: { ...TRIPWIRE.models.region, active: "Global" },
				},
			});
			const resolution = await resolveModel(fakeCtx({ seat: "gw1/seat" }), {
				persona: "code-review",
				tier: "heavy",
			});
			expect(resolution.modelId).toBe("gw2/fable");
		});
	});
});

describe("session fallback", () => {
	it("an exhausted tier degrades to the seat with a visible reason", async () => {
		const resolution = await resolveModel(
			fakeCtx({ unavailable: ["gw1/sol", "gw2/sol", "gw2/kimi"] }),
			{
				persona: "deliverable-worker",
				tier: "standard",
				inherit: { modelId: "gw2/seat" },
			},
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
		const resolution = await resolveModel(fakeCtx(), {
			persona: "deliverable-worker",
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
			resolveModel(fakeCtx(), {
				persona: "deliverable-worker",
				tier: "standard",
			}),
		).rejects.toThrow("no v2 roster");

		writeSettings({
			models: {
				families: SETTINGS.models.families,
				rosters: SETTINGS.models.rosters,
				bindings: { main: { targets: ["gw9/other"], roster: "daily" } },
				// The persona must allow standard to reach the binding check under test.
				allowances: { "deliverable-worker": { tiers: ["standard"] } },
			},
		});
		await expect(
			resolveModel(fakeCtx(), {
				persona: "deliverable-worker",
				tier: "standard",
			}),
		).rejects.toThrow("no binding is active");
	});
});

describe("explain output", () => {
	it("renders every ref's fact and the allowance verdict", async () => {
		const explained = await explainTier(
			fakeCtx(),
			"deliverable-worker",
			"standard",
		);
		expect(explained.allowed).toBe(true);
		expect(explained.bindingId).toBe("main");
		expect(explained.rosterId).toBe("daily");
		expect(explained.candidates).toHaveLength(2);

		const lightForWorker = await explainTier(
			fakeCtx(),
			"deliverable-worker",
			"light",
		);
		expect(lightForWorker.allowed).toBe(false);
	});
});

// ─── top-N ───────────────────────────────────────────────────────────────────
// The primitive behind multi-modal review: N models for ONE spawn request, each
// from a DISTINCT family. Genuine diversity is the whole point, so this never
// pads — fewer slots beats the same model twice.

describe("resolveModels (top-N)", () => {
	it("n=1 is exactly resolveModel", async () => {
		const request = {
			persona: "deliverable-worker" as const,
			tier: "standard" as const,
		};
		const [one] = await resolveModels(fakeCtx(), request, 1);
		expect(one).toEqual(await resolveModel(fakeCtx(), request));
	});

	it("no tier degrades to a single inherited slot", async () => {
		// Inheritance has no roster to spread across — asking for 3 cannot
		// manufacture diversity out of "run your caller's model".
		const slots = await resolveModels(
			fakeCtx(),
			{ persona: "deliverable-worker", inherit: { modelId: "gw1/parent" } },
			3,
		);
		expect(slots).toHaveLength(1);
		expect(slots[0]).toMatchObject({
			source: "inherit",
			modelId: "gw1/parent",
		});
	});

	it("returns one slot per DISTINCT family", async () => {
		// standard = [OpenAI/Sol, Moonshot/Kimi] — two families.
		const slots = await resolveModels(
			fakeCtx(),
			{ persona: "deliverable-worker", tier: "standard" },
			2,
		);
		expect(slots).toHaveLength(2);
		expect(slots.map((s) => s.family)).toEqual(["OpenAI", "Moonshot"]);
		expect(slots.every((s) => s.source === "tier")).toBe(true);
	});

	it("never pads beyond the families the tier actually holds", async () => {
		// Asking for 5 from a two-family tier yields 2 — not 5, and not 2 real
		// plus 3 seat copies dressed up as diversity.
		const slots = await resolveModels(
			fakeCtx(),
			{ persona: "deliverable-worker", tier: "standard" },
			5,
		);
		expect(slots).toHaveLength(2);
		expect(new Set(slots.map((s) => s.family)).size).toBe(2);
	});

	it("degrades to fewer slots when the region/auth strikes a family", async () => {
		// Kimi is gw2-only; strike it and Moonshot has nothing left.
		const slots = await resolveModels(
			fakeCtx({ unavailable: ["gw2/kimi"] }),
			{ persona: "deliverable-worker", tier: "standard" },
			2,
		);
		expect(slots).toHaveLength(1);
		expect(slots[0]).toMatchObject({ source: "tier", family: "OpenAI" });
	});

	it("falls back to ONE seat slot when every alias is struck", async () => {
		// The degradation case that must not silently produce an empty list: one
		// usable review is a review; zero is a silent hole.
		const slots = await resolveModels(
			fakeCtx({ unavailable: ["gw1/sol", "gw2/sol", "gw2/kimi"] }),
			{ persona: "deliverable-worker", tier: "standard" },
			3,
		);
		expect(slots).toHaveLength(1);
		expect(slots[0]).toMatchObject({ source: "fallback", modelId: "gw2/seat" });
		expect(slots[0].fallbackReason).toContain("unavailable");
	});

	it("keeps the allowance bound — top-N is not an escape hatch", async () => {
		await expect(
			resolveModels(
				fakeCtx(),
				{ persona: "deliverable-worker", tier: "light" },
				3,
			),
		).rejects.toThrow("outside persona deliverable-worker's allowance");
	});

	it("carries the same candidate facts on every slot", async () => {
		// Explain output must not degrade just because the caller asked for N.
		const slots = await resolveModels(
			fakeCtx(),
			{ persona: "deliverable-worker", tier: "standard" },
			2,
		);
		for (const slot of slots) expect(slot.candidates).toHaveLength(2);
	});
});

// ─── spread ──────────────────────────────────────────────────────────────────
// How wide a MULTI-MODAL review fans out. Answers HOW WIDE, never WHETHER —
// the plan node decides that.

describe("spreadFor", () => {
	it("uses the shipped default for code-review", async () => {
		expect(spreadFor(fakeCtx(), "code-review")).toBe(3);
	});

	it("honors an authored spread", async () => {
		writeSettings({
			models: {
				...SETTINGS.models,
				allowances: {
					"deliverable-worker": { tiers: ["standard", "heavy"] },
					"code-review": { tiers: ["standard"], spread: 2 },
				},
			},
		});
		expect(spreadFor(fakeCtx(), "code-review")).toBe(2);
	});

	it("keeps the default when an author narrows tiers without saying spread", () => {
		// allowances merge SHALLOWLY, so authoring `code-review: { tiers: [...] }`
		// replaces the whole default object. Without the explicit fallback this
		// would silently disable multi-modal review for anyone who ever narrowed
		// a tier list.
		writeSettings({
			models: {
				...SETTINGS.models,
				allowances: {
					"deliverable-worker": { tiers: ["standard", "heavy"] },
					"code-review": { tiers: ["heavy"] },
				},
			},
		});
		expect(spreadFor(fakeCtx(), "code-review")).toBe(3);
	});

	it("is 1 for personas with no spread anywhere", () => {
		// An authored multiModal flag then degrades to one review, never errors.
		expect(spreadFor(fakeCtx(), "codebase-research")).toBe(1);
		expect(spreadFor(fakeCtx(), "never-heard-of-it")).toBe(1);
	});

	it("rejects a spread above the cap at parse time", () => {
		writeSettings({
			models: {
				...SETTINGS.models,
				allowances: { "code-review": { tiers: ["heavy"], spread: 99 } },
			},
		});
		expect(() => spreadFor(fakeCtx(), "code-review")).not.toThrow();
		// The config is rejected, so the reader falls back to the shipped default
		// rather than honoring 99 — runaway fan-out is real money.
		expect(spreadFor(fakeCtx(), "code-review")).toBe(3);
	});

	it("rejects a non-integer spread", () => {
		writeSettings({
			models: {
				...SETTINGS.models,
				allowances: { "code-review": { tiers: ["heavy"], spread: 2.5 } },
			},
		});
		expect(spreadFor(fakeCtx(), "code-review")).toBe(3);
	});
});

// ─── direct: other-family ────────────────────────────────────────────────────
// The model selector for a DIRECT (non-fanned) spawn. `other-family` walks the
// allowance's tiers in order and takes the first available entry whose family
// differs from the caller's — a reviewer never marks its own homework. With
// nowhere to go it falls back to inherit WITH a fallbackReason, never silently.

describe("resolveOtherFamily", () => {
	// A caller on OpenAI (Sol's gw1 attachment) asking through the standard-then-
	// heavy allowance: standard leads with OpenAI/Sol (same family — skipped),
	// then Moonshot/Kimi wins deterministically.
	const OTHER_FAMILY = {
		models: {
			...SETTINGS.models,
			allowances: {
				"code-review": {
					tiers: ["standard", "heavy"],
					direct: "other-family",
				},
			},
		},
	};

	it("picks the first foreign-family entry, walking tiers in order", async () => {
		writeSettings(OTHER_FAMILY);
		const resolution = await resolveOtherFamily(fakeCtx(), {
			persona: "code-review",
			inherit: { modelId: "gw1/sol", effort: "medium" },
		});
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw2/kimi",
			family: "Moonshot",
			tier: "standard",
		});
	});

	it("walks into the next tier when the first holds only the caller's family", async () => {
		// standard reduced to OpenAI only; heavy holds Anthropic — the walk must
		// cross the tier boundary rather than settle for its own family.
		writeSettings({
			models: {
				...OTHER_FAMILY.models,
				rosters: {
					daily: { ...SETTINGS.models.rosters.daily, standard: ["OpenAI/Sol"] },
				},
			},
		});
		const resolution = await resolveOtherFamily(fakeCtx(), {
			persona: "code-review",
			inherit: { modelId: "gw1/sol" },
		});
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw1/opus",
			family: "Anthropic",
			tier: "heavy",
		});
	});

	it("falls back to inherit WITH a reason when every family is the caller's", async () => {
		// An all-OpenAI roster leaves other-family nowhere to go. Falling back to
		// a tier pick would mark its own homework; inheriting silently would hide
		// the degradation. It inherits, and says why.
		writeSettings({
			models: {
				...OTHER_FAMILY.models,
				rosters: {
					daily: {
						light: ["OpenAI/Quick"],
						standard: ["OpenAI/Sol"],
						heavy: ["OpenAI/Quick"],
					},
				},
			},
		});
		const resolution = await resolveOtherFamily(fakeCtx(), {
			persona: "code-review",
			inherit: { modelId: "gw1/sol", effort: "medium" },
		});
		expect(resolution).toMatchObject({
			source: "inherit",
			modelId: "gw1/sol",
			effort: "medium",
		});
		expect(resolution.fallbackReason).toContain("no model outside family");
	});

	it("falls back with a reason when the caller's family is unknown", async () => {
		writeSettings(OTHER_FAMILY);
		// No inherit at all: nothing to differ from — do not guess.
		const noCaller = await resolveOtherFamily(fakeCtx(), {
			persona: "code-review",
		});
		expect(noCaller.source).toBe("inherit");
		expect(noCaller.fallbackReason).toContain("caller's model is unknown");
		// A caller model attached to no alias: equally unknowable.
		const noFamily = await resolveOtherFamily(fakeCtx(), {
			persona: "code-review",
			inherit: { modelId: "gw9/mystery" },
		});
		expect(noFamily).toMatchObject({
			source: "inherit",
			modelId: "gw9/mystery",
		});
		expect(noFamily.fallbackReason).toContain("no configured family");
	});
});
