// The inheritance-first router: inherit by default; tier resolution through
// binding→roster, each alias resolving to a concrete attachment (own-gateway
// preference, else first available), bounded by the persona's tier allowance;
// region striking; session-model floor with a visible reason; effort clamping;
// the `other-family` selector; and explain output.
//
// The router takes a parsed config, a seat, and a host port, so nothing here
// touches a filesystem or an ExtensionContext: `router()` parses a settings
// object directly and hands the router a fake catalogue.

import {
	createModelRouter,
	fallbackNotice,
	ModelResolutionError,
	type ModelRouter,
	parseModelsSettings,
	type ThinkingLevel,
} from "@vegardx/pi-models";
import { describe, expect, it } from "vitest";

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

interface RouterOptions {
	/** The raw project settings object; defaults to SETTINGS. */
	readonly settings?: unknown;
	/** Concrete `provider/model` refs the host does not hold. */
	readonly unavailable?: readonly string[];
	/** The seat model; explicitly undefined means "no seat at all". */
	readonly seat?: string | undefined;
	readonly seatEffort?: ThinkingLevel;
}

/**
 * A host that knows every gw1/* and gw2/* model. `unavailable` names concrete
 * models the host cannot serve; the port answers availability per model
 * (`findModel`) and credentials per provider (`isAuthenticated`), so a struck
 * model is one the host does not have.
 */
function router(options: RouterOptions = {}): ModelRouter {
	const unavailable = new Set(options.unavailable ?? []);
	const known = new Set(["gw1", "gw2"]);
	const seat = "seat" in options ? options.seat : "gw2/seat";
	// The host swallows a config error into "no usable v2 config" (see
	// packages/maestro/src/model-router.ts); the refusal is fail-visible at
	// read time, not at every resolution site. Mirror that here.
	let models: ReturnType<typeof parseModelsSettings>;
	try {
		models = parseModelsSettings({}, options.settings ?? SETTINGS);
	} catch {
		models = undefined;
	}
	return createModelRouter(
		{
			...(models ? { models } : {}),
			...(seat ? { seat } : {}),
			seatEffort: options.seatEffort ?? "medium",
		},
		{
			findModel: (provider, id) =>
				known.has(provider) && !unavailable.has(`${provider}/${id}`)
					? { reasoning: true, thinkingLevelMap: {} }
					: undefined,
			isAuthenticated: (provider) => known.has(provider),
			registeredProviders: () => ["gw1", "gw2"],
		},
	);
}

/** SETTINGS.models with one key replaced — the shape most cases need. */
function settingsWith(models: Record<string, unknown>): unknown {
	return { models: { ...SETTINGS.models, ...models } };
}

describe("inheritance", () => {
	it("no tier → the caller's model, verbatim", () => {
		const resolution = router().resolve({
			persona: "deliverable-worker",
			inherit: { modelId: "gw1/parent", effort: "high" },
		});
		expect(resolution).toMatchObject({
			source: "inherit",
			modelId: "gw1/parent",
			effort: "high",
		});
	});

	it("no tier, no caller → the session model (the root's caller is the seat)", () => {
		const resolution = router().resolve({ persona: "deliverable-worker" });
		expect(resolution).toMatchObject({
			source: "inherit",
			modelId: "gw2/seat",
			effort: "medium",
		});
	});

	it("no tier, no caller and no seat is a visible refusal, never a guess", () => {
		expect(() =>
			router({ seat: undefined }).resolve({ persona: "deliverable-worker" }),
		).toThrow(ModelResolutionError);
	});
});

