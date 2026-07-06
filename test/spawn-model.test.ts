import { describe, expect, it, vi } from "vitest";
import { resolveSpawnModel, type SpawnModelRequest } from "../packages/modes/src/spawn-model.js";

// Mock the role resolver
vi.mock("@vegardx/pi-models", () => ({
	resolveRoleModel: vi.fn().mockResolvedValue({
		model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
		modelId: "anthropic/claude-sonnet-4-20250514",
		effort: "medium",
		apiKey: "sk-test",
		headers: {},
		source: "preset",
	}),
}));

function mockCtx() {
	return {
		cwd: "/tmp",
		model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
		modelRegistry: {
			find: vi.fn(),
			getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-test" }),
		},
	} as unknown as Parameters<typeof resolveSpawnModel>[0];
}

describe("resolveSpawnModel", () => {
	it("resolves default slot", async () => {
		const ctx = mockCtx();
		const result = await resolveSpawnModel(ctx, { slot: "default" });
		expect(result).not.toBeNull();
		expect(result!.modelId).toBe("anthropic/claude-sonnet-4-20250514");
	});

	it("passes effort override", async () => {
		const ctx = mockCtx();
		const result = await resolveSpawnModel(ctx, { slot: "default", effort: "high" });
		expect(result).not.toBeNull();
		expect(result!.effort).toBe("high");
	});

	it("maps alternate slot to agent-alternate role", async () => {
		const { resolveRoleModel } = await import("@vegardx/pi-models");
		const ctx = mockCtx();
		await resolveSpawnModel(ctx, { slot: "alternate", effort: "low" });
		expect(resolveRoleModel).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({ role: "agent-alternate" }),
		);
	});

	it("returns null when resolver returns null", async () => {
		const { resolveRoleModel } = await import("@vegardx/pi-models");
		(resolveRoleModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
		const ctx = mockCtx();
		const result = await resolveSpawnModel(ctx, { slot: "default" });
		expect(result).toBeNull();
	});
});
