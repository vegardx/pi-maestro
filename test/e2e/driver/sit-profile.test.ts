// The radicalai-sit gateway profile, validated deterministically — no gateway,
// no credentials (the pure builder takes an injected token). Owns the routing
// correctness: opus is the planner seat and the review family, sol is the
// worker family — cross-family review by construction.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODEL_ROLES, type ModelRole } from "@vegardx/pi-contracts";
import { resolveExactModelSelection } from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SIT_CATALOG, sitProfileFromToken } from "./sit-profile.js";

const PROFILE = sitProfileFromToken("test-token");
const SESSION = `${PROFILE.defaultProvider}/${PROFILE.defaultModel}`;

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

async function modelFor(
	role: ModelRole,
	ctx: ExtensionContext = fakeCtx(),
): Promise<string | undefined> {
	const result = await resolveExactModelSelection(ctx, { role });
	return result.selected?.modelId;
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

	it("maps every MODEL_ROLE — a new role must not silently fall through", () => {
		const preset = (
			PROFILE.models as {
				presets: Record<string, { modelSets: Record<string, string> }>;
			}
		).presets["sit-multi"];
		for (const role of MODEL_ROLES) {
			expect(preset.modelSets[role], `role ${role} unmapped`).toBeDefined();
		}
	});

	it("routes workers to sol and reviews to opus — cross-family by construction", async () => {
		expect(await modelFor("worker")).toBe("sit-openai/gpt-5.6-sol");
		expect(await modelFor("verifier")).toBe("sit-openai/gpt-5.6-sol");
		expect(await modelFor("classifier")).toBe("sit-openai/gpt-5.6-sol");
		expect(await modelFor("security-review")).toBe(
			"sit-anthropic/claude-opus-4-8",
		);
		expect(await modelFor("plan-review")).toBe("sit-anthropic/claude-opus-4-8");
	});

	it("falls back to the opus session seat when sol is unavailable", async () => {
		expect(
			await modelFor(
				"worker",
				fakeCtx({ unavailable: ["sit-openai/gpt-5.6-sol"] }),
			),
		).toBe("sit-anthropic/claude-opus-4-8");
	});
});
