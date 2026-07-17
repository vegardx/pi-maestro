import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DomainRegistryInput,
	domainImpact,
	explainModelSelection,
	readDomainSnapshot,
	validateDomainEdit,
	writeDomainValue,
} from "../packages/settings/src/domain.js";
import {
	BUILTIN_AGENT_KINDS,
	createBuiltinAgentRegistries,
} from "../packages/subagents/src/registry.js";

let cwd: string;
let agentDir: string;
let oldAgentDir: string | undefined;

function settings(value: unknown) {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify(value, null, 2),
	);
}
function model(id: string, unsupported: string[] = []) {
	const [provider, ...rest] = id.split("/");
	return {
		provider,
		id: rest.join("/"),
		name: id,
		reasoning: true,
		thinkingLevelMap: Object.fromEntries(
			unsupported.map((effort) => [effort, null]),
		),
	};
}
function ctx(): ExtensionContext {
	const entries = [model("anthropic/sonnet"), model("openai/o3", ["low"])];
	return {
		cwd,
		model: entries[0],
		modelRegistry: {
			getAll: () => entries,
			find: (provider: string, id: string) =>
				entries.find((entry) => entry.provider === provider && entry.id === id),
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "key",
				headers: {},
			}),
		},
	} as unknown as ExtensionContext;
}
function registry(): DomainRegistryInput {
	const builtins = createBuiltinAgentRegistries();
	return {
		kinds: BUILTIN_AGENT_KINDS,
		runtime: {
			policies: builtins.runtime.policies.list(),
			permissions: builtins.runtime.permissions.list(),
			sessions: builtins.runtime.sessions.list(),
			transports: builtins.runtime.transports.list(),
		},
	};
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "maestro-domain-settings-"));
	agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
	if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
	rmSync(cwd, { recursive: true, force: true });
});

describe("Maestro domain configuration", () => {
	it("projects active preset, reverse model-set use, kinds, policies, and gates", () => {
		settings({
			models: {
				modelSets: {
					workers: {
						options: [
							{
								id: "fast",
								model: "openai/o3",
								effort: "high",
								summary: "Fast",
							},
						],
					},
				},
				presets: {
					main: {
						targets: ["anthropic/sonnet"],
						modelSets: { worker: "workers" },
					},
				},
			},
			extensionConfig: {
				maestro: {
					agents: {
						kinds: { worker: { runtimePolicy: "worker", modelSet: "workers" } },
					},
				},
			},
		});
		const snapshot = readDomainSnapshot(ctx(), registry());
		expect(snapshot.activePreset).toBe("main");
		expect(snapshot.matchedTarget).toBe("anthropic/sonnet");
		expect(snapshot.modelSets[0]?.usedBy).toEqual(["preset main · worker"]);
		expect(snapshot.kinds.find((kind) => kind.kind === "worker")).toMatchObject(
			{ modelSet: "workers", runtimePolicy: "worker" },
		);
		expect(snapshot.gates[0]).toMatchObject({
			id: "execution-readiness",
			agentKind: "plan-review",
		});
		expect(
			domainImpact(snapshot, "agents.runtimePolicies.worker", {}),
		).toContain("Used by: worker.");
	});

	it("explains exact availability, provenance, context, and fallback", async () => {
		settings({
			models: {
				modelSets: {
					workers: {
						options: [
							{
								id: "bad",
								model: "openai/o3",
								effort: "low",
								summary: "Unsupported",
							},
							{
								id: "good",
								model: "anthropic/sonnet",
								effort: "high",
								summary: "Available",
							},
						],
					},
				},
				presets: {
					main: {
						targets: ["anthropic/sonnet"],
						modelSets: { worker: "workers" },
					},
				},
			},
		});
		const report = await explainModelSelection(ctx(), "worker");
		expect(report).toContain("Main model: anthropic/sonnet");
		expect(report).toContain(
			"Active preset: main (matched target anthropic/sonnet)",
		);
		expect(report).toContain(
			"bad: openai/o3 @ low — effort low is unsupported",
		);
		expect(report).toContain("Assignment: anthropic/sonnet @ high (good)");
		expect(report).toContain("Source/provenance: preset");
		expect(report).toContain("do not gain an implicit session fallback");
	});

	it("validates ambiguous targets, broken references, unsafe policy, and gate contracts", () => {
		settings({
			models: {
				modelSets: {
					workers: {
						options: [
							{
								id: "fast",
								model: "openai/o3",
								effort: "high",
								summary: "Fast",
							},
						],
					},
				},
				presets: {
					main: {
						targets: ["anthropic/sonnet"],
						modelSets: { worker: "workers" },
					},
				},
			},
		});
		const context = ctx();
		expect(
			validateDomainEdit(
				context,
				"models.presets.other.targets",
				"project",
				'["anthropic/sonnet"]',
				registry(),
			),
		).toContain("target anthropic/sonnet is already owned by preset main");
		expect(
			validateDomainEdit(
				context,
				"models.presets.main.modelSets",
				"project",
				'{"worker":"missing"}',
				registry(),
			),
		).toContain("unknown model set missing");
		expect(
			validateDomainEdit(
				context,
				"agents.kinds.worker.option",
				"project",
				"missing",
				registry(),
			),
		).toContain("option missing is not in the bound model set");
		expect(
			validateDomainEdit(
				context,
				"agents.runtimePolicies.unsafe",
				"project",
				'{"permissions":"host","session":"one-shot","transport":"host"}',
				registry(),
			),
		).toContain(
			"unsafe runtime policy: ephemeral full-access host agents are not allowed",
		);
		expect(
			validateDomainEdit(
				context,
				"transitionGates.ready",
				"project",
				'{"edges":["plan->auto"],"agentKind":"plan-review","contract":"missing","enabled":true}',
				registry(),
			),
		).toContain("agent kind plan-review does not provide contract missing");
	});

	it("writes model and session-scoped binding configuration only after validation", () => {
		settings({
			models: { presets: { main: { targets: ["anthropic/sonnet"] } } },
		});
		const context = ctx();
		expect(
			writeDomainValue(
				context,
				"models.modelSets.workers",
				"project",
				'{"options":[{"id":"fast","model":"openai/o3","effort":"high","summary":"Fast"}]}',
				registry(),
			),
		).toEqual([]);
		expect(
			writeDomainValue(
				context,
				"agents.kinds.worker.modelSet",
				"session",
				'"workers"',
				registry(),
			),
		).toEqual([]);
		const raw = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(raw.models.modelSets.workers.options[0].id).toBe("fast");
		expect(
			readDomainSnapshot(context, registry()).kinds.find(
				(kind) => kind.kind === "worker",
			)?.modelSet,
		).toBe("workers");
	});
});
