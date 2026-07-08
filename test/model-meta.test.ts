import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getModelMeta, shortModelName } from "@vegardx/pi-models";
import { describe, expect, it } from "vitest";

function ctxWith(
	models: Record<string, { forceAdaptiveThinking?: boolean }>,
): ExtensionContext {
	return {
		modelRegistry: {
			find: (provider: string, id: string) => {
				const key = `${provider}/${id}`;
				return key in models ? { compat: models[key] } : undefined;
			},
		},
	} as unknown as ExtensionContext;
}

describe("shortModelName", () => {
	it("strips provider, claude- prefix, and trailing date", () => {
		expect(shortModelName("anthropic/claude-fable-5")).toBe("fable-5");
		expect(shortModelName("anthropic/claude-opus-4-8")).toBe("opus-4-8");
		expect(shortModelName("anthropic/claude-sonnet-4-20250514")).toBe(
			"sonnet-4",
		);
		expect(shortModelName("openai/o3")).toBe("o3");
	});
});

describe("getModelMeta", () => {
	it("reports adaptive when compat.forceAdaptiveThinking is set", () => {
		const ctx = ctxWith({
			"anthropic/claude-fable-5": { forceAdaptiveThinking: true },
			"anthropic/claude-haiku-4-5": {},
		});
		expect(getModelMeta(ctx, "anthropic/claude-fable-5")).toEqual({
			shortName: "fable-5",
			adaptive: true,
		});
		expect(getModelMeta(ctx, "anthropic/claude-haiku-4-5").adaptive).toBe(
			false,
		);
	});

	it("is not adaptive for an unknown model", () => {
		expect(getModelMeta(ctxWith({}), "openai/o3")).toEqual({
			shortName: "o3",
			adaptive: false,
		});
	});
});
