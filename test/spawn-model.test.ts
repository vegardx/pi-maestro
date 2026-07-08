import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSpawnModel } from "../packages/modes/src/spawn-model.js";

// Mock the resolvers. resolveSlotModel defaults to null (slot unconfigured →
// fall back to the role path); resolveRoleModel returns the session-ish model.
vi.mock("@vegardx/pi-models", () => ({
	resolveSlotModel: vi.fn().mockResolvedValue(null),
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
			getApiKeyAndHeaders: vi
				.fn()
				.mockResolvedValue({ ok: true, apiKey: "sk-test" }),
		},
	} as unknown as Parameters<typeof resolveSpawnModel>[0];
}

describe("resolveSpawnModel", () => {
	beforeEach(() => vi.clearAllMocks());

	it("resolves default slot", async () => {
		const ctx = mockCtx();
		const result = await resolveSpawnModel(ctx, { slot: "default" });
		expect(result).not.toBeNull();
		expect(result!.modelId).toBe("anthropic/claude-sonnet-4-20250514");
	});

	it("passes effort override", async () => {
		const ctx = mockCtx();
		const result = await resolveSpawnModel(ctx, {
			slot: "default",
			effort: "high",
		});
		expect(result).not.toBeNull();
		expect(result!.effort).toBe("high");
	});

	it("prefers the direct slot resolution over the role", async () => {
		const { resolveSlotModel, resolveRoleModel } = await import(
			"@vegardx/pi-models"
		);
		(resolveSlotModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			model: { provider: "openai", id: "o3" },
			modelId: "openai/o3",
			effort: "high",
			apiKey: "sk-alt",
			headers: {},
			source: "preset",
			slot: "alternate",
		});
		const ctx = mockCtx();
		const result = await resolveSpawnModel(ctx, { slot: "alternate" });
		expect(result!.modelId).toBe("openai/o3");
		expect(resolveRoleModel).not.toHaveBeenCalled();
	});

	it("falls back to the agent-alternate role when the slot is unconfigured", async () => {
		const { resolveRoleModel } = await import("@vegardx/pi-models");
		const ctx = mockCtx();
		await resolveSpawnModel(ctx, { slot: "alternate", effort: "low" });
		expect(resolveRoleModel).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({ role: "agent-alternate" }),
		);
	});

	it("returns null when both slot and role resolution return null", async () => {
		const { resolveRoleModel } = await import("@vegardx/pi-models");
		(resolveRoleModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
		const ctx = mockCtx();
		const result = await resolveSpawnModel(ctx, { slot: "default" });
		expect(result).toBeNull();
	});
});
