import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getImplementOverrides,
	type ImplementOverrides,
	resolveInternalRoleModel,
	setImplementOverrides,
} from "../packages/modes/src/settings.js";

vi.mock("@vegardx/pi-models", () => ({
	resolveRolePool: vi.fn(),
}));

describe("internal role policy", () => {
	it("returns defaults and surfaces resolution failures", async () => {
		const { resolveRolePool } = await import("@vegardx/pi-models");
		const mock = resolveRolePool as ReturnType<typeof vi.fn>;
		mock.mockResolvedValueOnce({
			selected: { modelId: "provider/classifier" },
			errors: [],
		});
		await expect(
			resolveInternalRoleModel({} as ExtensionContext, "classifier"),
		).resolves.toMatchObject({ modelId: "provider/classifier" });
		mock.mockResolvedValueOnce({
			selected: null,
			errors: [{ message: "no classifier candidate" }],
		});
		await expect(
			resolveInternalRoleModel({} as ExtensionContext, "classifier"),
		).rejects.toThrow("no classifier candidate");
	});
});

describe("ImplementOverrides", () => {
	afterEach(() => setImplementOverrides(undefined));

	it("round-trips worker invocation overrides", () => {
		const value: ImplementOverrides = {
			agentModel: "openai/gpt-4o",
			agentThinking: "high",
		};
		setImplementOverrides(value);
		expect(getImplementOverrides()).toEqual(value);
	});

	it("can be cleared", () => {
		setImplementOverrides({ agentModel: "openai/gpt-4o" });
		setImplementOverrides(undefined);
		expect(getImplementOverrides()).toBeUndefined();
	});
});
