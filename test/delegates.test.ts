import { describe, expect, it } from "vitest";
import {
	availableTargets,
	buildDelegateSeed,
	DELEGATE_TARGETS,
	resolveTarget,
} from "../packages/modes/src/delegates.js";

describe("delegate targets", () => {
	it("has explorer, researcher, advisor", () => {
		expect(availableTargets()).toEqual(["explorer", "researcher", "advisor"]);
	});

	it("resolves known targets", () => {
		expect(resolveTarget("explorer")).toBeDefined();
		expect(resolveTarget("researcher")).toBeDefined();
		expect(resolveTarget("advisor")).toBeDefined();
	});

	it("returns undefined for unknown targets", () => {
		expect(resolveTarget("unknown")).toBeUndefined();
	});

	it("explorer uses default slot, low effort", () => {
		const t = DELEGATE_TARGETS.explorer;
		expect(t.slot).toBe("default");
		expect(t.effort).toBe("low");
		expect(t.injectPlanContext).toBe(false);
	});

	it("researcher uses default slot, low effort", () => {
		const t = DELEGATE_TARGETS.researcher;
		expect(t.slot).toBe("default");
		expect(t.effort).toBe("low");
		expect(t.tools).toContain("websearch");
	});

	it("advisor uses alternate slot, high effort", () => {
		const t = DELEGATE_TARGETS.advisor;
		expect(t.slot).toBe("alternate");
		expect(t.effort).toBe("high");
		expect(t.injectPlanContext).toBe(true);
	});
});

describe("buildDelegateSeed", () => {
	it("includes system prefix and message", () => {
		const seed = buildDelegateSeed(DELEGATE_TARGETS.explorer, "Find auth files");
		expect(seed).toContain("codebase explorer");
		expect(seed).toContain("Find auth files");
	});

	it("includes plan context for advisor", () => {
		const seed = buildDelegateSeed(
			DELEGATE_TARGETS.advisor,
			"Review this plan",
			"## Groups\n- Auth\n- API",
		);
		expect(seed).toContain("Review this plan");
		expect(seed).toContain("## Current Plan Context");
		expect(seed).toContain("## Groups");
	});

	it("omits plan context for explorer", () => {
		const seed = buildDelegateSeed(
			DELEGATE_TARGETS.explorer,
			"Find files",
			"## Groups\n- Auth",
		);
		expect(seed).not.toContain("Plan Context");
	});

	it("omits plan context section when no context provided", () => {
		const seed = buildDelegateSeed(DELEGATE_TARGETS.advisor, "Check plan");
		expect(seed).not.toContain("Plan Context");
	});
});