describe("alias resolution", () => {
	it("prefers an attachment on the resolving agent's own gateway", () => {
		// Seat is gw2; Sol lists gw1/sol FIRST, but gw2 is the agent's gateway.
		const resolution = router({ seat: "gw2/seat" }).resolve({
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

	it("falls to the first available attachment when the own gateway is down", () => {
		const resolution = router({
			seat: "gw2/seat",
			unavailable: ["gw2/sol"],
		}).resolve({ persona: "deliverable-worker", tier: "standard" });
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw1/sol",
			alias: "Sol",
			attachmentProvider: "gw1",
		});
	});

	it("walks to the next alias when the first alias has no attachment available", () => {
		const resolution = router({
			unavailable: ["gw1/sol", "gw2/sol"],
		}).resolve({ persona: "deliverable-worker", tier: "standard" });
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

	it("returns effort verbatim for an alias with a fixed effort and no allowlist", () => {
		const resolution = router().resolve({
			persona: "codebase-research",
			tier: "light",
		});
		expect(resolution.modelId).toBe("gw1/quick");
		expect(resolution.effort).toBe("low");
	});

	it("names an unregistered provider rather than calling it 'not in registry'", () => {
		// Two different mistakes deserve two different refusals: a typo in the
		// gateway name and a model the gateway does not serve.
		const explained = router().explainAttachment("gw9/sol");
		expect(explained.available).toBe(false);
		expect(explained.reason).toContain("provider gw9 is not registered");
		expect(explained.reason).toContain("gw1, gw2");
		expect(
			router({ unavailable: ["gw1/sol"] }).explainAttachment("gw1/sol"),
		).toEqual({ available: false, reason: "not in registry" });
	});
});

describe("allowances", () => {
	it("bounds deliberate tier references to the persona's allowance", () => {
		// deliverable-worker is configured here as {standard, heavy} — light is out.
		expect(() =>
			router().resolve({ persona: "deliverable-worker", tier: "light" }),
		).toThrow(ModelResolutionError);
		// codebase-research's allowance includes light.
		const resolution = router().resolve({
			persona: "codebase-research",
			tier: "light",
		});
		expect(resolution.modelId).toBe("gw1/quick");
	});

	it("resolves a persona-keyed allowance authored in settings", () => {
		// A free-text persona key is a first-class allowance — nothing enumerates
		// valid personas at parse time.
		const settings = settingsWith({
			allowances: { "deep-research": { tiers: ["heavy"] } },
		});
		expect(router({ settings }).defaultTierFor("deep-research")).toBe("heavy");
		const resolution = router({ settings }).resolve({
			persona: "deep-research",
			tier: "heavy",
		});
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw1/opus",
			family: "Anthropic",
		});
	});

	it("a persona with no allowance has no default tier and inherits", () => {
		expect(router().defaultTierFor("never-heard-of-it")).toBeUndefined();
		const resolution = router().resolve({
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
	it("an unconfigured deliverable-worker has no default tier and inherits the session model", () => {
		// No allowances block → every persona falls to the built-in defaults. The
		// deliverable-worker default is empty (inherit), the support personas
		// keep their tiers.
		const settings = settingsWith({ allowances: {} });
		const configured = router({ settings });
		expect(configured.defaultTierFor("deliverable-worker")).toBeUndefined();
		expect(configured.defaultTierFor("codebase-research")).toBe("light");
		expect(configured.defaultTierFor("code-review")).toBe("standard");
		expect(configured.defaultTierFor("standby")).toBe("heavy");
		// With no tier, the worker resolves to the seat (source: inherit).
		expect(configured.resolve({ persona: "deliverable-worker" })).toMatchObject(
			{ source: "inherit", modelId: "gw2/seat" },
		);
	});

	it("retired agent-type keys stop matching and degrade to the defaults", () => {
		// The old worker/explorer/reviewer/advisor keys are just unknown personas
		// now: parsed fine (free text), matched by nothing that spawns, and the
		// built-in persona defaults answer instead — graceful, never a crash.
		const configured = router({
			settings: settingsWith({
				allowances: { reviewer: { tiers: ["light"] } },
			}),
		});
		expect(configured.defaultTierFor("code-review")).toBe("standard");
		expect(configured.defaultTierFor("reviewer")).toBe("light");
	});
});

describe("region", () => {
	it("strikes out-of-region attachments before availability", () => {
		// Seat gw2 would prefer gw2/sol, but region allows only gw1/* → gw1/sol.
		const resolution = router({
			seat: "gw2/seat",
			settings: settingsWith({
				region: { active: "EEA", lists: { EEA: ["gw1/*"] } },
			}),
		}).resolve({ persona: "deliverable-worker", tier: "standard" });
		expect(resolution.modelId).toBe("gw1/sol");
	});

	it("a region that strikes the whole tier falls back — never fail-open", () => {
		const resolution = router({
			settings: settingsWith({
				region: { active: "EEA", lists: { EEA: ["gw9/*"] } },
			}),
		}).resolve({ persona: "deliverable-worker", tier: "standard" });
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
		};

		it("EEA skips the non-EEA model and lands on the EEA-legal one", () => {
			const resolution = router({
				seat: "gw1/seat",
				settings: { models: TRIPWIRE },
			}).resolve({ persona: "code-review", tier: "heavy" });
			expect(resolution.modelId).toBe("gw1/opus");
			const fable = resolution.candidates?.find(
				(fact) => fact.ref === "Anthropic/Fable",
			);
			expect(fable?.available).toBe(false);
			expect(fable?.reason).toContain("outside region EEA");
		});

		it("Global resolves the gated model itself (it is functional)", () => {
			const resolution = router({
				seat: "gw1/seat",
				settings: {
					models: {
						...TRIPWIRE,
						region: { ...TRIPWIRE.region, active: "Global" },
					},
				},
			}).resolve({ persona: "code-review", tier: "heavy" });
			expect(resolution.modelId).toBe("gw2/fable");
		});
	});
});

describe("session fallback", () => {
	it("an exhausted tier degrades to the seat with a visible reason", () => {
		const resolution = router({
			unavailable: ["gw1/sol", "gw2/sol", "gw2/kimi"],
		}).resolve({
			persona: "deliverable-worker",
			tier: "standard",
			inherit: { modelId: "gw2/seat" },
		});
		expect(resolution).toMatchObject({
			source: "fallback",
			modelId: "gw2/seat",
			tier: "standard",
		});
		expect(resolution.fallbackReason).toContain("unavailable");
		expect(fallbackNotice(resolution)).toContain("running on the session");
	});

	it("an empty tier falls back with an accurate reason", () => {
		const resolution = router({
			settings: settingsWith({
				rosters: { daily: { ...SETTINGS.models.rosters.daily, heavy: [] } },
			}),
		}).resolve({ persona: "deliverable-worker", tier: "heavy" });
		expect(resolution.source).toBe("fallback");
		expect(resolution.fallbackReason).toContain("empty");
	});
});

describe("failure semantics", () => {
	it("throws visibly when a tier is requested with no config or no binding", () => {
		expect(() =>
			router({ settings: {} }).resolve({
				persona: "deliverable-worker",
				tier: "standard",
			}),
		).toThrow("no v2 roster");

		expect(() =>
			router({
				settings: {
					models: {
						families: SETTINGS.models.families,
						rosters: SETTINGS.models.rosters,
						bindings: { main: { targets: ["gw9/other"], roster: "daily" } },
						// The persona must allow standard to reach the binding check.
						allowances: { "deliverable-worker": { tiers: ["standard"] } },
					},
				},
			}).resolve({ persona: "deliverable-worker", tier: "standard" }),
		).toThrow("no binding is active");
	});
});

describe("explain output", () => {
	it("renders every ref's fact and the allowance verdict", () => {
		const explained = router().explain("deliverable-worker", "standard");
		expect(explained.allowed).toBe(true);
		expect(explained.bindingId).toBe("main");
		expect(explained.rosterId).toBe("daily");
		expect(explained.candidates).toHaveLength(2);

		expect(router().explain("deliverable-worker", "light").allowed).toBe(false);
	});
});

// ─── top-N ───────────────────────────────────────────────────────────────────
// The primitive behind multi-modal review: N models for ONE spawn request, each
// from a DISTINCT family. Genuine diversity is the whole point, so this never
// pads — fewer slots beats the same model twice.

describe("resolveMany (top-N)", () => {
	it("n=1 is exactly resolve", () => {
		const request = {
			persona: "deliverable-worker" as const,
			tier: "standard" as const,
		};
		const [one] = router().resolveMany(request, 1);
		expect(one).toEqual(router().resolve(request));
	});

	it("no tier degrades to a single inherited slot", () => {
		// Inheritance has no roster to spread across — asking for 3 cannot
		// manufacture diversity out of "run your caller's model".
		const slots = router().resolveMany(
			{ persona: "deliverable-worker", inherit: { modelId: "gw1/parent" } },
			3,
		);
		expect(slots).toHaveLength(1);
		expect(slots[0]).toMatchObject({
			source: "inherit",
			modelId: "gw1/parent",
		});
	});

	it("returns one slot per DISTINCT family", () => {
		// standard = [OpenAI/Sol, Moonshot/Kimi] — two families.
		const slots = router().resolveMany(
			{ persona: "deliverable-worker", tier: "standard" },
			2,
		);
		expect(slots).toHaveLength(2);
		expect(slots.map((s) => s.family)).toEqual(["OpenAI", "Moonshot"]);
		expect(slots.every((s) => s.source === "tier")).toBe(true);
	});

	it("never pads beyond the families the tier actually holds", () => {
		// Asking for 5 from a two-family tier yields 2 — not 5, and not 2 real
		// plus 3 seat copies dressed up as diversity.
		const slots = router().resolveMany(
			{ persona: "deliverable-worker", tier: "standard" },
			5,
		);
		expect(slots).toHaveLength(2);
		expect(new Set(slots.map((s) => s.family)).size).toBe(2);
	});

	it("degrades to fewer slots when the region/auth strikes a family", () => {
		// Kimi is gw2-only; strike it and Moonshot has nothing left.
		const slots = router({ unavailable: ["gw2/kimi"] }).resolveMany(
			{ persona: "deliverable-worker", tier: "standard" },
			2,
		);
		expect(slots).toHaveLength(1);
		expect(slots[0]).toMatchObject({ source: "tier", family: "OpenAI" });
	});

	it("falls back to ONE seat slot when every alias is struck", () => {
		// The degradation case that must not silently produce an empty list: one
		// usable review is a review; zero is a silent hole.
		const slots = router({
			unavailable: ["gw1/sol", "gw2/sol", "gw2/kimi"],
		}).resolveMany({ persona: "deliverable-worker", tier: "standard" }, 3);
		expect(slots).toHaveLength(1);
		expect(slots[0]).toMatchObject({ source: "fallback", modelId: "gw2/seat" });
		expect(slots[0].fallbackReason).toContain("unavailable");
	});

	it("keeps the allowance bound — top-N is not an escape hatch", () => {
		expect(() =>
			router().resolveMany({ persona: "deliverable-worker", tier: "light" }, 3),
		).toThrow("outside persona deliverable-worker's allowance");
	});

	it("carries the same candidate facts on every slot", () => {
		// Explain output must not degrade just because the caller asked for N.
		const slots = router().resolveMany(
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
	it("uses the shipped default for code-review", () => {
		expect(router().spreadFor("code-review")).toBe(3);
	});

	it("honors an authored spread", () => {
		expect(
			router({
				settings: settingsWith({
					allowances: {
						"deliverable-worker": { tiers: ["standard", "heavy"] },
						"code-review": { tiers: ["standard"], spread: 2 },
					},
				}),
			}).spreadFor("code-review"),
		).toBe(2);
	});

	it("keeps the default when an author narrows tiers without saying spread", () => {
		// allowances merge SHALLOWLY, so authoring `code-review: { tiers: [...] }`
		// replaces the whole default object. Without the explicit fallback this
		// would silently disable multi-modal review for anyone who ever narrowed
		// a tier list.
		expect(
			router({
				settings: settingsWith({
					allowances: {
						"deliverable-worker": { tiers: ["standard", "heavy"] },
						"code-review": { tiers: ["heavy"] },
					},
				}),
			}).spreadFor("code-review"),
		).toBe(3);
	});

	it("is 1 for personas with no spread anywhere", () => {
		// An authored multiModal flag then degrades to one review, never errors.
		expect(router().spreadFor("codebase-research")).toBe(1);
		expect(router().spreadFor("never-heard-of-it")).toBe(1);
	});

	it("rejects a spread above the cap at parse time", () => {
		const settings = settingsWith({
			allowances: { "code-review": { tiers: ["heavy"], spread: 99 } },
		});
		expect(() => parseModelsSettings({}, settings)).toThrow(
			"spread: must be an integer 1..5",
		);
		// The config is rejected, so the reader falls back to the shipped default
		// rather than honoring 99 — runaway fan-out is real money.
		expect(router({ settings }).spreadFor("code-review")).toBe(3);
	});

	it("rejects a non-integer spread", () => {
		expect(
			router({
				settings: settingsWith({
					allowances: { "code-review": { tiers: ["heavy"], spread: 2.5 } },
				}),
			}).spreadFor("code-review"),
		).toBe(3);
	});
});

// ─── other-family ────────────────────────────────────────────────────────────
// The model selector for a DIRECT (non-fanned) spawn. `other-family` walks the
// allowance's tiers in order and takes the first available entry whose family
// differs from the caller's — a reviewer never marks its own homework. With
// nowhere to go it falls back to inherit WITH a fallbackReason, never silently.

describe("resolveOtherFamily", () => {
	// A caller on OpenAI (Sol's gw1 attachment) asking through the standard-then-
	// heavy allowance: standard leads with OpenAI/Sol (same family — skipped),
	// then Moonshot/Kimi wins deterministically.
	const OTHER_FAMILY = settingsWith({
		allowances: {
			"code-review": { tiers: ["standard", "heavy"], direct: "other-family" },
		},
	});

	it("picks the first foreign-family entry, walking tiers in order", () => {
		const resolution = router({ settings: OTHER_FAMILY }).resolveOtherFamily({
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

	it("exposes the selector it was authored under", () => {
		expect(router({ settings: OTHER_FAMILY }).directFor("code-review")).toBe(
			"other-family",
		);
		expect(router().directFor("deliverable-worker")).toBe("inherit");
	});

	it("walks into the next tier when the first holds only the caller's family", () => {
		// standard reduced to OpenAI only; heavy holds Anthropic — the walk must
		// cross the tier boundary rather than settle for its own family.
		const resolution = router({
			settings: {
				models: {
					...(OTHER_FAMILY as { models: Record<string, unknown> }).models,
					rosters: {
						daily: {
							...SETTINGS.models.rosters.daily,
							standard: ["OpenAI/Sol"],
						},
					},
				},
			},
		}).resolveOtherFamily({
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

	it("falls back to inherit WITH a reason when every family is the caller's", () => {
		// An all-OpenAI roster leaves other-family nowhere to go. Falling back to
		// a tier pick would mark its own homework; inheriting silently would hide
		// the degradation. It inherits, and says why.
		const resolution = router({
			settings: {
				models: {
					...(OTHER_FAMILY as { models: Record<string, unknown> }).models,
					rosters: {
						daily: {
							light: ["OpenAI/Quick"],
							standard: ["OpenAI/Sol"],
							heavy: ["OpenAI/Quick"],
						},
					},
				},
			},
		}).resolveOtherFamily({
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

	it("falls back with a reason when the caller's family is unknown", () => {
		const configured = router({ settings: OTHER_FAMILY });
		// No inherit at all: nothing to differ from — do not guess.
		const noCaller = configured.resolveOtherFamily({ persona: "code-review" });
		expect(noCaller.source).toBe("inherit");
		expect(noCaller.fallbackReason).toContain("caller's model is unknown");
		// A caller model attached to no alias: equally unknowable.
		const noFamily = configured.resolveOtherFamily({
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

describe("resolveFamily", () => {
	// The subagent tool's `family` parameter — how a fan-out lead starts one
	// member per family. The lookup is the guard, and there is no fallback: a
	// member requested as one family and run as another would be the fan-out
	// lying about its own diversity.

	it("resolves a named family through the persona's tiers", () => {
		const resolution = router().resolveFamily({
			persona: "deliverable-worker",
			family: "Moonshot",
			inherit: { modelId: "gw1/sol" },
		});
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw2/kimi",
			family: "Moonshot",
			tier: "standard",
		});
	});

	it("walks into the next tier when the first misses the family", () => {
		// Anthropic lives in heavy only; standard is walked first and passed by.
		const resolution = router().resolveFamily({
			persona: "deliverable-worker",
			family: "Anthropic",
		});
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw1/opus",
			family: "Anthropic",
			tier: "heavy",
		});
	});

	it("refuses an unknown family, naming what the roster reaches", () => {
		// The refusal teaches: a lead that misspells a family learns the real
		// names rather than a bare no.
		expect(() =>
			router().resolveFamily({
				persona: "deliverable-worker",
				family: "Google",
			}),
		).toThrow(/reaches: OpenAI, Moonshot, Anthropic/);
	});

	it("refuses a family whose every attachment is struck — never substitutes", () => {
		expect(() =>
			router({ unavailable: ["gw2/kimi"] }).resolveFamily({
				persona: "deliverable-worker",
				family: "Moonshot",
			}),
		).toThrow(/no available model in family Moonshot/);
	});

	it("refuses when no roster is configured at all", () => {
		expect(() =>
			router({ settings: {} }).resolveFamily({
				persona: "deliverable-worker",
				family: "Moonshot",
			}),
		).toThrow(/no v2 roster is configured/);
	});
});

// ─── resolveForRole ──────────────────────────────────────────────────────────
// The entry point a host binds a role through. It never throws: a host degrades
// to its own deterministic behaviour rather than wedging on a config mistake.

describe("resolveForRole", () => {
	it("uses the persona's default tier when the caller names none", () => {
		expect(router().resolveForRole("codebase-research")).toMatchObject({
			source: "tier",
			tier: "light",
			modelId: "gw1/quick",
		});
	});

	it("routes family: 'other' through the other-family walk", () => {
		expect(
			router({
				settings: settingsWith({
					allowances: { "code-review": { tiers: ["standard", "heavy"] } },
				}),
			}).resolveForRole("code-review", {
				family: "other",
				inherit: { modelId: "gw1/sol" },
			}),
		).toMatchObject({ family: "Moonshot", modelId: "gw2/kimi" });
	});

	it("routes a named family through the family walk", () => {
		expect(
			router().resolveForRole("deliverable-worker", { family: "Anthropic" }),
		).toMatchObject({ family: "Anthropic", modelId: "gw1/opus" });
	});

	it("treats family: 'same' as no family constraint", () => {
		expect(
			router().resolveForRole("deliverable-worker", {
				tier: "standard",
				family: "same",
			}),
		).toMatchObject({ family: "OpenAI" });
	});

	it("clamps a requested effort into the alias allowlist", () => {
		// Sol allows {medium, high}; a request for minimal lands on medium, the
		// lowest level above it.
		expect(
			router().resolveForRole("deliverable-worker", {
				tier: "standard",
				effort: "minimal",
			})?.effort,
		).toBe("high");
	});

	it("returns null rather than throwing on an unreachable request", () => {
		expect(
			router().resolveForRole("deliverable-worker", { family: "Google" }),
		).toBeNull();
		expect(
			router({ settings: {} }).resolveForRole("code-review", {
				tier: "heavy",
			}),
		).toBeNull();
	});
});

// ─── replay revalidation ─────────────────────────────────────────────────────
// A stored resolution is re-used verbatim and only re-authorized, so a run that
// resumes on a host that lost a model fails by name instead of rerouting.

describe("isAuthorized", () => {
	it("is true for a registered, authenticated, in-region model", () => {
		expect(router().isAuthorized("gw1/sol")).toBe(true);
	});

	it("is false once the model, its credentials or its region go away", () => {
		expect(router({ unavailable: ["gw1/sol"] }).isAuthorized("gw1/sol")).toBe(
			false,
		);
		expect(router().isAuthorized("gw9/sol")).toBe(false);
		expect(
			router({
				settings: settingsWith({
					region: { active: "EEA", lists: { EEA: ["gw2/*"] } },
				}),
			}).isAuthorized("gw1/sol"),
		).toBe(false);
	});
});
