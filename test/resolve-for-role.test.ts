// The Pi adapters over the model registry.
//
// resolveModelForRole — the v2 replacement for the retired v1
// resolveExactModelSelection. Proves both current in-process support roles
// resolve through the read-only support persona.
//
// planHostPort — the same registry as the two questions plan validation asks
// about a pinned review: does this host have that model, has Pi loaded that
// skill. Here because it is built on `modelCatalogPort` and this is where that
// seam has a context to be built from.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModelForRole } from "@vegardx/pi-maestro/model-router";
import {
	loadedSkillNames,
	planHostPort,
	SKILL_COMMAND_PREFIX,
} from "@vegardx/pi-maestro/plan-host";
import {
	DEFAULT_PERSONA_ALLOWANCES,
	MODEL_ROLES,
	type ModelRole,
	personaForRole,
} from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SEAT = "anthropic/opus";
const WORKER = "openai/sol";
// A minimal config: support work prefers the light OpenAI attachment.
const MODELS_BLOCK = {
	families: {
		OpenAI: { aliases: { Sol: { attach: [WORKER], effort: "medium" } } },
		Anthropic: { aliases: { Opus: { attach: [SEAT], effort: "medium" } } },
	},
	rosters: {
		r: {
			light: ["OpenAI/Sol"],
			standard: ["OpenAI/Sol"],
			heavy: ["Anthropic/Opus"],
		},
	},
	bindings: { r: { roster: "r" } },
	allowances: {
		"codebase-research": { tiers: ["light", "standard"] },
	},
} as const;

let cwd: string;
let previousAgentDir: string | undefined;

function model(ref: string) {
	const slash = ref.indexOf("/");
	return {
		provider: ref.slice(0, slash),
		id: ref.slice(slash + 1),
		name: ref,
		reasoning: true,
		thinkingLevelMap: {},
	};
}

function fakeCtx(): ExtensionContext {
	const entries = new Map(
		[SEAT, WORKER].map(model).map((m) => [`${m.provider}/${m.id}`, m]),
	);
	return {
		cwd,
		model: entries.get(SEAT),
		getThinkingLevel: () => "medium",
		modelRegistry: {
			find: (provider: string, id: string) => entries.get(`${provider}/${id}`),
			getProviderAuthStatus: () => ({ configured: true }),
			getRegisteredProviderIds: () => ["anthropic", "openai"],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
		},
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	cwd = join(tmpdir(), `resolve-for-role-${process.pid}`);
	const agentDir = join(cwd, ".agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ models: MODELS_BLOCK }),
	);
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
});

describe("resolveModelForRole", () => {
	it("resolves every current support role", async () => {
		for (const role of MODEL_ROLES) {
			const resolved = await resolveModelForRole(fakeCtx(), role);
			expect(resolved, `role ${role} resolved to null`).not.toBeNull();
			expect(resolved?.modelId, `role ${role}`).toMatch(/\//);
			expect(resolved?.apiKey).toBeTruthy();
			expect(resolved?.modelId).toBe(WORKER);
		}
	});

	it("maps every current role to the configured support persona", () => {
		for (const role of MODEL_ROLES as readonly ModelRole[]) {
			expect(Object.keys(DEFAULT_PERSONA_ALLOWANCES)).toContain(
				personaForRole(role),
			);
		}
	});
});

describe("planHostPort", () => {
	// Pi reports a loaded skill as a command, `source: "skill"`, under a
	// `skill:`-prefixed name. The plan pins the bare name, so the prefix comes
	// off here — and prompts and extension commands are not skills.
	const commands = [
		{ name: `${SKILL_COMMAND_PREFIX}security-review`, source: "skill" },
		{ name: `${SKILL_COMMAND_PREFIX}contracts-review`, source: "skill" },
		{ name: "plan", source: "extension" },
		{ name: "summarise", source: "prompt" },
	];

	it("reads the loaded skills off Pi's own command list", () => {
		expect(loadedSkillNames({ getCommands: () => commands })).toEqual([
			"security-review",
			"contracts-review",
		]);
	});

	// FAIL CLOSED: a host that cannot answer has loaded nothing, as far as a
	// plan that pins a skill is concerned.
	it("answers nothing for a host that cannot list commands", () => {
		expect(loadedSkillNames({})).toEqual([]);
		expect(
			loadedSkillNames({
				getCommands: () => {
					throw new Error("replaced session");
				},
			}),
		).toEqual([]);
	});

	it("answers the registry's models and providers, existence only", () => {
		const host = planHostPort(fakeCtx(), { getCommands: () => commands });
		expect(host).toBeDefined();
		expect(host?.hasModel("openai", "sol")).toBe(true);
		expect(host?.hasModel("openai", "sol-9")).toBe(false);
		expect(host?.registeredProviders()).toEqual(["anthropic", "openai"]);
		expect(host?.loadedSkills()).toContain("security-review");
	});

	// No context is not an empty host: it is the absence `inspectPlan` refuses
	// a pinned model or skill for.
	it("is undefined when there is no live session", () => {
		expect(
			planHostPort(undefined, { getCommands: () => commands }),
		).toBeUndefined();
	});
});
