// The radicalai-sit gateway profile, validated deterministically — no gateway,
// no credentials (the pure builder takes an injected token). Owns the routing
// correctness under the v2 resolver: opus is the planner seat and the review
// family (heavy tier), sol is the worker/utility family (standard/light) — so a
// review lands on a different family than the sol workers, cross-family by
// construction, before the diversity walk is even wired.

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
import { SIT_CATALOG, sitProfileFromToken } from "./sit-profile.js";

const PROFILE = sitProfileFromToken("test-token");
const SESSION = `${PROFILE.defaultProvider}/${PROFILE.defaultModel}`;

const OPUS = "sit-anthropic/claude-opus-4-8";
const SOL = "sit-openai/gpt-5.6-sol";

let cwd: string;
let previousAgentDir: string | undefined;

function gatewayModel(ref: string) {
	const slash = ref.indexOf("/");
	return {
		provider: ref.slice(0, slash),
		id: ref.slice(slash + 1),
		name: ref,
		reasoning: true,
		thinkingLevelMap: {},
	};
}

function fakeCtx(
	options: { unavailable?: readonly string[] } = {},
): ExtensionContext {
	const entries = new Map(
		SIT_CATALOG.map(gatewayModel).map((entry) => [
			`${entry.provider}/${entry.id}`,
			entry,
		]),
	);
	const unavailable = new Set(options.unavailable ?? []);
	return {
		cwd,
		model: entries.get(SESSION),
		modelRegistry: {
			find: (provider: string, id: string) => entries.get(`${provider}/${id}`),
			getApiKeyAndHeaders: async (entry: { provider: string; id: string }) => {
				const id = `${entry.provider}/${entry.id}`;
				if (unavailable.has(id)) return { ok: false, error: "not served" };
				return { ok: true, apiKey: "test-token", headers: {} };
			},
		},
	} as unknown as ExtensionContext;
}

/**
 * Resolve a v1 role exactly the way a plan node does (context.ts resolveModel):
 * map the role to a v2 agent type, take that type's default tier, and resolve
 * through the active binding's roster — the real routing path, not the retired
 * v1 exact-selection one.
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
	cwd = join(tmpdir(), `e2e-sit-profile-${process.pid}`);
	const agentDir = join(cwd, ".agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ models: PROFILE.models }),
	);
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
});

describe("radicalai-sit profile", () => {
	it("embeds the token only in models.json, never in the settings block", () => {
		expect(PROFILE.modelsJsonContent).toContain("test-token");
		expect(JSON.stringify(PROFILE.models)).not.toContain("test-token");
	});

	it("maps every MODEL_ROLE to a spawnable agent type — no role falls through", () => {
		for (const role of MODEL_ROLES) {
			expect(
				SPAWNABLE_AGENT_TYPES as readonly string[],
				`role ${role} maps to an unknown agent type`,
			).toContain(agentTypeForRole(role));
		}
	});

	it("routes workers to sol and reviews to opus — cross-family by construction", async () => {
		// worker/verifier → worker → standard → sol
		expect(await modelFor("worker")).toBe(SOL);
		expect(await modelFor("verifier")).toBe(SOL);
		// classify/summarize/research → explorer → light → sol
		expect(await modelFor("classifier")).toBe(SOL);
		expect(await modelFor("codebase-research")).toBe(SOL);
		// *-review → reviewer → heavy → opus (a different family from the workers)
		expect(await modelFor("security-review")).toBe(OPUS);
		expect(await modelFor("plan-review")).toBe(OPUS);
		// advisor → advisor → heavy → opus
		expect(await modelFor("advisor")).toBe(OPUS);
	});

	it("falls back to the opus session seat when sol is unavailable", async () => {
		expect(await modelFor("worker", fakeCtx({ unavailable: [SOL] }))).toBe(
			OPUS,
		);
	});
});
