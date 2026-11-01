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
				fast: ["OpenAI/Quick"],
				light: ["OpenAI/Sol", "Moonshot/Kimi"],
				frontier: ["Anthropic/Opus"],
			},
		},
		bindings: { main: { roster: "daily" } },
		// The built-in deliverable-worker default is empty (inherit the session
		// model), so these tier-mechanics tests configure it explicitly. The
		// default is covered separately in "default persona allowances".
		allowances: { "deliverable-worker": { tiers: ["light", "frontier"] } },
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
			tier: "light",
			inherit: { modelId: "gw2/seat", effort: "medium" },
		});
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw2/sol",
			family: "OpenAI",
			alias: "Sol",
			attachmentProvider: "gw2",
			tier: "light",
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
		}).resolve({ persona: "deliverable-worker", tier: "light" });
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
		}).resolve({ persona: "deliverable-worker", tier: "light" });
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
			tier: "fast",
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
		// deliverable-worker is configured here as {light, frontier} — fast is out.
		expect(() =>
			router().resolve({ persona: "deliverable-worker", tier: "fast" }),
		).toThrow(ModelResolutionError);
		// codebase-research's allowance includes fast.
		const resolution = router().resolve({
			persona: "codebase-research",
			tier: "fast",
		});
		expect(resolution.modelId).toBe("gw1/quick");
	});

	it("resolves a persona-keyed allowance authored in settings", () => {
		// A free-text persona key is a first-class allowance — nothing enumerates
		// valid personas at parse time.
		const settings = settingsWith({
			allowances: { "deep-research": { tiers: ["frontier"] } },
		});
		expect(router({ settings }).defaultTierFor("deep-research")).toBe(
			"frontier",
		);
		const resolution = router({ settings }).resolve({
			persona: "deep-research",
			tier: "frontier",
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
		expect(configured.defaultTierFor("code-review")).toBe("light");
		expect(configured.defaultTierFor("adjudication")).toBe("frontier");
		expect(configured.defaultTierFor("standby")).toBe("frontier");
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
				allowances: { reviewer: { tiers: ["fast"] } },
			}),
		});
		expect(configured.defaultTierFor("code-review")).toBe("light");
		expect(configured.defaultTierFor("reviewer")).toBe("fast");
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
		}).resolve({ persona: "deliverable-worker", tier: "light" });
		expect(resolution.modelId).toBe("gw1/sol");
	});

	it("a region that strikes the whole tier falls back — never fail-open", () => {
		const resolution = router({
			settings: settingsWith({
				region: { active: "EEA", lists: { EEA: ["gw9/*"] } },
			}),
		}).resolve({ persona: "deliverable-worker", tier: "light" });
		expect(resolution.source).toBe("fallback");
		expect(resolution.modelId).toBe("gw2/seat");
	});

	// Mirrors the real SIT tripwire (see reference-gateway-region-models): a
	// functional but NON-EEA model (US-data-share Fable, here gw2/fable) leads the
	// frontier tier; under EEA it is struck and resolution lands on the EEA-legal
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
					fast: ["Anthropic/Opus"],
					light: ["Anthropic/Opus"],
					frontier: ["Anthropic/Fable", "Anthropic/Opus"],
				},
			},
			bindings: { main: { roster: "daily" } },
			allowances: { "code-review": { tiers: ["frontier"] } },
			region: {
				active: "EEA",
				lists: { Global: ["gw1/*", "gw2/*"], EEA: ["gw1/*"] },
			},
		};

		it("EEA skips the non-EEA model and lands on the EEA-legal one", () => {
			const resolution = router({
				seat: "gw1/seat",
				settings: { models: TRIPWIRE },
			}).resolve({ persona: "code-review", tier: "frontier" });
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
			}).resolve({ persona: "code-review", tier: "frontier" });
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
			tier: "light",
			inherit: { modelId: "gw2/seat" },
		});
		expect(resolution).toMatchObject({
			source: "fallback",
			modelId: "gw2/seat",
			tier: "light",
		});
		expect(resolution.fallbackReason).toContain("unavailable");
		expect(fallbackNotice(resolution)).toContain("running on the session");
	});

	it("an empty tier falls back with an accurate reason", () => {
		const resolution = router({
			settings: settingsWith({
				rosters: { daily: { ...SETTINGS.models.rosters.daily, frontier: [] } },
			}),
		}).resolve({ persona: "deliverable-worker", tier: "frontier" });
		expect(resolution.source).toBe("fallback");
		expect(resolution.fallbackReason).toContain("empty");
	});
});

describe("failure semantics", () => {
	it("throws visibly when a tier is requested with no config or no binding", () => {
		expect(() =>
			router({ settings: {} }).resolve({
				persona: "deliverable-worker",
				tier: "light",
			}),
		).toThrow("no v2 roster");

		expect(() =>
			router({
				settings: {
					models: {
						families: SETTINGS.models.families,
						rosters: SETTINGS.models.rosters,
						bindings: { main: { targets: ["gw9/other"], roster: "daily" } },
						// The persona must allow light to reach the binding check.
						allowances: { "deliverable-worker": { tiers: ["light"] } },
					},
				},
			}).resolve({ persona: "deliverable-worker", tier: "light" }),
		).toThrow("no binding is active");
	});
});

