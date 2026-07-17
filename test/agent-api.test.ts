import type {
	AgentKind,
	AgentKindDefinition,
	AgentPermissionPolicy,
	AgentRuntimePolicyDefinition,
	AgentSessionPolicy,
	AgentTransportPolicy,
	RunHandle,
	RunId,
	RunRecord,
	RunResult,
	SpawnProfile,
	SubagentsCapabilityV1,
} from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import {
	AgentRegistry,
	BUILTIN_AGENT_KINDS,
	createAgentsCapability,
	createAgentTool,
	createBuiltinAgentRegistries,
	DuplicateRegistryEntryError,
	resolveRuntimePolicy,
} from "../packages/subagents/src/index.js";

function id(value: string): RunId {
	return value as RunId;
}

const terminal: RunResult = { status: "succeeded", summary: "done" };

function transport() {
	const profiles: SpawnProfile[] = [];
	const records: RunRecord[] = [];
	let n = 0;
	const capability: SubagentsCapabilityV1 = {
		spawn: (_prompt, profile) => {
			n += 1;
			const runId = id(`run-${n}`);
			profiles.push(profile);
			const handle: RunHandle = {
				id: runId,
				status: () => "succeeded",
				steer: () => {},
				stop: () => {},
				result: async () => terminal,
			};
			records.push({
				schemaVersion: 2,
				id: runId,
				profile,
				status: "succeeded",
				createdAt: 1,
				updatedAt: 2,
				result: terminal,
			});
			return handle;
		},
		get: (runId) => records.find((record) => record.id === runId),
		list: () => records,
		steer: () => {},
		stop: () => {},
		capture: async () => "captured",
	};
	return { capability, profiles };
}

function executable(tool: ReturnType<typeof createAgentTool>) {
	return tool as unknown as {
		execute(
			id: string,
			params: Record<string, unknown>,
		): Promise<{ content: readonly [{ text: string }]; details: unknown }>;
	};
}

describe("typed agent registries", () => {
	it("registers every built-in kind with complete routing policy", () => {
		const registry = createBuiltinAgentRegistries();
		expect(registry.kinds.list().map((kind) => kind.id)).toEqual(
			BUILTIN_AGENT_KINDS.map((kind) => kind.id),
		);
		for (const kind of registry.kinds.list()) {
			expect(kind.routingSummary).not.toBe("");
			expect(kind.prompt).not.toBe("");
			expect(kind.sequencing.guidance).not.toBe("");
			expect(kind.reducer).not.toBe("");
			expect(() =>
				resolveRuntimePolicy(registry.runtime, kind.runtimePolicy),
			).not.toThrow();
		}
	});

	it("composes permission, session, and transport registries independently", () => {
		const permissions = new AgentRegistry<AgentPermissionPolicy>([
			{
				id: "p",
				mode: "read-only",
				tools: { allow: ["read"] },
				isolation: "strong",
			},
		]);
		const sessions = new AgentRegistry<AgentSessionPolicy>([
			{ id: "s", session: "ephemeral", maxTurns: 3 },
		]);
		const transports = new AgentRegistry<AgentTransportPolicy>([
			{ id: "t", transport: "headless", timeoutMs: 42 },
		]);
		const policies = new AgentRegistry<AgentRuntimePolicyDefinition>([
			{ id: "runtime", permissions: "p", session: "s", transport: "t" },
		]);
		expect(
			resolveRuntimePolicy(
				{ permissions, sessions, transports, policies },
				"runtime",
			),
		).toEqual({
			mode: "read-only",
			tools: { allow: ["read"] },
			isolation: "strong",
			session: "ephemeral",
			maxTurns: 3,
			transport: "headless",
			timeoutMs: 42,
		});
	});

	it("fails fast on duplicate registrations", () => {
		const registry = new AgentRegistry<AgentKindDefinition>();
		const kind = BUILTIN_AGENT_KINDS.find((item) => item.id === "general");
		expect(kind).toBeDefined();
		registry.register(kind as AgentKindDefinition);
		expect(() => registry.register(kind as AgentKindDefinition)).toThrow(
			DuplicateRegistryEntryError,
		);
	});
});

describe("unified agent capability and tool", () => {
	function setup() {
		const runTransport = transport();
		const capability = createAgentsCapability({
			subagents: () => runTransport.capability,
			registries: createBuiltinAgentRegistries(),
			resolveModel: async (kind, choice) => ({
				presetId: "preset",
				modelSetId: kind.modelRole,
				optionId: `${choice.model ?? "model/default"}@${choice.effort ?? "medium"}`,
				modelId: choice.model ?? "model/default",
				effort: choice.effort ?? "medium",
				source: choice.model || choice.effort ? "explicit" : "preset",
			}),
			researchToolsPath: () => "/research-tools.ts",
			now: () => new Date("2026-01-01T00:00:00Z"),
		});
		return { ...runTransport, capability };
	}

	it("resolves exact assignments and maps kind/runtime policy to spawn", async () => {
		const { capability, profiles } = setup();
		const spawned = await capability.run({
			kind: "web-research",
			prompt: "Find the primary source",
			model: "provider/model",
			effort: "high",
		});
		expect(spawned.assignment).toMatchObject({
			kind: "web-research",
			modelId: "provider/model",
			effort: "high",
			resolvedAt: "2026-01-01T00:00:00.000Z",
			source: "explicit",
		});
		expect(profiles[0]).toMatchObject({
			role: "web-research",
			model: "provider/model",
			thinking: "high",
			tools: { allow: expect.arrayContaining(["websearch", "context7"]) },
			extraExtensions: ["/research-tools.ts"],
			session: false,
		});
	});

	it("batches concurrently and exposes list/status/capture/result", async () => {
		const { capability } = setup();
		const runs = await capability.batch([
			{ kind: "general", prompt: "a" },
			{ kind: "correctness-review", prompt: "b" },
		]);
		expect(runs.map((run) => run.runId)).toEqual(["run-1", "run-2"]);
		expect(capability.list()).toHaveLength(2);
		expect(capability.status(id("run-1"))?.status).toBe("succeeded");
		expect(await capability.capture(id("run-1"))).toBe("captured");
		expect(await capability.result(id("run-1"))).toEqual(terminal);
	});

	it("offers one model-facing tool for run/batch/list/status/control/output", async () => {
		const { capability } = setup();
		const tool = executable(createAgentTool(() => capability));
		const run = await tool.execute("1", {
			action: "run",
			kind: "general" satisfies AgentKind,
			prompt: "inspect",
		});
		expect(run.content[0].text).toContain("Started general as run-1");
		const list = await tool.execute("2", { action: "list" });
		expect(list.content[0].text).toContain("codebase-research");
		expect(list.content[0].text).toContain("run-1");
		const result = await tool.execute("3", {
			action: "result",
			runId: "run-1",
		});
		expect(result.content[0].text).toContain("done");
	});
});
