import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ModesCapabilityV1 } from "@vegardx/pi-contracts";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import {
	__resetCapabilityRegistry,
	createTypedEventBus,
	defineExtension,
	getCapability,
	isExtensionEnabled,
	isFlagEnabled,
	registerCapability,
	requireCapability,
	runAgentTurn,
	setSettingsLayer,
	whenCapabilityAvailable,
} from "@vegardx/pi-core";

// ---- Fakes -------------------------------------------------------------

interface FakeBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function fakeEventBus(): FakeBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		emit(channel, data) {
			for (const h of handlers.get(channel) ?? []) h(data);
		},
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
	};
}

interface FakePi {
	api: ExtensionAPI;
	fire(event: string, payload?: unknown): void;
	sent: Array<{ content: unknown }>;
	registrations: string[];
}

function fakePi(): FakePi {
	const listeners = new Map<string, Array<(...a: unknown[]) => unknown>>();
	const sent: Array<{ content: unknown }> = [];
	const registrations: string[] = [];
	const api = {
		events: fakeEventBus(),
		on(event: string, handler: (...a: unknown[]) => unknown) {
			const list = listeners.get(event) ?? [];
			list.push(handler);
			listeners.set(event, list);
		},
		sendMessage(message: { content: unknown }) {
			sent.push({ content: message.content });
		},
		registerTool() {
			registrations.push("tool");
		},
		registerCommand() {
			registrations.push("command");
		},
	} as unknown as ExtensionAPI;
	return {
		api,
		fire(event, payload) {
			for (const h of listeners.get(event) ?? []) h(payload, {});
		},
		sent,
		registrations,
	};
}

function fakeCtx(opts: {
	idle?: boolean;
	assistantText?: string;
}): ExtensionContext {
	const entries = opts.assistantText
		? [
				{
					type: "message",
					message: { role: "assistant", content: opts.assistantText },
				},
			]
		: [];
	return {
		isIdle: () => opts.idle ?? true,
		sessionManager: { getEntries: () => entries },
	} as unknown as ExtensionContext;
}

// ---- Tests -------------------------------------------------------------

const ENV_KEYS = ["PI_EXT_DEMO", "PI_EXT_MODES", "PI_DISABLE", "PI_ENABLE"];

beforeEach(() => {
	__resetCapabilityRegistry();
	setSettingsLayer(undefined);
	for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
	setSettingsLayer(undefined);
	for (const k of ENV_KEYS) delete process.env[k];
});

describe("feature flags", () => {
	it("defaults every extension and flag on", () => {
		expect(isExtensionEnabled("demo")).toBe(true);
		expect(isFlagEnabled("demo", "thing")).toBe(true);
	});

	it("PI_EXT_<NAME>=off disables the whole extension and its flags", () => {
		process.env.PI_EXT_DEMO = "off";
		expect(isExtensionEnabled("demo")).toBe(false);
		expect(isFlagEnabled("demo", "thing")).toBe(false);
	});

	it("PI_DISABLE kills a single flag; PI_ENABLE leaves others on", () => {
		process.env.PI_DISABLE = "demo.thing,other.x";
		expect(isFlagEnabled("demo", "thing")).toBe(false);
		expect(isFlagEnabled("demo", "other")).toBe(true);
	});

	it("env kill switch wins over PI_ENABLE (fail safe)", () => {
		process.env.PI_DISABLE = "demo.thing";
		process.env.PI_ENABLE = "demo.thing";
		expect(isFlagEnabled("demo", "thing")).toBe(false);
	});

	it("consults the injected settings layer below env, above default", () => {
		setSettingsLayer({
			extensionEnabled: (name) => (name === "demo" ? false : undefined),
			flagEnabled: () => undefined,
		});
		expect(isExtensionEnabled("demo")).toBe(false);
		// env overrides the settings layer
		process.env.PI_EXT_DEMO = "on";
		expect(isExtensionEnabled("demo")).toBe(true);
	});
});

describe("capability registry", () => {
	const impl: ModesCapabilityV1 = {
		current: () => "auto",
		onChange: () => () => {},
	};

	it("register + get + require resolve the same instance", () => {
		const dispose = registerCapability(CAPABILITIES.modes, impl);
		expect(getCapability(CAPABILITIES.modes)).toBe(impl);
		expect(requireCapability(CAPABILITIES.modes)).toBe(impl);
		dispose();
		expect(getCapability(CAPABILITIES.modes)).toBeUndefined();
	});

	it("require throws when the capability is absent", () => {
		expect(() => requireCapability(CAPABILITIES.commit)).toThrow(
			/not available/,
		);
	});

	it("whenAvailable resolves on late registration", async () => {
		const pending = whenCapabilityAvailable(CAPABILITIES.modes);
		registerCapability(CAPABILITIES.modes, impl);
		await expect(pending).resolves.toBe(impl);
	});
});

describe("typed event bus", () => {
	it("round-trips a typed payload over the underlying bus", () => {
		const bus = createTypedEventBus(fakeEventBus());
		let seen: unknown;
		bus.on("maestro.mode.changed", (p) => {
			seen = p;
		});
		bus.emit("maestro.mode.changed", { mode: "auto", previous: "plan" });
		expect(seen).toEqual({ mode: "auto", previous: "plan" });
	});
});

describe("defineExtension", () => {
	it("runs the factory and supplies a maestro context when enabled", () => {
		const pi = fakePi();
		let ctx: unknown;
		const entry = defineExtension({ name: "demo" }, (_pi, maestro) => {
			ctx = maestro;
			maestro.capabilities.register(CAPABILITIES.modes, {
				current: () => "plan",
				onChange: () => () => {},
			});
		});
		entry(pi.api);
		expect(ctx).toMatchObject({ name: "demo" });
		expect(getCapability(CAPABILITIES.modes)).toBeDefined();
	});

	it("registers nothing when disabled (behavioural contract)", () => {
		process.env.PI_EXT_DEMO = "off";
		const pi = fakePi();
		let ran = false;
		const entry = defineExtension({ name: "demo" }, (rawPi) => {
			ran = true;
			rawPi.registerTool({} as never);
		});
		entry(pi.api);
		expect(ran).toBe(false);
		expect(pi.registrations).toEqual([]);
	});

	it("disposes registered capabilities on session_shutdown", () => {
		const pi = fakePi();
		const entry = defineExtension({ name: "demo" }, (_pi, maestro) => {
			maestro.capabilities.register(CAPABILITIES.modes, {
				current: () => "ask",
				onChange: () => () => {},
			});
		});
		entry(pi.api);
		expect(getCapability(CAPABILITIES.modes)).toBeDefined();
		pi.fire("session_shutdown");
		expect(getCapability(CAPABILITIES.modes)).toBeUndefined();
	});
});

describe("runAgentTurn", () => {
	it("sends the message, waits for agent_end, returns assistant text", async () => {
		const pi = fakePi();
		const ctx = fakeCtx({ idle: false, assistantText: "done" });
		const promise = runAgentTurn(pi.api, ctx, "do the thing");
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.content).toBe("do the thing");
		pi.fire("agent_end");
		await expect(promise).resolves.toBe("done");
	});

	it("returns empty string when already idle with no assistant text", async () => {
		const pi = fakePi();
		const ctx = fakeCtx({ idle: true });
		await expect(runAgentTurn(pi.api, ctx, "noop")).resolves.toBe("");
	});
});
