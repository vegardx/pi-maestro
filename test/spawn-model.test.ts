import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSpawnModel } from "../packages/modes/src/spawn-model.js";

// Mock the resolver. resolveTierModel resolves a tier → concrete model.
vi.mock("@vegardx/pi-models", () => ({
	resolveTierModel: vi.fn().mockResolvedValue({
		model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
		modelId: "anthropic/claude-sonnet-4-20250514",
		effort: "medium",
		apiKey: "sk-test",
		headers: {},
		source: "profile",
		tier: "work",
	}),
}));

function mockCtx() {
	return {
		cwd: "/tmp",
		model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
		modelRegistry: {
			find: vi.fn(),
			getApiKeyAndHeaders: vi
				.fn()
				.mockResolvedValue({ ok: true, apiKey: "sk-test" }),
		},
	} as unknown as Parameters<typeof resolveSpawnModel>[0];
}

describe("resolveSpawnModel", () => {
	beforeEach(() => vi.clearAllMocks());

	it("resolves the work tier", async () => {
		const ctx = mockCtx();
		const result = await resolveSpawnModel(ctx, { tier: "work" });
		expect(result).not.toBeNull();
		expect(result!.modelId).toBe("anthropic/claude-sonnet-4-20250514");
	});

	it("passes effort override", async () => {
		const ctx = mockCtx();
		const result = await resolveSpawnModel(ctx, {
			tier: "work",
			effort: "high",
		});
		expect(result).not.toBeNull();
		expect(result!.effort).toBe("high");
	});

	it("resolves a distinct model for the review tier", async () => {
		const { resolveTierModel } = await import("@vegardx/pi-models");
		(resolveTierModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			model: { provider: "openai", id: "o3" },
			modelId: "openai/o3",
			effort: "high",
			apiKey: "sk-alt",
			headers: {},
			source: "profile",
			tier: "review",
		});
		const ctx = mockCtx();
		const result = await resolveSpawnModel(ctx, { tier: "review" });
		expect(result!.modelId).toBe("openai/o3");
		expect(resolveTierModel).toHaveBeenCalledWith(ctx, "review", {
			effort: undefined,
		});
	});

	it("returns null when tier resolution returns null", async () => {
		const { resolveTierModel } = await import("@vegardx/pi-models");
		(resolveTierModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
		const ctx = mockCtx();
		const result = await resolveSpawnModel(ctx, { tier: "work" });
		expect(result).toBeNull();
	});
});
