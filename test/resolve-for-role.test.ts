// resolveModelForRole — the v2 replacement for the retired v1
// resolveExactModelSelection. Proves every maestro role resolves to a concrete
// model (never silently null) under a representative v2 config, and that the
// seat is the last-resort fallback — the parity guarantee behind retiring v1.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_PERSONA_ALLOWANCES,
	MODEL_ROLES,
	type ModelRole,
} from "@vegardx/pi-contracts";
import { personaForRole, resolveModelForRole } from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SEAT = "anthropic/opus";
const WORKER = "openai/sol";
// A minimal v2 config: workers on a distinct family, everything else inherits
// the seat (the resolver appends the seat as every tier's last resort).
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
		"deliverable-worker": { tiers: ["standard", "heavy"] },
		"codebase-research": { tiers: ["light", "standard"] },
		"code-review": { tiers: ["heavy", "standard"] },
		standby: { tiers: ["heavy", "standard"] },
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

describe("resolveModelForRole (v2 role parity)", () => {
	it("resolves a concrete authenticated model for EVERY role — never null", async () => {
		for (const role of MODEL_ROLES) {
			const resolved = await resolveModelForRole(fakeCtx(), role);
			expect(resolved, `role ${role} resolved to null`).not.toBeNull();
			expect(resolved?.modelId, `role ${role}`).toMatch(/\//);
			expect(resolved?.apiKey).toBeTruthy();
			// The resolved model is one the agent type may actually reach.
			expect([SEAT, WORKER]).toContain(resolved?.modelId);
		}
	});

	it("routes worker roles to the worker family, reviews to the seat family", async () => {
		const worker = await resolveModelForRole(fakeCtx(), "worker");
		expect(worker?.modelId).toBe(WORKER);
		const review = await resolveModelForRole(fakeCtx(), "security-review");
		expect(review?.modelId).toBe(SEAT);
	});

	it("maps every MODEL_ROLE to a built-in persona (no role falls through)", () => {
		// The built-in persona ids are also the DEFAULT_PERSONA_ALLOWANCES keys,
		// so a role mapped outside that set would silently lose its allowance.
		for (const role of MODEL_ROLES as readonly ModelRole[]) {
			expect(Object.keys(DEFAULT_PERSONA_ALLOWANCES)).toContain(
				personaForRole(role),
			);
		}
	});
});
