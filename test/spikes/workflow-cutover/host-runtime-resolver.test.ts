import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAESTRO_PACKAGE_PINS } from "../../../packages/maestro/src/setup.js";
import {
	AGENT_TOOLKIT_SOURCE_REVISION,
	AGENT_TOOLKIT_TREE_DIGEST,
	HostWorkflowPhaseRuntimeResolver,
} from "../../../packages/maestro/src/workflow/host-runtime-resolver.js";
import {
	digestWorkflowRuntimePackage,
	type MaterializeWorkflowSupervisorRuntimeOptions,
	type WorkflowSupervisorRuntimeMaterialization,
} from "../../../packages/maestro/src/workflow/supervisor-runtime.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(options?: {
	packages?: unknown;
	auth?: unknown;
	models?: unknown;
	writeModels?: boolean;
}) {
	const root = mkdtempSync(join(tmpdir(), "maestro-host-runtime-"));
	roots.push(root);
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	const runRoot = join(root, "run");
	const toolkitRoot = join(root, "installed-toolkit");
	for (const directory of [cwd, agentDir, runRoot, toolkitRoot])
		mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			packages: options?.packages ?? [MAESTRO_PACKAGE_PINS.agentToolkit],
		}),
	);
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify(
			options?.auth ?? {
				anthropic: { type: "api_key", key: "anthropic-secret" },
				openai: {
					type: "oauth",
					access: "access-secret",
					refresh: "refresh-secret",
					expires: 4_000_000_000_000,
				},
				unapproved: { type: "api_key", key: "must-stay-host-only" },
			},
		),
	);
	if (options?.writeModels !== false)
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify(
				options?.models ?? {
					providers: {
						anthropic: { models: [{ id: "claude-opus-5" }] },
						openai: { models: [{ id: "gpt-5" }] },
						unapproved: { models: [{ id: "private-model" }] },
					},
				},
			),
		);
	writeFileSync(
		join(toolkitRoot, "package.json"),
		JSON.stringify({ name: "@vegardx/agent-toolkit", version: "0.1.0" }),
	);
	mkdirSync(join(toolkitRoot, "skills", "security"), { recursive: true });
	writeFileSync(
		join(toolkitRoot, "skills", "security", "SKILL.md"),
		"---\nname: security\ndescription: Security review.\n---\nReview.\n",
	);
	mkdirSync(join(toolkitRoot, ".git"), { recursive: true });
	writeFileSync(
		join(toolkitRoot, ".git", "HEAD"),
		`${AGENT_TOOLKIT_SOURCE_REVISION}\n`,
	);
	return { root, cwd, agentDir, runRoot, toolkitRoot };
}

function harness(made: ReturnType<typeof fixture>) {
	let captured: MaterializeWorkflowSupervisorRuntimeOptions | undefined;
	const runtime = {
		marker: "runtime",
	} as unknown as WorkflowSupervisorRuntimeMaterialization;
	const getInstalledPath = vi.fn(() => made.toolkitRoot);
	const install = vi.fn();
	const update = vi.fn();
	const packageLocator = { getInstalledPath, install, update };
	const resolver = new HostWorkflowPhaseRuntimeResolver({
		cwd: made.cwd,
		agentDir: made.agentDir,
		sourceEnvironment: {
			PATH: "/usr/bin:/bin",
			ANTHROPIC_API_KEY: "explicit-provider-env",
			GH_TOKEN: "publication-secret",
			UNRELATED_TOKEN: "must-not-cross",
		},
		allowedEnvironmentKeys: ["ANTHROPIC_API_KEY", "GH_TOKEN"],
		packageLocator,
		digestPackage: () => AGENT_TOOLKIT_TREE_DIGEST,
		materializeRuntime: (options) => {
			captured = options;
			return runtime;
		},
	});
	return {
		resolver,
		runtime,
		get captured() {
			return captured;
		},
		getInstalledPath,
		install,
		update,
	};
}

async function resolve(
	resolver: HostWorkflowPhaseRuntimeResolver,
	runRoot: string,
	providers = ["anthropic"],
) {
	return resolver.resolve({
		coordinatedRunRoot: runRoot,
		runId: "implementation-1",
		approvedModels: providers.map((provider) => `${provider}/approved-model`),
		approvedProviderIds: providers,
	});
}