describe("explain output", () => {
	it("renders every ref's fact and the allowance verdict", () => {
		const explained = router().explain("deliverable-worker", "light");
		expect(explained.allowed).toBe(true);
		expect(explained.bindingId).toBe("main");
		expect(explained.rosterId).toBe("daily");
		expect(explained.candidates).toHaveLength(2);

		expect(router().explain("deliverable-worker", "fast").allowed).toBe(false);
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
			tier: "light" as const,
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
		// light = [OpenAI/Sol, Moonshot/Kimi] — two families.
		const slots = router().resolveMany(
			{ persona: "deliverable-worker", tier: "light" },
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
			{ persona: "deliverable-worker", tier: "light" },
			5,
		);
		expect(slots).toHaveLength(2);
		expect(new Set(slots.map((s) => s.family)).size).toBe(2);
	});

	it("degrades to fewer slots when the region/auth strikes a family", () => {
		// Kimi is gw2-only; strike it and Moonshot has nothing left.
		const slots = router({ unavailable: ["gw2/kimi"] }).resolveMany(
			{ persona: "deliverable-worker", tier: "light" },
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
		}).resolveMany({ persona: "deliverable-worker", tier: "light" }, 3);
		expect(slots).toHaveLength(1);
		expect(slots[0]).toMatchObject({ source: "fallback", modelId: "gw2/seat" });
		expect(slots[0].fallbackReason).toContain("unavailable");
	});

	it("keeps the allowance bound — top-N is not an escape hatch", () => {
		expect(() =>
			router().resolveMany({ persona: "deliverable-worker", tier: "fast" }, 3),
		).toThrow("outside persona deliverable-worker's allowance");
	});

	it("carries the same candidate facts on every slot", () => {
		// Explain output must not degrade just because the caller asked for N.
		const slots = router().resolveMany(
			{ persona: "deliverable-worker", tier: "light" },
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
						"deliverable-worker": { tiers: ["light", "frontier"] },
						"code-review": { tiers: ["light"], spread: 2 },
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
						"deliverable-worker": { tiers: ["light", "frontier"] },
						"code-review": { tiers: ["frontier"] },
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
			allowances: { "code-review": { tiers: ["frontier"], spread: 99 } },
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
					allowances: { "code-review": { tiers: ["frontier"], spread: 2.5 } },
				}),
			}).spreadFor("code-review"),
		).toBe(3);
	});
});

// ─── explicit effort ─────────────────────────────────────────────────────────
// Three inputs, kept apart: an explicit request beats the alias default, which
// beats the inherited level. Every one is clamped to the alias allowlist ∩ what
// the model supports, so "the first lever on a dependent chain" — an effort
// step on the same alias — actually moves the level.

describe("explicit effort", () => {
	it("beats the alias default and the inherited level inside the allowlist", () => {
		// Sol defaults to high and allows {medium, high}; the caller runs high.
		const resolution = router().resolve({
			persona: "deliverable-worker",
			tier: "light",
			effort: "medium",
			inherit: { modelId: "gw2/seat", effort: "high" },
		});
		expect(resolution).toMatchObject({ alias: "Sol", effort: "medium" });
		expect(resolution.fallbackReason).toBeUndefined();
	});

	it("clamps a level outside the allowlist to the nearest below, else the lowest above", () => {
		const at = (effort: ThinkingLevel) =>
			router().resolve({ persona: "deliverable-worker", tier: "light", effort })
				.effort;
		// Sol allows {medium, high}: max steps down to high, off steps up to medium.
		expect(at("max")).toBe("high");
		expect(at("off")).toBe("medium");
	});

	it("clamps to the levels the model supports, not only the allowlist", () => {
		// Kimi has no allowlist and its model maps neither xhigh nor max.
		expect(
			router({ unavailable: ["gw1/sol", "gw2/sol"] }).resolve({
				persona: "deliverable-worker",
				tier: "light",
				effort: "max",
			}),
		).toMatchObject({ alias: "Kimi", effort: "high" });
	});

	it("loses to an alias that pins its effort, and the answer says so", () => {
		// Quick fixes effort low with no allowlist: a pin, answered as authored.
		const refused = router().resolve({
			persona: "codebase-research",
			tier: "fast",
			effort: "high",
		});
		expect(refused).toMatchObject({
			source: "tier",
			alias: "Quick",
			effort: "low",
		});
		expect(refused.fallbackReason).toBe(
			"effort high requested but alias OpenAI/Quick pins effort low",
		);
		// Asking for the pinned level is no refusal.
		expect(
			router().resolve({
				persona: "codebase-research",
				tier: "fast",
				effort: "low",
			}).fallbackReason,
		).toBeUndefined();
	});

	it("beats the inherited level on an inherit, clamped to the model", () => {
		expect(
			router().resolve({
				persona: "deliverable-worker",
				effort: "low",
				inherit: { modelId: "gw1/parent", effort: "high" },
			}),
		).toMatchObject({
			source: "inherit",
			modelId: "gw1/parent",
			effort: "low",
		});
		expect(
			router().resolve({
				persona: "deliverable-worker",
				effort: "xhigh",
				inherit: { modelId: "gw1/parent", effort: "low" },
			}).effort,
		).toBe("high");
	});

	it("beats the inherited level on a seat fallback, clamped to the seat", () => {
		expect(
			router({ unavailable: ["gw1/sol", "gw2/sol", "gw2/kimi"] }).resolve({
				persona: "deliverable-worker",
				tier: "light",
				effort: "xhigh",
				inherit: { modelId: "gw2/seat", effort: "low" },
			}),
		).toMatchObject({
			source: "fallback",
			modelId: "gw2/seat",
			effort: "high",
		});
	});

	it("reaches the router through resolveForRole without touching the seat's level", () => {
		const r = router();
		expect(
			r.resolveForRole("deliverable-worker", {
				tier: "light",
				effort: "medium",
				inherit: { modelId: "gw2/seat", effort: "high" },
			})?.effort,
		).toBe("medium");
		// With no explicit level the alias default still wins over the seat's.
		expect(
			r.resolveForRole("deliverable-worker", {
				tier: "light",
				inherit: { modelId: "gw2/seat", effort: "medium" },
			})?.effort,
		).toBe("high");
	});
});

