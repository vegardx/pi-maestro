import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	resolveSpawnModel,
	SpawnModelResolutionError,
} from "../packages/modes/src/spawn-model.js";

const mocks = vi.hoisted(() => ({
	selected: {
		model: { provider: "anthropic", id: "sonnet" },
		modelId: "anthropic/sonnet",
		effort: "medium",
		apiKey: "sk-test",
		headers: {},
		source: "profile",
		role: "worker",
		configuredModels: ["anthropic/sonnet", "openai/o3"],
		candidates: [],
		allowedEfforts: ["medium", "high"],
		provenance: {},
		validationErrors: [],
	},
}));

vi.mock("@vegardx/pi-models", () => ({
	resolveRolePool: vi.fn().mockResolvedValue({
		selected: mocks.selected,
		errors: [],
	}),
}));

function mockCtx() {
	return { cwd: "/tmp" } as unknown as Parameters<typeof resolveSpawnModel>[0];
}

describe("resolveSpawnModel", () => {
	beforeEach(() => vi.clearAllMocks());

	it("resolves the default from a direct role pool", async () => {
		const result = await resolveSpawnModel(mockCtx(), { role: "worker" });
		expect(result.modelId).toBe("anthropic/sonnet");
		expect(result.effort).toBe("medium");
	});

	it("passes exact model and effort choices", async () => {
		const { resolveRolePool } = await import("@vegardx/pi-models");
		await resolveSpawnModel(mockCtx(), {
			role: "reviewer",
			model: "openai/o3",
			effort: "high",
		});
		expect(resolveRolePool).toHaveBeenCalledWith(mockCtx(), {
			role: "reviewer",
			choice: { model: "openai/o3", effort: "high" },
			requireApiKey: undefined,
		});
	});

	it("fails visibly when no policy-compatible model resolves", async () => {
		const { resolveRolePool } = await import("@vegardx/pi-models");
		(resolveRolePool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			selected: null,
			errors: [{ message: "Model bad/x is not in the worker pool" }],
		});
		await expect(
			resolveSpawnModel(mockCtx(), { role: "worker", model: "bad/x" }),
		).rejects.toBeInstanceOf(SpawnModelResolutionError);
	});
});
