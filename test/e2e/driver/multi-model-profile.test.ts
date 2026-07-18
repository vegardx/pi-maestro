// The multi-model ollama profile, validated deterministically — no ollama, no pi
// boot. It proves the generated presets/modelSets block is *valid* and that each
// maestro role resolves to the intended local model, so a regression in the
// profile is caught in CI rather than only surfacing during a manual live drive.
//
// The live drive (docs/e2e-testing.md, drive-maestro-e2e skill) then confirms
// ollama actually serves those models; this test owns the routing correctness.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODEL_ROLES, type ModelRole } from "@vegardx/pi-contracts";
import { resolveExactModelSelection } from "@vegardx/pi-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MULTI_MODEL_CATALOG,
	MULTI_MODEL_OLLAMA,
} from "./multi-model-profile.js";

let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;

const SESSION = `${MULTI_MODEL_OLLAMA.defaultProvider}/${MULTI_MODEL_OLLAMA.defaultModel}`;

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
	options: { unavailable?: readonly string[] } = {},
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
		model: entries.get(SESSION),
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

async function modelFor(
	role: ModelRole,
	ctx: ExtensionContext = fakeCtx(),
): Promise<string | undefined> {
	const result = await resolveExactModelSelection(ctx, { role });
	return result.selected?.modelId;
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
	// place it in project settings — readModelsConfig merges both the same way.
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
	it("references only models the profile catalog defines", () => {
		const referenced = new Set<string>();
		const sets = (
			MULTI_MODEL_OLLAMA.models as {
				modelSets: Record<string, { options: { model: string }[] }>;
			}
		).modelSets;
		for (const set of Object.values(sets)) {
			for (const opt of set.options) {
				if (opt.model !== "session") {
					referenced.add(opt.model.slice(opt.model.indexOf("/") + 1));
				}
			}
		}
		for (const id of referenced) expect(MULTI_MODEL_CATALOG).toContain(id);
	});

	it("activates only for the planner-seat session model", async () => {
		// The preset targets gpt-oss:20b; a different session model → no preset,
		// so a role falls back to the session model itself (unconfigured behavior).
		const other = { ...fakeCtx() } as ExtensionContext & { model?: unknown };
		(other as { model: unknown }).model = {
			provider: "ollama",
			id: "qwen3:14b",
			name: "ollama/qwen3:14b",
			reasoning: true,
			thinkingLevelMap: {},
		};
		expect(await modelFor("worker", other)).toBe("ollama/qwen3:14b");
	});

	it("maps every MODEL_ROLE — a new role must not silently fall through to session", () => {
		const preset = (
			MULTI_MODEL_OLLAMA.models as {
				presets: Record<string, { modelSets: Record<string, string> }>;
			}
		).presets["ollama-multi"];
		for (const role of MODEL_ROLES) {
			expect(preset.modelSets[role], `role ${role} unmapped`).toBeDefined();
		}
	});

	it("routes each role to its intended local model", async () => {
		// normal tier — the coding model is the default worker
		expect(await modelFor("worker")).toBe("ollama/qwen3.6:27b-coding-mxfp8");
		expect(await modelFor("verifier")).toBe("ollama/qwen3.6:27b-coding-mxfp8");
		expect(await modelFor("codebase-research")).toBe(
			"ollama/qwen3.6:27b-coding-mxfp8",
		);
		// fast tier
		expect(await modelFor("classifier")).toBe("ollama/gemma4:e4b-mlx");
		expect(await modelFor("plan-summarizer")).toBe("ollama/gemma4:e4b-mlx");
		expect(await modelFor("general")).toBe("ollama/gemma4:e4b-mlx");
		// review pool — first concrete option: a DIFFERENT family from workers
		expect(await modelFor("correctness-review")).toBe("ollama/gpt-oss:20b");
		expect(await modelFor("adversarial-review")).toBe("ollama/gpt-oss:20b");
	});

	it("falls through to the next option when the first is not served", async () => {
		// The live availability-fallback (ollama stop <model>), deterministically:
		// fast → gemma4:e4b-mlx → qwen3:8b; normal → qwen3.6-coding → qwen3:14b.
		expect(
			await modelFor(
				"classifier",
				fakeCtx({ unavailable: ["ollama/gemma4:e4b-mlx"] }),
			),
		).toBe("ollama/qwen3:8b");
		expect(
			await modelFor(
				"worker",
				fakeCtx({ unavailable: ["ollama/qwen3.6:27b-coding-mxfp8"] }),
			),
		).toBe("ollama/qwen3:14b");
	});

	it("walks the review pool by availability, then falls back to the session model", async () => {
		// gpt-oss unserved → gemma4:31b takes over.
		expect(
			await modelFor(
				"correctness-review",
				fakeCtx({ unavailable: ["ollama/gpt-oss:20b"] }),
			),
		).toBe("ollama/gemma4:31b");
		// Every concrete pool model unserved → the session sentinel (sorted to
		// the back) resolves to the planner seat — the last resort.
		expect(
			await modelFor(
				"correctness-review",
				fakeCtx({
					unavailable: ["ollama/gpt-oss:20b", "ollama/gemma4:31b"],
				}),
			),
		).toBe("ollama/qwen3.5:27b");
	});
});
