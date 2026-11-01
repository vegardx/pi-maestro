// The seat's router, as pi-workflow asks for it over the bus.
//
// pi-workflow is an optional peer and is not imported, so every literal this
// seat mirrors is pinned here by the value pi-workflow 8.0.0 ships
// (`src/model-routing-provider.ts` and `src/runtime/model-routing.ts` at
// contract revision 27). A drift in either package fails this file.

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, TIER_IDS } from "@vegardx/pi-models";
import { describe, expect, it } from "vitest";
import {
	createMaestroRoutingPort,
	DUPLICATE_ROUTER_REFUSAL,
	MAESTRO_ROUTER_ID,
	MAX_FALLBACK_REASON_LENGTH,
	MAX_MODEL_EVIDENCE_LENGTH,
	type MaestroRoutingPort,
	MODEL_ROUTING_REQUEST_CHANNEL,
	MODEL_ROUTING_REQUEST_SCHEMA,
	type ModelRoleRequest,
	ModelRoutingError,
	registerModelRoutingFor,
} from "../packages/maestro/src/workflow-routing-provider.js";
import {
	fakeRouting,
	LIGHT,
	MODELS_BLOCK,
	OTHER_FRONTIER,
	OTHER_NORMAL,
	SEAT,
} from "./fake-routing.js";

function fakeBus(): EventBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		emit(channel: string, data: unknown) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel: string, handler: (data: unknown) => void) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => {
				set.delete(handler);
			};
		},
	} as EventBus;
}

/** pi-workflow's `collect`: its exact request, emitted and collected. */
function collect(bus: EventBus): unknown[] {
	const answers: unknown[] = [];
	bus.emit("@vegardx/pi-workflow/model-routing-provider/request/v1", {
		schema: "pi-workflow-model-routing-request-v1",
		respond(port: unknown) {
			answers.push(port);
		},
	});
	return answers;
}

const SOURCES = ["inherit", "tier", "fallback", "static"];

/**
 * pi-workflow's `isModelResolution`, copied: the check every answer of this
 * port meets before a task is materialized.
 */
function isModelResolution(value: unknown): boolean {
	const evidence = (text: unknown, max = 128) =>
		text === undefined ||
		(typeof text === "string" && text.length > 0 && text.length <= max);
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.provider === "string" &&
		r.provider.length > 0 &&
		typeof r.id === "string" &&
		r.id.length > 0 &&
		typeof r.thinking === "string" &&
		(THINKING_LEVELS as readonly string[]).includes(r.thinking) &&
		typeof r.source === "string" &&
		SOURCES.includes(r.source) &&
		(r.tier === undefined ||
			(typeof r.tier === "string" &&
				(TIER_IDS as readonly string[]).includes(r.tier))) &&
		evidence(r.persona) &&
		evidence(r.family) &&
		evidence(r.alias) &&
		evidence(r.fallbackReason, 1024)
	);
}

function port(options: Parameters<typeof fakeRouting>[0] = {}) {
	return createMaestroRoutingPort(() => fakeRouting(options));
}

function resolved(p: MaestroRoutingPort, role: ModelRoleRequest) {
	const answer = p.resolve(role);
	expect(isModelResolution(answer)).toBe(true);
	return answer;
}