// ─── other-family ────────────────────────────────────────────────────────────
// The model selector for a DIRECT (non-fanned) spawn. `other-family` walks the
// allowance's tiers in order and takes the first available entry whose family
// differs from the caller's — a reviewer never marks its own homework. With
// nowhere to go it falls back to inherit WITH a fallbackReason, never silently.

describe("resolveOtherFamily", () => {
	// A caller on OpenAI (Sol's gw1 attachment) asking through the light-then-
	// frontier allowance: light leads with OpenAI/Sol (same family — skipped),
	// then Moonshot/Kimi wins deterministically.
	const OTHER_FAMILY = settingsWith({
		allowances: {
			"code-review": { tiers: ["light", "frontier"], direct: "other-family" },
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
			tier: "light",
		});
	});

	it("exposes the selector it was authored under", () => {
		expect(router({ settings: OTHER_FAMILY }).directFor("code-review")).toBe(
			"other-family",
		);
		expect(router().directFor("deliverable-worker")).toBe("inherit");
	});

	it("walks into the next tier when the first holds only the caller's family", () => {
		// light reduced to OpenAI only; frontier holds Anthropic — the walk must
		// cross the tier boundary rather than settle for its own family.
		const resolution = router({
			settings: {
				models: {
					...(OTHER_FAMILY as { models: Record<string, unknown> }).models,
					rosters: {
						daily: {
							...SETTINGS.models.rosters.daily,
							light: ["OpenAI/Sol"],
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
			tier: "frontier",
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
							fast: ["OpenAI/Quick"],
							light: ["OpenAI/Sol"],
							frontier: ["OpenAI/Quick"],
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
			tier: "light",
		});
	});

	it("walks into the next tier when the first misses the family", () => {
		// Anthropic lives in frontier only; light is walked first and passed by.
		const resolution = router().resolveFamily({
			persona: "deliverable-worker",
			family: "Anthropic",
		});
		expect(resolution).toMatchObject({
			source: "tier",
			modelId: "gw1/opus",
			family: "Anthropic",
			tier: "frontier",
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
		// The seat is on gw2, so Sol's gw2 attachment jumps the queue.
		expect(router().resolveForRole("codebase-research")).toMatchObject({
			source: "tier",
			tier: "light",
			modelId: "gw2/sol",
		});
	});

	it("resolves the built-in adjudication persona at frontier", () => {
		expect(router().resolveForRole("adjudication")).toMatchObject({
			source: "tier",
			tier: "frontier",
			modelId: "gw1/opus",
			family: "Anthropic",
		});
	});

	it("routes family: 'other' through the other-family walk", () => {
		expect(
			router({
				settings: settingsWith({
					allowances: { "code-review": { tiers: ["light", "frontier"] } },
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
				tier: "light",
				family: "same",
			}),
		).toMatchObject({ family: "OpenAI" });
	});

	it("clamps a requested effort into the alias allowlist", () => {
		// Sol allows {medium, high}; a request for minimal lands on medium, the
		// lowest level above it.
		expect(
			router().resolveForRole("deliverable-worker", {
				tier: "light",
				effort: "minimal",
			})?.effort,
		).toBe("medium");
	});

	it("returns null rather than throwing on an unreachable request", () => {
		expect(
			router().resolveForRole("deliverable-worker", { family: "Google" }),
		).toBeNull();
		expect(
			router({ settings: {} }).resolveForRole("code-review", {
				tier: "frontier",
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
