// Subagent model resolution through the v2 catalog.
//
// The gap this closes, seen live at the plan gate: `agents.run` validated an
// explicit model against v1 AUTHORED OPTIONS, which a v2-only config does not
// have. So every tier override was rejected —
//
//   No exact plan-review option matches sit-openai/gpt-5.6-sol @ medium
//
// — and #279's fallback ran the review on the runner's own pick. Visible, but
// it meant the policy row's tier decided nothing.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTypeForRole } from "@vegardx/pi-models";
import { resolveViaV2 } from "@vegardx/pi-subagents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let cwd: string;

const V2 = {
	models: {
		catalogs: {
			main: {
				fast: [{ model: "acme/small", effort: "low" }],
				normal: [{ model: "acme/medium", effort: "medium" }],
				heavy: [{ model: "acme/large", effort: "high" }],
			},
		},
		profiles: { main: { targets: [], catalog: "main" } },
		agents: {
			worker: { models: ["normal", "heavy"] },
			explorer: { models: ["fast"] },
			reviewer: { models: ["heavy"] },
		},
	},
};

function writeSettings(value: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify(value, null, 2),
	);
}

/** Enough ExtensionContext for the resolver: cwd plus a model registry. */
function fakeCtx(): unknown {
	return {
		cwd,
		model: { provider: "acme", id: "seat" },
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
		},
	};
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "subagents-v2-"));
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("agentTypeForRole", () => {
	it("maps the v1 roles onto the three v2 agent types", () => {
		// Reviews judge, implementation and delivery-verification act, the rest read.
		for (const role of [
			"plan-review",
			"security-review",
			"adversarial-review",
			"simplification-review",
		]) {
			expect(agentTypeForRole(role), role).toBe("reviewer");
		}
		expect(agentTypeForRole("worker")).toBe("worker");
		expect(agentTypeForRole("verifier")).toBe("worker");
		for (const role of ["classifier", "plan-summarizer", "web-research"]) {
			expect(agentTypeForRole(role), role).toBe("explorer");
		}
	});
});

describe("resolveViaV2", () => {
	it("returns null without a v2 config, leaving v1 setups untouched", async () => {
		writeSettings({ models: { presets: {}, modelSets: {} } });
		expect(
			await resolveViaV2(fakeCtx() as never, "plan-review", {}),
		).toBeNull();
	});

	it("accepts an explicit model that the agent's tiers allow", async () => {
		writeSettings(V2);
		const selection = await resolveViaV2(fakeCtx() as never, "plan-review", {
			model: "acme/large",
		});
		expect(selection).toMatchObject({
			modelId: "acme/large",
			modelSetId: "reviewer",
			source: "explicit",
		});
		// Effort comes from the catalog entry when the caller does not pin one.
		expect(selection?.effort).toBe("high");
	});

	it("rejects a model outside the agent's tiers, naming them", async () => {
		writeSettings(V2);
		// `fast` holds acme/small, but a reviewer may only reach `heavy`.
		await expect(
			resolveViaV2(fakeCtx() as never, "plan-review", { model: "acme/small" }),
		).rejects.toThrow(/not in any tier reviewer may use \(heavy\)/);
	});

	it("names the eligible model ids in the rejection, not just the tiers", async () => {
		writeSettings(V2);
		// The dead-end error becomes a menu: a reviewer reaches only `heavy`,
		// whose one entry is acme/large — so say so instead of leaving the
		// caller to guess again (which is how gpt-5.4 got picked live).
		await expect(
			resolveViaV2(fakeCtx() as never, "plan-review", { model: "acme/small" }),
		).rejects.toThrow(/Eligible models: acme\/large/);
	});

	it("resolves a deliberate tier to a concrete model from the allowlist", async () => {
		writeSettings(V2);
		// A worker may reach normal|heavy; `normal` holds acme/medium.
		const selection = await resolveViaV2(fakeCtx() as never, "worker", {
			tier: "normal",
		});
		expect(selection).toMatchObject({
			modelId: "acme/medium",
			modelSetId: "worker",
		});
		expect(selection?.effort).toBe("medium");
	});

	it("inherits the session model when neither model nor tier is given", async () => {
		writeSettings(V2);
		// The orchestrating case: a worker that will itself drive subagents runs
		// on the seat, not a tier pick. Omission is the inheritance signal.
		const selection = await resolveViaV2(fakeCtx() as never, "worker", {});
		expect(selection?.modelId).toBe("acme/seat");
	});

	it("rejects a tier outside the agent's allowlist", async () => {
		writeSettings(V2);
		// An explorer may reach only `fast`; asking for `heavy` is out of bounds.
		await expect(
			resolveViaV2(fakeCtx() as never, "web-research", { tier: "heavy" }),
		).rejects.toThrow(/heavy.*outside agent explorer's allowlist/);
	});

	it("lets the caller pin an effort over the catalog's", async () => {
		writeSettings(V2);
		const selection = await resolveViaV2(fakeCtx() as never, "plan-review", {
			model: "acme/large",
			effort: "low",
		});
		expect(selection?.effort).toBe("low");
	});

	it("reports an unusable credential instead of falling back to v1", async () => {
		writeSettings(V2);
		const ctx = {
			...(fakeCtx() as Record<string, unknown>),
			modelRegistry: {
				find: (provider: string, id: string) => ({ provider, id }),
				getApiKeyAndHeaders: async () => ({ ok: false }),
			},
		};
		// Falling through would surface "no exact option configured", which
		// points at the catalog rather than at the missing credential.
		await expect(
			resolveViaV2(ctx as never, "plan-review", { model: "acme/large" }),
		).rejects.toThrow(/no usable credential/);
	});
});
