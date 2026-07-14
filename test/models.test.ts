import { parseModelSpec } from "@vegardx/pi-models";
import { describe, expect, it } from "vitest";

describe("model ids", () => {
	it("parses exact provider/model ids", () => {
		expect(parseModelSpec("anthropic/claude-sonnet")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet",
		});
		expect(parseModelSpec("bad")).toBeNull();
	});
});
