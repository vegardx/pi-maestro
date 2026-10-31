import type {
	BeforeAgentStartCustomEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartUserEvent,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import promptAssist, {
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

describe("the system addendum on a run's start", () => {
	type Handler = (event: BeforeAgentStartEvent, ctx: unknown) => unknown;

	async function beforeAgentStart(): Promise<Handler> {
		const handlers = new Map<string, Handler[]>();
		const api = {
			on(event: string, handler: Handler) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
		} as unknown as ExtensionAPI;
		await promptAssist(api);
		const registered = handlers.get("before_agent_start") ?? [];
		expect(registered).toHaveLength(1);
		const [handler] = registered;
		if (!handler) throw new Error("before_agent_start was not registered");
		return handler;
	}

	const base = {
		type: "before_agent_start" as const,
		systemPrompt: "You are Pi.",
		systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
	};

	it("is added to a run a person's prompt starts", async () => {
		const event: BeforeAgentStartUserEvent = {
			...base,
			messageType: "user",
			prompt: "Fix the tests",
		};
		const result = (await beforeAgentStart())(event, {});
		expect(result).toEqual({
			systemPrompt: `You are Pi.\n\n${PROMPT_ASSIST_SYSTEM_ADDENDUM}`,
		});
	});

	it("is left off a run an extension's custom message starts", async () => {
		const event: BeforeAgentStartCustomEvent = {
			...base,
			messageType: "custom",
			message: {
				role: "custom",
				customType: "maestro:decision",
				content: "The pull request is open.",
				display: true,
				details: undefined,
				timestamp: 0,
			},
		};
		expect((await beforeAgentStart())(event, {})).toBeUndefined();
	});
});
