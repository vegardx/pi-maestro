import { afterEach, describe, expect, it } from "vitest";
import {
	getImplementOverrides,
	type ImplementOverrides,
	setImplementOverrides,
} from "../packages/modes/src/settings.js";

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
