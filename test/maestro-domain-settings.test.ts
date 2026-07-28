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
	it("projects kinds, policies, and gates", () => {
		settings({
			extensionConfig: {
				maestro: {
					agents: { kinds: { worker: { runtimePolicy: "worker" } } },
				},
			},
		});
		const snapshot = readDomainSnapshot(ctx(), registry());
		expect(snapshot.kinds.find((kind) => kind.kind === "worker")).toMatchObject(
			{ runtimePolicy: "worker" },
		);
		expect(snapshot.gates[0]).toMatchObject({
			id: "execution-readiness",
			agentKind: "plan-review",
		});
		expect(
			domainImpact(snapshot, "agents.runtimePolicies.worker", {}),
		).toContain("Used by: worker.");
	});

	it("validates ambiguous targets, broken references, unsafe policy, and gate contracts", () => {
		settings({});
		const context = ctx();
		expect(
			validateDomainEdit(
				context,
				"agents.runtimePolicies.unsafe",
				"project",
				'{"permissions":"host","session":"one-shot","transport":"host"}',
				registry(),
			),
		).toContain(
			"unsafe runtime policy: ephemeral full-access agents are not allowed",
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

	it("writes session-scoped kind bindings only after validation", () => {
		settings({});
		const context = ctx();
		expect(
			writeDomainValue(
				context,
				"agents.kinds.worker.runtimePolicy",
				"session",
				'"worker"',
				registry(),
			),
		).toEqual([]);
		expect(
			readDomainSnapshot(context, registry()).kinds.find(
				(kind) => kind.kind === "worker",
			)?.runtimePolicy,
		).toBe("worker");
	});

	// The v1 model surface outlived the resolver that read it: `/maestro set
	// models.presets…` validated, persisted, and then did nothing at all. A key
	// that validates is a key someone reasonably believes is live, so it must
	// now be REFUSED rather than silently accepted — and nothing may be written.
	it("refuses the retired v1 model surface instead of silently accepting it", () => {
		settings({ extensionConfig: { maestro: {} } });
		const file = join(cwd, ".pi", "settings.json");
		const before = readFileSync(file, "utf8");
		const context = ctx();
		for (const key of [
			"models.presets.release.targets",
			"models.modelSets.workers",
		]) {
			expect(
				writeDomainValue(context, key, "project", '{"options":[]}', registry()),
			).toEqual([expect.stringContaining("v1 model surface")]);
		}
		// Refusing must also mean writing nothing — an error the caller ignores
		// would otherwise still leave a dead key on disk.
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	// The other half of the same retirement: a kind binding that names a model
	// set cannot mean anything once model sets are gone.
	it("refuses kind bindings that name a deleted model set", () => {
		settings({});
		const context = ctx();
		expect(
			writeDomainValue(
				context,
				"agents.kinds.worker.modelSet",
				"session",
				'"workers"',
				registry(),
			),
		).toEqual([expect.stringContaining("unsupported kind binding modelSet")]);
	});
});
