import {
	PROMPT_ASSIST_SYSTEM_ADDENDUM,
	PromptAssistState,
	sanitiseSuggestion,
} from "@vegardx/pi-prompt-assist";

describe("sanitiseSuggestion", () => {
	it("keeps a clean one-liner, dropping wrapping quotes and trailing punctuation", () => {
		expect(sanitiseSuggestion('"Open the PR."')).toBe("Open the PR");
	});

	it("takes the first non-empty line and trims", () => {
		expect(sanitiseSuggestion("\n   Run the tests  \nignored")).toBe(
			"Run the tests",
		);
	});

	it("returns null for empty, whitespace, or the NONE sentinel", () => {
		expect(sanitiseSuggestion("")).toBeNull();
		expect(sanitiseSuggestion("   ")).toBeNull();
		expect(sanitiseSuggestion("none")).toBeNull();
	});

	it("strips ANSI and bidi-override sequences", () => {
		expect(sanitiseSuggestion("\x1b[31mhack\x1b[0m")).toBe("hack");
		expect(sanitiseSuggestion("a\u202Eb")).toBe("ab");
	});

	it("caps overlong text with an ellipsis", () => {
		const out = sanitiseSuggestion("x".repeat(200));
		expect(out?.endsWith("…")).toBe(true);
		expect([...(out ?? "")].length).toBeLessThanOrEqual(121);
	});
});

describe("PromptAssistState addendum", () => {
	it("includes the suggest teaching only when asked", () => {
		const s = new PromptAssistState();
		expect(s.assembleAddendum(false)).toBe("");
		expect(s.assembleAddendum(true)).toBe(PROMPT_ASSIST_SYSTEM_ADDENDUM);
	});

	it("appends registered nudges and removes them on dispose", () => {
		const s = new PromptAssistState();
		const off = s.addNudge("Mind the active mode.");
		expect(s.assembleAddendum(false)).toBe("Mind the active mode.");
		expect(s.assembleAddendum(true)).toContain(PROMPT_ASSIST_SYSTEM_ADDENDUM);
		expect(s.assembleAddendum(true)).toContain("Mind the active mode.");
		off();
		expect(s.assembleAddendum(false)).toBe("");
	});

	it("ignores blank nudges", () => {
		const s = new PromptAssistState();
		s.addNudge("   ");
		expect(s.assembleAddendum(false)).toBe("");
	});
});

describe("PromptAssistState transforms", () => {
	it("is the identity with no transforms", () => {
		const s = new PromptAssistState();
		expect(s.hasTransforms).toBe(false);
		expect(s.applyTransforms("hello")).toBe("hello");
	});

	it("chains transforms and honours undefined as no-change", () => {
		const s = new PromptAssistState();
		s.addTransform((t) => `${t}!`);
		s.addTransform((t) => (t.includes("x") ? t.toUpperCase() : undefined));
		expect(s.hasTransforms).toBe(true);
		expect(s.applyTransforms("ax")).toBe("AX!");
		expect(s.applyTransforms("b")).toBe("b!");
	});

	it("stops applying a transform after dispose", () => {
		const s = new PromptAssistState();
		const off = s.addTransform((t) => `${t}?`);
		expect(s.applyTransforms("q")).toBe("q?");
		off();
		expect(s.applyTransforms("q")).toBe("q");
	});
});
