import { supportedEfforts } from "@vegardx/pi-models";
import { describe, expect, it } from "vitest";

describe("supportedEfforts", () => {
	it("offers only off for a model that does not reason", () => {
		expect(supportedEfforts({ reasoning: false })).toEqual(["off"]);
		expect(
			supportedEfforts({ reasoning: false, thinkingLevelMap: { max: "max" } }),
		).toEqual(["off"]);
	});

	it("treats an absent reasoning flag as not reasoning, as Pi does", () => {
		expect(supportedEfforts({})).toEqual(["off"]);
	});

	it("stops at high when the model maps nothing", () => {
		const levels = ["off", "minimal", "low", "medium", "high"];
		expect(supportedEfforts({ reasoning: true })).toEqual(levels);
		expect(supportedEfforts({ reasoning: true, thinkingLevelMap: {} })).toEqual(
			levels,
		);
	});

	it("includes xhigh and max only where they are mapped", () => {
		expect(
			supportedEfforts({
				reasoning: true,
				thinkingLevelMap: { xhigh: "xhigh" },
			}),
		).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
		expect(
			supportedEfforts({
				reasoning: true,
				thinkingLevelMap: { xhigh: "high", max: "max" },
			}),
		).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("excludes every level mapped to null", () => {
		expect(
			supportedEfforts({
				reasoning: true,
				thinkingLevelMap: { minimal: null, high: null, max: null, xhigh: "x" },
			}),
		).toEqual(["off", "low", "medium", "xhigh"]);
	});
});
