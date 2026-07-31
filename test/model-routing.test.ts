// Persona-keyed model routing: the persona flows straight through to the
// allowance — the interim persona→agent-type bridge is gone, and this suite is
// what keeps it gone. Also the `direct` selector at the routing level: routeModel
// is where a DIRECT (non-fanned) spawn decides between inheriting and insisting
// on another family, and where a missing caller model degrades with a reason
// rather than a guess.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PERSONA_ALLOWANCES } from "@vegardx/pi-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	familiesIn,
	routeModel,
	routeSpawn,
	routeSpread,
} from "../packages/maestro/src/model-routing.js";
import { BUILT_IN_PERSONAS } from "../packages/maestro/src/personas.js";

// Isolate from the machine's real global settings — the config under test must
// be exactly what each case writes.
let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "model-routing-agent-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

// Two families on one gateway: the seat's own (OpenAI) and a foreign one.
const SETTINGS = {
	models: {
		families: {
			OpenAI: { aliases: { Sol: { attach: ["gw/sol"], effort: "medium" } } },
			Anthropic: { aliases: { Opus: { attach: ["gw/opus"] } } },
		},
		rosters: {
			daily: {
				light: ["OpenAI/Sol"],
				standard: ["OpenAI/Sol", "Anthropic/Opus"],
				heavy: ["Anthropic/Opus", "OpenAI/Sol"],
			},
		},
		bindings: { main: { roster: "daily" } },
		allowances: {},
	},
};

function makeCtx(settings: unknown = SETTINGS): ExtensionContext {
	const cwd = mkdtempSync(join(tmpdir(), "model-routing-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
	const model = (provider: string, id: string) => ({
		provider,
		id,
		name: `${provider}/${id}`,
		reasoning: true,
		thinkingLevelMap: {},
	});
	return {
		cwd,
		model: model("gw", "seat"),
		getThinkingLevel: () => "medium",
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "gw" ? model(provider, id) : undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
		},
	} as unknown as ExtensionContext;
}

function withAllowances(allowances: unknown) {
	return { models: { ...SETTINGS.models, allowances } };
}

function cleanup(ctx: ExtensionContext): void {
	rmSync(ctx.cwd, { recursive: true, force: true });
}

describe("persona-keyed routing", () => {
	it("keeps the built-in persona ids and the default allowance keys identical", () => {
		// The ids live in the maestro package, the defaults in contracts — two
		// packages, one vocabulary. This is the drift guard that replaces the
		// deleted persona→agent-type bridge: if either side renames, this fails.
		expect(Object.keys(DEFAULT_PERSONA_ALLOWANCES).sort()).toEqual(
			BUILT_IN_PERSONAS.map((persona) => persona.id).sort(),
		);
	});

	it("routes a persona straight to its allowance's default tier", async () => {
		const ctx = makeCtx(
			withAllowances({ "code-review": { tiers: ["heavy", "standard"] } }),
		);
		try {
			const routed = await routeModel(ctx, "code-review");
			expect(routed).toMatchObject({ modelId: "gw/opus", family: "Anthropic" });
		} finally {
			cleanup(ctx);
		}
	});

	it("returns undefined — inherit — for a persona with no allowance", async () => {
		// A guessed tier for an unknown persona would be a model nobody asked for.
		const ctx = makeCtx();
		try {
			expect(await routeModel(ctx, "never-declared")).toBeUndefined();
		} finally {
			cleanup(ctx);
		}
	});
});

describe("the direct selector", () => {
	const OTHER_FAMILY = withAllowances({
		"code-review": {
			tiers: ["standard", "heavy"],
			direct: "other-family",
		},
	});

	it("picks the first entry of a family that is not the caller's", async () => {
		const ctx = makeCtx(OTHER_FAMILY);
		try {
			// Caller is Sol (OpenAI); standard leads with OpenAI/Sol, so the first
			// foreign entry is Anthropic/Opus — deterministically, tiers in order.
			const routed = await routeModel(ctx, "code-review", {
				modelId: "gw/sol",
			});
			expect(routed).toMatchObject({ modelId: "gw/opus", family: "Anthropic" });
			expect(routed?.fallbackReason).toBeUndefined();
		} finally {
			cleanup(ctx);
		}
	});

	it("falls back to inherit with a reason when called without inherit info", async () => {
		const ctx = makeCtx(OTHER_FAMILY);
		try {
			// No caller model was threaded through: guessing whose homework this is
			// would defeat the selector, so it degrades — visibly.
			const routed = await routeModel(ctx, "code-review");
			expect(routed?.fallbackReason).toContain("caller's model is unknown");
		} finally {
			cleanup(ctx);
		}
	});

	it("falls back to inherit with a reason when only the caller's family exists", async () => {
		const ctx = makeCtx({
			models: {
				...OTHER_FAMILY.models,
				families: {
					OpenAI: {
						aliases: {
							Sol: { attach: ["gw/sol"] },
							Mini: { attach: ["gw/mini"] },
						},
					},
				},
				rosters: {
					daily: {
						light: [],
						standard: ["OpenAI/Mini"],
						heavy: ["OpenAI/Sol"],
					},
				},
			},
		});
		try {
			const routed = await routeModel(ctx, "code-review", {
				modelId: "gw/sol",
				effort: "high",
			});
			expect(routed).toMatchObject({ modelId: "gw/sol", effort: "high" });
			expect(routed?.fallbackReason).toContain("no model outside family");
		} finally {
			cleanup(ctx);
		}
	});
});

describe("routeSpread", () => {
	it("fans out one slot per family, honoring the allowance's spread", async () => {
		const ctx = makeCtx(
			withAllowances({
				"code-review": { tiers: ["standard"], spread: 3 },
			}),
		);
		try {
			const slots = await routeSpread(ctx, "code-review");
			// standard holds two families; asking for three never pads.
			expect(slots).toHaveLength(2);
			expect(familiesIn(slots)).toBe(2);
		} finally {
			cleanup(ctx);
		}
	});

	it("degrades to the single routeModel path for a spreadless persona", async () => {
		const ctx = makeCtx();
		try {
			expect(await routeSpread(ctx, "never-declared")).toEqual([]);
		} finally {
			cleanup(ctx);
		}
	});
});

describe("routeSpawn", () => {
	// The subagent tool's one routing entry. The dispatch used to live twice,
	// as identical lambdas in the seat and the agent runtime — two copies of a
	// dispatch is how one of them stops being wired.

	it("routes a family request to exactly that family", async () => {
		const ctx = makeCtx(
			withAllowances({ "code-review": { tiers: ["standard"] } }),
		);
		try {
			const slots = await routeSpawn(ctx, {
				persona: "code-review",
				fanOut: false,
				family: "Anthropic",
			});
			expect(slots).toHaveLength(1);
			expect(slots[0]).toMatchObject({
				modelId: "gw/opus",
				family: "Anthropic",
			});
		} finally {
			cleanup(ctx);
		}
	});

	it("lets a family refusal through, naming what exists", async () => {
		const ctx = makeCtx(
			withAllowances({ "code-review": { tiers: ["standard"] } }),
		);
		try {
			await expect(
				routeSpawn(ctx, {
					persona: "code-review",
					fanOut: false,
					family: "Google",
				}),
			).rejects.toThrow(/reaches: OpenAI, Anthropic/);
		} finally {
			cleanup(ctx);
		}
	});
});