describe("what is mirrored from pi-workflow", () => {
	it("speaks pi-workflow's channel and request schema", () => {
		expect(MODEL_ROUTING_REQUEST_CHANNEL).toBe(
			"@vegardx/pi-workflow/model-routing-provider/request/v1",
		);
		expect(MODEL_ROUTING_REQUEST_SCHEMA).toBe(
			"pi-workflow-model-routing-request-v1",
		);
	});

	it("routes pi-workflow's four tiers and seven thinking levels", () => {
		// `MODEL_ROLE_TIERS` and `MODEL_ROLE_THINKING_LEVELS`.
		expect([...TIER_IDS]).toEqual(["fast", "light", "normal", "frontier"]);
		expect([...THINKING_LEVELS]).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("keeps pi-workflow's evidence bounds and its router id bound", () => {
		expect(MAX_MODEL_EVIDENCE_LENGTH).toBe(128);
		expect(MAX_FALLBACK_REASON_LENGTH).toBe(1024);
		expect(MAESTRO_ROUTER_ID.length).toBeGreaterThan(0);
		expect(MAESTRO_ROUTER_ID.length).toBeLessThanOrEqual(128);
		expect(DUPLICATE_ROUTER_REFUSAL).toBe(
			"A pi-workflow model routing provider is already registered.",
		);
	});
});

describe("the routing port", () => {
	it("walks a tier through the bound roster", () => {
		expect(resolved(port(), { persona: "code-review", tier: "light" })).toEqual(
			{
				provider: "anthropic",
				id: "haiku",
				thinking: "low",
				source: "tier",
				persona: "code-review",
				tier: "light",
				family: "Anthropic",
				alias: "Haiku",
			},
		);
		expect(
			resolved(port(), { persona: "code-review", tier: "normal" }),
		).toMatchObject({ provider: "anthropic", id: "opus", tier: "normal" });
	});

	it('picks a family other than the seat\'s for `family: "other"`', () => {
		const judge = resolved(port({ effort: "medium" }), {
			persona: "adjudication",
			tier: "frontier",
			family: "other",
		});
		expect(`${judge.provider}/${judge.id}`).toBe(OTHER_FRONTIER);
		expect(judge).toMatchObject({
			source: "tier",
			tier: "frontier",
			family: "OpenAI",
			alias: "SolPro",
			thinking: "high",
		});
		const lens = resolved(port(), {
			persona: "code-review",
			tier: "normal",
			family: "other",
		});
		expect(`${lens.provider}/${lens.id}`).toBe(OTHER_NORMAL);
	});

	// The router walks only the tier asked for another family: light holds only
	// the seat's family, so the lens inherits the seat and says which tier it
	// searched, rather than quietly answering from normal.
	it("inherits with a reason when the tier asked holds no other family", () => {
		const lens = resolved(port(), {
			persona: "code-review",
			tier: "light",
			family: "other",
		});
		expect(`${lens.provider}/${lens.id}`).toBe(SEAT);
		expect(lens.source).toBe("inherit");
		expect(lens.tier).toBeUndefined();
		expect(lens.fallbackReason).toMatch(/in tier light/);
	});

	it("refuses a tier outside the persona's allowance by name", () => {
		expect(() =>
			port().resolve({ persona: "code-review", tier: "frontier" }),
		).toThrow(ModelRoutingError);
		expect(() =>
			port().resolve({ persona: "code-review", tier: "frontier" }),
		).toThrow(/persona "code-review" at tier frontier/);
	});

	it("refuses a tier when no roster is configured", () => {
		expect(() =>
			port({ models: null }).resolve({ persona: "code-review", tier: "light" }),
		).toThrow(ModelRoutingError);
	});

	it("inherits the session's model and thinking level for a persona with no allowance", () => {
		expect(resolved(port({ effort: "high" }), { persona: "planner" })).toEqual({
			provider: "anthropic",
			id: "opus",
			thinking: "high",
			source: "inherit",
			persona: "planner",
		});
	});

	it("passes a requested effort, clamped to what Pi runs the model at", () => {
		// The seat's map names `xhigh` and not `max`.
		expect(
			resolved(port({ effort: "low" }), { persona: "planner", effort: "max" })
				.thinking,
		).toBe("xhigh");
		expect(
			resolved(port(), {
				persona: "code-review",
				tier: "normal",
				effort: "high",
			}).thinking,
		).toBe("high");
	});

	it("answers an alias's pinned effort over a requested one, and says so", () => {
		// SolPro pins high with no allowlist: the step to xhigh is refused.
		const judge = resolved(port({ effort: "low" }), {
			persona: "adjudication",
			tier: "frontier",
			family: "other",
			effort: "xhigh",
		});
		expect(judge).toMatchObject({
			alias: "SolPro",
			thinking: "high",
			source: "tier",
			fallbackReason:
				"effort xhigh requested but alias OpenAI/SolPro pins effort high",
		});
	});

	it("reports a fallback to the seat with its reason", () => {
		const answer = resolved(port({ authenticated: ["openai"] }), {
			persona: "code-review",
			tier: "light",
		});
		expect(`${answer.provider}/${answer.id}`).toBe(SEAT);
		expect(answer.source).toBe("fallback");
		expect(answer.fallbackReason).toMatch(/unavailable/);
	});

	it("reports an other-family request that had nowhere to go", () => {
		const answer = resolved(port({ authenticated: ["anthropic"] }), {
			persona: "adjudication",
			tier: "frontier",
			family: "other",
		});
		expect(`${answer.provider}/${answer.id}`).toBe(SEAT);
		expect(answer.source).toBe("inherit");
		expect(answer.fallbackReason).toMatch(/no model outside family Anthropic/);
	});

	it("bounds every evidence field to pi-workflow's limits", () => {
		const persona = `p${"x".repeat(1500)}`;
		const family = `F${"y".repeat(200)}`;
		const alias = `A${"z".repeat(200)}`;
		const routing = {
			models: {
				...MODELS_BLOCK,
				families: {
					[family]: {
						aliases: { [alias]: { attach: [LIGHT] }, Opus: { attach: [SEAT] } },
					},
					OpenAI: MODELS_BLOCK.families.OpenAI,
				},
				rosters: {
					r: {
						fast: [`${family}/${alias}`],
						light: [`${family}/${alias}`],
						normal: [`${family}/${alias}`],
						frontier: [`${family}/${alias}`],
					},
				},
				allowances: { [persona]: { tiers: ["light"] } },
			},
		};
		const picked = resolved(port(routing), { persona, tier: "light" });
		expect(picked.persona).toHaveLength(MAX_MODEL_EVIDENCE_LENGTH);
		expect(picked.persona?.endsWith("…")).toBe(true);
		expect(picked.family).toHaveLength(MAX_MODEL_EVIDENCE_LENGTH);
		expect(picked.alias).toHaveLength(MAX_MODEL_EVIDENCE_LENGTH);
		// No other family anywhere in the persona's tiers: the reason names the
		// persona, and runs past pi-workflow's bound without this port's cut.
		const nowhere = resolved(
			port({ ...routing, authenticated: ["anthropic"] }),
			{ persona, tier: "light", family: "other" },
		);
		expect(nowhere.fallbackReason).toHaveLength(MAX_FALLBACK_REASON_LENGTH);
	});

	it("authorizes exactly what the router would still hand out", () => {
		const p = port({ authenticated: ["anthropic"] });
		expect(p.authorized({ provider: "anthropic", id: "opus" })).toBe(true);
		expect(p.authorized({ provider: "openai", id: "sol" })).toBe(false);
		expect(p.authorized({ provider: "anthropic", id: "nowhere" })).toBe(false);
	});

	it("refuses by name with no live session, and authorizes nothing", () => {
		const p = createMaestroRoutingPort(() => {
			throw new Error("this session has been replaced");
		});
		expect(() => p.resolve({ persona: "code-review", tier: "light" })).toThrow(
			ModelRoutingError,
		);
		expect(p.authorized({ provider: "anthropic", id: "opus" })).toBe(false);
	});

	it("refuses a role it cannot read rather than guessing one", () => {
		expect(() =>
			port().resolve({ persona: "code-review", tier: "heavy" } as never),
		).toThrow(ModelRoutingError);
		expect(() => port().resolve({ persona: "" })).toThrow(ModelRoutingError);
	});

	it("names itself in run evidence", () => {
		expect(port().id).toBe("pi-maestro");
	});
});

describe("registration on the bus", () => {
	it("answers pi-workflow's request with the port", () => {
		const bus = fakeBus();
		expect(collect(bus)).toHaveLength(0);
		const registered = registerModelRoutingFor(bus, () => fakeRouting());
		expect("release" in registered).toBe(true);
		const answers = collect(bus);
		expect(answers).toHaveLength(1);
		const answered = answers[0] as MaestroRoutingPort;
		expect(answered.id).toBe(MAESTRO_ROUTER_ID);
		expect(
			answered.resolve({ persona: "codebase-research", tier: "light" }).id,
		).toBe("haiku");
		if ("release" in registered) registered.release();
		expect(collect(bus)).toHaveLength(0);
	});

	it("ignores a request that is not pi-workflow's", () => {
		const bus = fakeBus();
		registerModelRoutingFor(bus, () => fakeRouting());
		const answers: unknown[] = [];
		bus.emit(MODEL_ROUTING_REQUEST_CHANNEL, {
			schema: "something-else",
			respond: (port: unknown) => answers.push(port),
		});
		expect(answers).toHaveLength(0);
	});

	it("refuses a second router rather than throwing", () => {
		const bus = fakeBus();
		bus.on(MODEL_ROUTING_REQUEST_CHANNEL, (value) => {
			(value as { respond(port: unknown): void }).respond(undefined);
		});
		expect(registerModelRoutingFor(bus, () => fakeRouting())).toEqual({
			problem: DUPLICATE_ROUTER_REFUSAL,
		});
		expect(collect(bus)).toHaveLength(1);
	});
});
