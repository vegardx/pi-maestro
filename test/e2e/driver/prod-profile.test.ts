// The radicalai PROD gateway profile, validated deterministically — no gateway,
// no credentials (the pure builder takes an injected token). Mirrors
// sit-profile.test but for gateway.raicode.no: opus is the planner seat and the
// review family (heavy), sol is the worker/utility family (standard/light), so
// reviews land on a different family than the sol workers. Prod is all-EEA, so
// there is NO region tripwire — every model is EEA-legal.

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
	resolveModel,
} from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROD_CATALOG, prodProfileFromToken } from "./prod-profile.js";

const PROFILE = prodProfileFromToken("test-token");
const SESSION = `${PROFILE.defaultProvider}/${PROFILE.defaultModel}`;

const OPUS = "prod-anthropic/claude-opus-4-8";
const SOL = "prod-openai/gpt-5.6-sol";

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
		PROD_CATALOG.map(gatewayModel).map((entry) => [
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

/** Resolve a v1 role exactly the way a plan node does (context.ts resolveModel). */
async function modelFor(
	role: ModelRole,
	ctx: ExtensionContext = fakeCtx(),
): Promise<string | undefined> {
	const agent = agentTypeForRole(role);
	const tier = defaultTierForAgent(ctx, agent);
	const resolved = await resolveModel(ctx, {
		agent,
		...(tier ? { tier } : {}),
		inherit: { modelId: SESSION },
	});
	return resolved.modelId;
}

beforeEach(() => {
	cwd = join(tmpdir(), `e2e-prod-profile-${process.pid}`);
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

describe("radicalai prod profile", () => {
	it("embeds the token only in models.json, never in the settings block", () => {
		expect(PROFILE.modelsJsonContent).toContain("test-token");
		expect(JSON.stringify(PROFILE.models)).not.toContain("test-token");
	});

	it("targets gateway.raicode.no over the two protocols", () => {
		expect(PROFILE.modelsJsonContent).toContain("https://gateway.raicode.no");
		expect(PROFILE.modelsJsonContent).toContain(
			"https://gateway.raicode.no/v1",
		);
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
		expect(await modelFor("worker")).toBe(SOL);
		expect(await modelFor("verifier")).toBe(SOL);
		expect(await modelFor("classifier")).toBe(SOL);
		expect(await modelFor("codebase-research")).toBe(SOL);
		expect(await modelFor("security-review")).toBe(OPUS);
		expect(await modelFor("plan-review")).toBe(OPUS);
		expect(await modelFor("advisor")).toBe(OPUS);
	});

	it("falls back to the opus session seat when sol is unavailable", async () => {
		expect(await modelFor("worker", fakeCtx({ unavailable: [SOL] }))).toBe(
			OPUS,
		);
	});

	it("has no region tripwire — heavy resolves to opus and it is EEA-legal", async () => {
		// Prod is all-EEA: unlike SIT, no model is struck by the region filter.
		const resolved = await resolveModel(fakeCtx(), {
			agent: "reviewer",
			tier: "heavy",
			inherit: { modelId: SESSION },
		});
		expect(resolved.modelId).toBe(OPUS);
		const opus = resolved.candidates?.find(
			(f) => f.ref === "Anthropic/Opus 4.8",
		);
		expect(opus?.available).toBe(true);
	});
});
