// The multi-model ollama profile, validated deterministically — no ollama, no pi
// boot. It proves the generated v2 block (families/rosters/bindings/allowances)
// is *valid* and that each maestro agent type resolves to the intended local
// model, so a regression in the profile is caught in CI rather than only
// surfacing during a manual live drive.
//
// The live drive (docs/e2e-testing.md, drive-maestro-e2e skill) then confirms
// ollama actually serves those models; this test owns the routing correctness.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	MODEL_ROLES,
	type ModelRole,
	SPAWNABLE_AGENT_TYPES,
} from "@vegardx/pi-contracts";
import {
	agentTypeForRole,
	defaultTierForAgent,
	resolveV2Model,
} from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MULTI_MODEL_CATALOG,
	MULTI_MODEL_OLLAMA,
} from "./multi-model-profile.js";

let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;

const SESSION = `${MULTI_MODEL_OLLAMA.defaultProvider}/${MULTI_MODEL_OLLAMA.defaultModel}`;
const QWEN = "ollama/qwen3.6:35b-a3b-coding-mxfp8";
const GPTOSS = "ollama/gpt-oss:20b";
const GEMMA = "ollama/gemma4:31b-mlx";

/** A registry entry for one ollama model; all efforts supported (reasoning true). */
function ollamaModel(id: string) {
	return {
		provider: MULTI_MODEL_OLLAMA.defaultProvider,
		id,
		name: `${MULTI_MODEL_OLLAMA.defaultProvider}/${id}`,
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: {},
	};
}

function fakeCtx(
	options: { unavailable?: readonly string[]; seat?: string } = {},
): ExtensionContext {
	const entries = new Map(
		MULTI_MODEL_CATALOG.map(ollamaModel).map((entry) => [
			`${entry.provider}/${entry.id}`,
			entry,
		]),
	);
	const unavailable = new Set(options.unavailable ?? []);
	return {
		cwd,
		model: entries.get(options.seat ?? SESSION),
		modelRegistry: {
			find: (provider: string, id: string) => entries.get(`${provider}/${id}`),
			getApiKeyAndHeaders: async (entry: { provider: string; id: string }) => {
				const id = `${entry.provider}/${entry.id}`;
				if (unavailable.has(id)) return { ok: false, error: "not served" };
				return { ok: true, apiKey: "ollama", headers: {} };
			},
		},
	} as unknown as ExtensionContext;
}

/**
 * Resolve a v1 role the way a plan node does (context.ts resolveModel): map it
 * to a v2 agent type, take that type's default tier, resolve through the active
 * binding's roster. The real routing path, not the retired v1 exact selection.
 */
async function modelFor(
	role: ModelRole,
	ctx: ExtensionContext = fakeCtx(),
): Promise<string | undefined> {
	const agent = agentTypeForRole(role);
	const tier = defaultTierForAgent(ctx, agent);
	const resolved = await resolveV2Model(ctx, {
		agent,
		...(tier ? { tier } : {}),
		inherit: { modelId: SESSION },
	});
	return resolved.modelId;
}

beforeEach(() => {
	cwd = join(
		tmpdir(),
		`e2e-multi-model-${process.pid}-${MULTI_MODEL_CATALOG.length}`,
	);
	agentDir = join(cwd, ".agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// The profile writes `models` to the isolated agent dir in production; here we
	// place it in project settings — readV2Config merges both the same way.
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ models: MULTI_MODEL_OLLAMA.models }),
	);
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
});

describe("multi-model ollama profile", () => {
	it("attaches only models the profile catalog defines", () => {
		const referenced = new Set<string>();
		const families = (
			MULTI_MODEL_OLLAMA.models as {
				families: Record<
					string,
					{ aliases: Record<string, { attach: string[] }> }
				>;
			}
		).families;
		for (const family of Object.values(families)) {
			for (const alias of Object.values(family.aliases)) {
				for (const spec of alias.attach) {
					referenced.add(spec.slice(spec.indexOf("/") + 1));
				}
			}
		}
		for (const id of referenced) expect(MULTI_MODEL_CATALOG).toContain(id);
	});

	it("inherits the seat with no tier; routes through the roster with one", async () => {
		const ctx = fakeCtx();
		// No tier requested → inherit the caller's model (the seat), not the roster.
		const inherited = await resolveV2Model(ctx, {
			agent: "worker",
			inherit: { modelId: SESSION },
		});
		expect(inherited.source).toBe("inherit");
		expect(inherited.modelId).toBe(GEMMA);
		// A deliberate tier → the roster's standard tier (the qwen coder).
		const routed = await resolveV2Model(ctx, {
			agent: "worker",
			tier: "standard",
			inherit: { modelId: SESSION },
		});
		expect(routed.source).toBe("tier");
		expect(routed.modelId).toBe(QWEN);
	});

	it("maps every MODEL_ROLE to a spawnable agent type — no role falls through", () => {
		for (const role of MODEL_ROLES) {
			expect(
				SPAWNABLE_AGENT_TYPES as readonly string[],
				`role ${role} maps to an unknown agent type`,
			).toContain(agentTypeForRole(role));
		}
	});

	it("routes each agent type to its intended local model", async () => {
		// worker / verifier → worker → standard → the MoE coder
		expect(await modelFor("worker")).toBe(QWEN);
		expect(await modelFor("verifier")).toBe(QWEN);
		// classify / summarize / research → explorer → light → gpt-oss
		expect(await modelFor("codebase-research")).toBe(GPTOSS);
		expect(await modelFor("classifier")).toBe(GPTOSS);
		expect(await modelFor("plan-summarizer")).toBe(GPTOSS);
		expect(await modelFor("general")).toBe(GPTOSS);
		// *-review → reviewer → heavy → gpt-oss (a DIFFERENT family from workers)
		expect(await modelFor("correctness-review")).toBe(GPTOSS);
		expect(await modelFor("adversarial-review")).toBe(GPTOSS);
	});

	it("falls back to the session seat when a tier's model is not served", async () => {
		// standard → MoE coder struck → the gemma seat (the resolver's fallback).
		expect(await modelFor("worker", fakeCtx({ unavailable: [QWEN] }))).toBe(
			GEMMA,
		);
		// light → gpt-oss struck → the gemma seat.
		expect(
			await modelFor("classifier", fakeCtx({ unavailable: [GPTOSS] })),
		).toBe(GEMMA);
	});

	it("falls the review tier back to the cross-family session seat", async () => {
		// heavy → gpt-oss unserved → the gemma seat (the cross-family last resort).
		expect(
			await modelFor("correctness-review", fakeCtx({ unavailable: [GPTOSS] })),
		).toBe(GEMMA);
	});
});