describe("HostWorkflowPhaseRuntimeResolver", () => {
	it("filters auth, models, and environment to the approved providers without changing the host", async () => {
		const made = fixture();
		const beforeAgent = digestWorkflowRuntimePackage(made.agentDir);
		const beforeToolkit = digestWorkflowRuntimePackage(made.toolkitRoot);
		const h = harness(made);

		const result = await resolve(h.resolver, made.runRoot, [
			"openai",
			"anthropic",
		]);

		expect(result.runtime).toBe(h.runtime);
		expect(h.captured?.runtimeNamespace).toBe("implementation-1");
		expect(h.captured?.sourceAuth).toEqual({
			anthropic: { type: "api_key", key: "anthropic-secret" },
			openai: {
				type: "oauth",
				access: "access-secret",
				refresh: "refresh-secret",
				expires: 4_000_000_000_000,
			},
		});
		expect(h.captured?.models).toEqual({
			providers: {
				anthropic: { models: [{ id: "claude-opus-5" }] },
				openai: { models: [{ id: "gpt-5" }] },
			},
		});
		expect(h.captured?.allowedEnvironmentKeys).toEqual([
			"ANTHROPIC_API_KEY",
			"GH_TOKEN",
		]);
		expect(h.captured?.sourceEnvironment.ANTHROPIC_API_KEY).toBe(
			"explicit-provider-env",
		);
		expect(h.captured?.sourceEnvironment.UNRELATED_TOKEN).toBeUndefined();
		expect(h.captured?.sourceEnvironment.GH_TOKEN).toBeUndefined();
		expect(digestWorkflowRuntimePackage(made.agentDir)).toBe(beforeAgent);
		expect(digestWorkflowRuntimePackage(made.toolkitRoot)).toBe(beforeToolkit);
	});

	it("fails closed when the exact global toolkit pin is absent", async () => {
		const made = fixture({
			packages: ["git:github.com/vegardx/agent-toolkit@deadbeef"],
		});
		const h = harness(made);
		await expect(resolve(h.resolver, made.runRoot)).rejects.toThrow(
			/exactly the pinned agent-toolkit/,
		);
		expect(h.getInstalledPath).not.toHaveBeenCalled();
	});

	it("fails closed for missing and invalid selected provider auth", async () => {
		const missing = fixture({
			auth: { openai: { type: "api_key", key: "other" } },
		});
		await expect(
			resolve(harness(missing).resolver, missing.runRoot),
		).rejects.toThrow(/missing selected provider anthropic/);

		const invalid = fixture({
			auth: { anthropic: { type: "api_key", key: "" } },
		});
		await expect(
			resolve(harness(invalid).resolver, invalid.runRoot),
		).rejects.toThrow(/invalid selected provider anthropic/);
	});

	it("supports built-in providers without models.json and preserves custom credential-blind config", async () => {
		const builtin = fixture({ writeModels: false });
		const builtinHarness = harness(builtin);
		await resolve(builtinHarness.resolver, builtin.runRoot);
		expect(builtinHarness.captured?.models).toEqual({ providers: {} });

		const custom = fixture({
			auth: { gateway: { type: "api_key", key: "gateway-secret" } },
			models: {
				providers: {
					gateway: {
						api: "openai-responses",
						baseUrl: "https://models.example.test/v1",
						models: [{ id: "custom-5", contextWindow: 131_072 }],
					},
					unapproved: { models: [{ id: "hidden" }] },
				},
			},
		});
		const customHarness = harness(custom);
		await resolve(customHarness.resolver, custom.runRoot, ["gateway"]);
		expect(customHarness.captured?.models).toEqual({
			providers: {
				gateway: {
					api: "openai-responses",
					baseUrl: "https://models.example.test/v1",
					models: [{ id: "custom-5", contextWindow: 131_072 }],
				},
			},
		});
	});

	it("uses only the read-only package lookup and refuses a wrong tree digest", async () => {
		const made = fixture();
		const h = harness(made);
		await resolve(h.resolver, made.runRoot);
		expect(h.getInstalledPath).toHaveBeenCalledExactlyOnceWith(
			MAESTRO_PACKAGE_PINS.agentToolkit,
			"user",
		);
		expect(h.install).not.toHaveBeenCalled();
		expect(h.update).not.toHaveBeenCalled();

		const wrongRun = join(made.root, "wrong-run");
		mkdirSync(wrongRun);
		const wrong = new HostWorkflowPhaseRuntimeResolver({
			cwd: made.cwd,
			agentDir: made.agentDir,
			packageLocator: { getInstalledPath: () => made.toolkitRoot },
			digestPackage: () => "0".repeat(64),
			materializeRuntime: () => h.runtime,
		});
		await expect(resolve(wrong, wrongRun)).rejects.toThrow(
			/pinned tree digest/,
		);
	});

	it("never changes the host auth or models files", async () => {
		const made = fixture();
		const auth = readFileSync(join(made.agentDir, "auth.json"), "utf8");
		const models = readFileSync(join(made.agentDir, "models.json"), "utf8");
		await resolve(harness(made).resolver, made.runRoot);
		expect(readFileSync(join(made.agentDir, "auth.json"), "utf8")).toBe(auth);
		expect(readFileSync(join(made.agentDir, "models.json"), "utf8")).toBe(
			models,
		);
	});
});
