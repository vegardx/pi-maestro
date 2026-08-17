import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { contextLabel } from "../packages/maestro/src/footer.js";

describe("Maestro footer", () => {
	it("shows current context occupancy rather than cumulative token usage", () => {
		const ctx = {
			getContextUsage: () => ({
				tokens: 341_000,
				contextWindow: 1_100_000,
				percent: 31,
			}),
		} as unknown as ExtensionContext;
		expect(contextLabel(ctx)).toEqual({ text: "341k/1.1m", color: "muted" });
	});
});
