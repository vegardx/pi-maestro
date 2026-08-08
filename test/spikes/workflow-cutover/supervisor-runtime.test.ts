import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	digestWorkflowRuntimePackage,
	type MaterializeWorkflowSupervisorRuntimeOptions,
	materializeWorkflowSupervisorRuntime,
	verifyWorkflowSupervisorRuntimeSeal,
} from "../../../packages/maestro/src/workflow/supervisor-runtime.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(): MaterializeWorkflowSupervisorRuntimeOptions {
	const root = mkdtempSync(join(tmpdir(), "maestro-supervisor-runtime-"));
	roots.push(root);
	const runRoot = join(root, "run");
	const realPi = join(root, "real-pi");
	writeFileSync(realPi, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
	chmodSync(realPi, 0o755);
	const realGit = join(root, "real-git");
	writeFileSync(realGit, '#!/bin/sh\nprintf "git:%s\\n" "$@"\n');
	chmodSync(realGit, 0o755);
	const toolkitRoot = join(root, "installed-agent-toolkit");
	mkdirSync(join(toolkitRoot, "skills", "security", "references"), {
		recursive: true,
	});
	mkdirSync(join(toolkitRoot, "skills", "correctness", "scripts"), {
		recursive: true,
	});
	writeFileSync(
		join(toolkitRoot, "package.json"),
		JSON.stringify({
			name: "@vegardx/agent-toolkit",
			version: "1.2.3",
			pi: { skills: ["skills"] },
		}),
	);
	writeFileSync(
		join(toolkitRoot, "skills", "security", "SKILL.md"),
		"---\nname: security\ndescription: Review changes for security risks.\n---\nReview security.\n",
	);
	writeFileSync(
		join(toolkitRoot, "skills", "security", "references", "threats.md"),
		"Treat trust boundaries as data.\n",
	);
	writeFileSync(
		join(toolkitRoot, "skills", "correctness", "SKILL.md"),
		"---\nname: correctness\ndescription: Review changes for correctness defects.\n---\nReview correctness.\n",
	);
	const script = join(
		toolkitRoot,
		"skills",
		"correctness",
		"scripts",
		"check.sh",
	);
	writeFileSync(script, "#!/bin/sh\nexit 0\n");
	chmodSync(script, 0o755);

	return {
		coordinatedRunRoot: runRoot,
		runtimeNamespace: "test-phase",
		sourceEnvironment: {
			PATH: "/usr/bin:/bin",
			LANG: "en_US.UTF-8",
			ANTHROPIC_API_KEY: "model-env-secret",
			GH_TOKEN: "must-not-publish",
			GH_ENTERPRISE_TOKEN: "must-not-publish-enterprise",
			GITHUB_TOKEN: "must-not-publish-either",
			SSH_AUTH_SOCK: "/developer/ssh-agent.sock",
			GIT_CONFIG_KEY_0: "credential.helper",
			GIT_CONFIG_VALUE_0: "malicious-helper",
			UNRELATED_SECRET: "must-not-cross",
		},
		allowedEnvironmentKeys: [
			"ANTHROPIC_API_KEY",
			"GH_TOKEN",
			"GH_ENTERPRISE_TOKEN",
			"GITHUB_TOKEN",
			"SSH_AUTH_SOCK",
			"GIT_CONFIG_KEY_0",
			"GIT_CONFIG_VALUE_0",
		],
		approvedProviderIds: ["anthropic", "openai-codex"],
		sourceAuth: {
			anthropic: { type: "api_key", key: "anthropic-file-secret" },
			"openai-codex": {
				type: "oauth",
				access: "model-access",
				refresh: "model-refresh",
				expires: 123,
			},
			github: { type: "oauth", access: "publication-token" },
		},
		models: {
			providers: {
				anthropic: { models: [{ id: "claude-opus-5" }] },
				github: { models: [{ id: "publication-adjacent-model" }] },
			},
		},
		agentToolkit: {
			sourceRoot: toolkitRoot,
			expectedDigest: digestWorkflowRuntimePackage(toolkitRoot),
			expectedVersion: "1.2.3",
			sourceRevision: "1".repeat(40),
		},
		piExecutable: realPi,
		gitExecutable: realGit,
	};
}

describe("workflow supervisor runtime materializer", () => {
	it("creates a minimal runtime with a complete pinned skill package", () => {
		const options = fixture();
		const runtime = materializeWorkflowSupervisorRuntime(options);

		expect(runtime.runtimeRoot).toBe(
			realpathSync(
				join(
					options.coordinatedRunRoot,
					"scratch",
					"workflow-supervisors",
					options.runtimeNamespace,
				),
			),
		);
		expect(runtime.scratchRoots).toEqual([
			runtime.homeDir,
			runtime.tmpDir,
			runtime.sessionDir,
			runtime.workflowAuthFile,
		]);
		expect(runtime.scratchRoots).not.toContain(runtime.runtimeRoot);
		expect(runtime.scratchRoots).not.toContain(runtime.agentDir);
		expect(runtime.scratchRoots).not.toContain(runtime.binDir);
		expect(JSON.parse(readFileSync(runtime.settingsFile, "utf8"))).toEqual({
			defaultProjectTrust: "never",
			packages: [
				{
					source: runtime.agentToolkitPackageRoot,
					autoload: false,
					extensions: [],
					skills: ["**"],
					prompts: [],
					themes: [],
				},
			],
		});
		expect(JSON.parse(readFileSync(runtime.modelsFile, "utf8"))).toEqual({
			providers: {
				anthropic: { models: [{ id: "claude-opus-5" }] },
			},
		});
		expect(JSON.parse(readFileSync(runtime.workflowAuthFile, "utf8"))).toEqual({
			anthropic: options.sourceAuth.anthropic,
			"openai-codex": options.sourceAuth["openai-codex"],
		});
		expect(
			readFileSync(
				join(
					runtime.agentToolkitPackageRoot,
					"skills",
					"security",
					"references",
					"threats.md",
				),
				"utf8",
			),
		).toBe("Treat trust boundaries as data.\n");
		expect(runtime.agentToolkitDigest).toBe(
			options.agentToolkit.expectedDigest,
		);
		expect(existsSync(join(runtime.runtimeRoot, "materialization.json"))).toBe(
			true,
		);
	});

	it("child seal verification rejects immutable config and toolkit mutation", () => {
		const runtime = materializeWorkflowSupervisorRuntime(fixture());
		const expected = {
			materializationDigest: runtime.materializationDigest,
			agentToolkitDigest: runtime.agentToolkitDigest,
			agentToolkitVersion: runtime.agentToolkitVersion,
			agentToolkitSourceRevision: runtime.agentToolkitSourceRevision,
		};
		expect(() =>
			verifyWorkflowSupervisorRuntimeSeal(runtime.runtimeRoot, expected),
		).not.toThrow();
		writeFileSync(runtime.settingsFile, "{}\n");
		expect(() =>
			verifyWorkflowSupervisorRuntimeSeal(runtime.runtimeRoot, expected),
		).toThrow(/immutable file changed/);

		const toolkitRuntime = materializeWorkflowSupervisorRuntime(fixture());
		writeFileSync(
			join(toolkitRuntime.agentToolkitPackageRoot, "skills", "added.md"),
			"changed\n",
		);
		expect(() =>
			verifyWorkflowSupervisorRuntimeSeal(toolkitRuntime.runtimeRoot, {
				materializationDigest: toolkitRuntime.materializationDigest,
				agentToolkitDigest: toolkitRuntime.agentToolkitDigest,
				agentToolkitVersion: toolkitRuntime.agentToolkitVersion,
				agentToolkitSourceRevision: toolkitRuntime.agentToolkitSourceRevision,
			}),
		).toThrow(/immutable toolkit changed/);
	});

	it("is discoverable by Pi as ambient skills without a workflow skill list", async () => {
		const runtime = materializeWorkflowSupervisorRuntime(fixture());
		const settings = SettingsManager.create(runtime.homeDir, runtime.agentDir);
		const loader = new DefaultResourceLoader({
			cwd: runtime.homeDir,
			agentDir: runtime.agentDir,
			settingsManager: settings,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});

		await loader.reload();

		const skillResult = loader.getSkills();
		const discovered = skillResult.skills.map((skill) => skill.name).sort();
		expect(discovered, JSON.stringify(skillResult.diagnostics)).toEqual([
			"correctness",
			"security",
		]);
		expect(
			JSON.parse(readFileSync(runtime.settingsFile, "utf8")),
		).not.toHaveProperty("skills");
	});

	it("builds a scratch-local environment without publication credentials", () => {
		const runtime = materializeWorkflowSupervisorRuntime(fixture());

		expect(runtime.environment).toMatchObject({
			LANG: "en_US.UTF-8",
			ANTHROPIC_API_KEY: "model-env-secret",
			HOME: runtime.homeDir,
			TMPDIR: runtime.tmpDir,
			TMP: runtime.tmpDir,
			TEMP: runtime.tmpDir,
			PI_CODING_AGENT_DIR: runtime.agentDir,
			PI_CODING_AGENT_SESSION_DIR: runtime.sessionDir,
			PI_WORKFLOW_AUTH_FILE: runtime.workflowAuthFile,
			GIT_CONFIG_GLOBAL: runtime.gitConfigFile,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		});
		for (const key of [
			"GH_TOKEN",
			"GH_ENTERPRISE_TOKEN",
			"GITHUB_TOKEN",
			"SSH_AUTH_SOCK",
			"UNRELATED_SECRET",
		])
			expect(runtime.environment[key]).toBeUndefined();
		expect(readFileSync(runtime.gitConfigFile, "utf8")).toBe(
			"[credential]\n\thelper =\n\tinteractive = false\n",
		);
		expect(readFileSync(runtime.piShimFile, "utf8")).toMatch(
			/^#!\/bin\/sh\nexec '.+' "\$@" --no-approve\n$/,
		);
		expect(
			execFileSync(runtime.piShimFile, ["--model", "test"], {
				encoding: "utf8",
			}),
		).toBe("--model\ntest\n--no-approve\n");
		expect(runtime.environment.PATH?.split(":")[0]).toBe(runtime.binDir);
		expect(
			execFileSync(runtime.gitShimFile, ["status"], { encoding: "utf8" }),
		).toBe("git:status\n");
		const deniedPush = spawnSync(runtime.gitShimFile, ["-C", "/repo", "push"], {
			encoding: "utf8",
		});
		expect(deniedPush.status).toBe(126);
		expect(deniedPush.stderr).toContain("reserved for the seat");
		expect(deniedPush.stdout).toBe("");
		expect(runtime.environment).toMatchObject({
			GIT_ALLOW_PROTOCOL: "",
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: "credential.helper",
			GIT_CONFIG_VALUE_0: "",
			GIT_CONFIG_KEY_1: "credential.interactive",
			GIT_CONFIG_VALUE_1: "false",
			GCM_INTERACTIVE: "Never",
		});
	});

	it("reuses a verified runtime without overwriting refreshed model auth", () => {
		const options = fixture();
		const first = materializeWorkflowSupervisorRuntime(options);
		const refreshed = JSON.parse(
			readFileSync(first.workflowAuthFile, "utf8"),
		) as Record<string, Record<string, unknown>>;
		refreshed["openai-codex"]!.access = "refreshed-access";
		writeFileSync(first.workflowAuthFile, JSON.stringify(refreshed));
		chmodSync(first.workflowAuthFile, 0o600);

		const resumed = materializeWorkflowSupervisorRuntime(options);

		expect(resumed.runtimeRoot).toBe(first.runtimeRoot);
		expect(
			JSON.parse(readFileSync(resumed.workflowAuthFile, "utf8"))["openai-codex"]
				.access,
		).toBe("refreshed-access");
	});

	it("isolates implementation, review, and decision provider seals by package run", () => {
		const base = fixture();
		const sourceAuth = {
			test: { type: "api_key", key: "test-secret" },
			anthropic: { type: "api_key", key: "anthropic-secret" },
			xai: { type: "api_key", key: "xai-secret" },
		} as const;
		const models = {
			providers: {
				test: { models: [{ id: "implementer" }] },
				anthropic: { models: [{ id: "opus-5" }] },
				xai: { models: [{ id: "grok-4.5" }] },
			},
		};
		const phase = (
			runtimeNamespace: string,
			approvedProviderIds: readonly string[],
		) =>
			materializeWorkflowSupervisorRuntime({
				...base,
				runtimeNamespace,
				approvedProviderIds,
				sourceAuth,
				models,
			});

		const implementation = phase("plan_implementation", ["test"]);
		const review = phase("plan_review", ["anthropic", "xai"]);
		const decision = phase("plan_decision", ["test"]);

		expect(
			new Set([
				implementation.runtimeRoot,
				review.runtimeRoot,
				decision.runtimeRoot,
			]).size,
		).toBe(3);
		expect(
			JSON.parse(readFileSync(implementation.workflowAuthFile, "utf8")),
		).toEqual({
			test: sourceAuth.test,
		});
		expect(JSON.parse(readFileSync(review.workflowAuthFile, "utf8"))).toEqual({
			anthropic: sourceAuth.anthropic,
			xai: sourceAuth.xai,
		});
		expect(phase("plan_implementation", ["test"]).runtimeRoot).toBe(
			implementation.runtimeRoot,
		);

		writeFileSync(review.modelsFile, "{}\n");
		expect(() => phase("plan_review", ["anthropic", "xai"])).toThrow(
			"immutable file changed",
		);
		expect(phase("plan_decision", ["test"]).runtimeRoot).toBe(
			decision.runtimeRoot,
		);
	});

	it("refuses resume when an approved environment value changes", () => {
		const options = fixture();
		materializeWorkflowSupervisorRuntime(options);
		expect(() =>
			materializeWorkflowSupervisorRuntime({
				...options,
				sourceEnvironment: {
					...options.sourceEnvironment,
					ANTHROPIC_API_KEY: "changed-model-env-secret",
				},
			}),
		).toThrow(/resume input does not match/);
	});

	it("pins API-key bytes and the OAuth provider schema across resume", () => {
		const apiOptions = fixture();
		const apiRuntime = materializeWorkflowSupervisorRuntime(apiOptions);
		const apiAuth = JSON.parse(
			readFileSync(apiRuntime.workflowAuthFile, "utf8"),
		) as Record<string, Record<string, unknown>>;
		apiAuth.anthropic!.key = "mutated-api-key";
		writeFileSync(apiRuntime.workflowAuthFile, JSON.stringify(apiAuth));
		chmodSync(apiRuntime.workflowAuthFile, 0o600);
		expect(() => materializeWorkflowSupervisorRuntime(apiOptions)).toThrow(
			/API-key credential changed/,
		);

		const oauthOptions = fixture();
		const oauthRuntime = materializeWorkflowSupervisorRuntime(oauthOptions);
		const oauthAuth = JSON.parse(
			readFileSync(oauthRuntime.workflowAuthFile, "utf8"),
		) as Record<string, Record<string, unknown>>;
		oauthAuth["openai-codex"]!.publicationToken = "unexpected-field";
		writeFileSync(oauthRuntime.workflowAuthFile, JSON.stringify(oauthAuth));
		chmodSync(oauthRuntime.workflowAuthFile, 0o600);
		expect(() => materializeWorkflowSupervisorRuntime(oauthOptions)).toThrow(
			/OAuth credential schema changed/,
		);
	});

	it("filters models by provider and rejects credential-bearing model config", () => {
		const options = fixture();
		const unsafeOptions = {
			...options,
			models: {
				providers: {
					anthropic: {
						apiKey: "must-live-in-auth-json",
						models: [{ id: "claude-opus-5" }],
					},
				},
			},
		};
		expect(() => materializeWorkflowSupervisorRuntime(unsafeOptions)).toThrow(
			/contains credential field apiKey/,
		);
	});

	it("requires the exact pinned agent-toolkit identity and source revision", () => {
		const wrongName = fixture();
		writeFileSync(
			join(wrongName.agentToolkit.sourceRoot, "package.json"),
			JSON.stringify({ name: "arbitrary-skills", version: "1.2.3" }),
		);
		expect(() =>
			materializeWorkflowSupervisorRuntime({
				...wrongName,
				agentToolkit: {
					...wrongName.agentToolkit,
					expectedDigest: digestWorkflowRuntimePackage(
						wrongName.agentToolkit.sourceRoot,
					),
				},
			}),
		).toThrow(/identity must be @vegardx\/agent-toolkit/);

		const wrongVersion = fixture();
		expect(() =>
			materializeWorkflowSupervisorRuntime({
				...wrongVersion,
				agentToolkit: {
					...wrongVersion.agentToolkit,
					expectedVersion: "9.9.9",
				},
			}),
		).toThrow(/pinned version/);

		const wrongRevision = fixture();
		expect(() =>
			materializeWorkflowSupervisorRuntime({
				...wrongRevision,
				agentToolkit: {
					...wrongRevision.agentToolkit,
					sourceRevision: "main",
				},
			}),
		).toThrow(/declared source revision.*hex metadata/);
	});

	it.each([
		"client_secret",
		"Client-Secret",
		"api.key",
		"AUTH_HEADERS",
		"credential-token",
	])("rejects normalized credential-bearing model field %s", (field) => {
		const options = fixture();
		expect(() =>
			materializeWorkflowSupervisorRuntime({
				...options,
				models: {
					providers: {
						anthropic: { models: [{ id: "safe" }], [field]: "secret" },
					},
				},
			}),
		).toThrow(/contains credential field/);
	});

	it("does not reject an ordinary field merely containing key letters", () => {
		const options = fixture();
		expect(() =>
			materializeWorkflowSupervisorRuntime({
				...options,
				models: {
					providers: {
						anthropic: { models: [{ id: "safe", monkey: "value" }] },
					},
				},
			}),
		).not.toThrow();
	});

	it("fails closed when immutable runtime state or the package pin changes", () => {
		const options = fixture();
		const runtime = materializeWorkflowSupervisorRuntime(options);
		writeFileSync(runtime.modelsFile, "{}\n");

		expect(() => materializeWorkflowSupervisorRuntime(options)).toThrow(
			/immutable file changed/,
		);

		const other = fixture();
		writeFileSync(
			join(other.agentToolkit.sourceRoot, "skills", "security", "SKILL.md"),
			"changed after pin\n",
		);
		expect(() => materializeWorkflowSupervisorRuntime(other)).toThrow(
			/does not match its pinned digest/,
		);
	});

	it("rejects package symlinks instead of copying link escapes", () => {
		const options = fixture();
		const link = join(options.agentToolkit.sourceRoot, "skills", "outside");
		symlinkSync(tmpdir(), link, "dir");

		expect(() =>
			digestWorkflowRuntimePackage(options.agentToolkit.sourceRoot),
		).toThrow(/cannot contain symlink/);
	});

	it("rejects model credentials in plain key fields and URL query parameters", () => {
		expect(() =>
			materializeWorkflowSupervisorRuntime({
				...fixture(),
				models: {
					providers: { anthropic: { key: "must-not-cross" } },
				},
			}),
		).toThrow(/credential field key/);

		expect(() =>
			materializeWorkflowSupervisorRuntime({
				...fixture(),
				models: {
					providers: {
						anthropic: {
							baseUrl: "https://models.example.test/v1?token=secret",
						},
					},
				},
			}),
		).toThrow(/URL credentials/);
	});

	it("denies Git publication reached through a repository alias", () => {
		const options = fixture();
		const realGit = execFileSync("sh", ["-c", "command -v git"], {
			encoding: "utf8",
		}).trim();
		const runtime = materializeWorkflowSupervisorRuntime({
			...options,
			gitExecutable: realGit,
		});
		const repository = join(options.coordinatedRunRoot, "alias-repository");
		const remote = join(options.coordinatedRunRoot, "alias-remote.git");
		mkdirSync(repository, { recursive: true });
		execFileSync(realGit, ["init", "--bare", remote], { stdio: "ignore" });
		execFileSync(realGit, ["-C", repository, "init"], { stdio: "ignore" });
		execFileSync(
			realGit,
			[
				"-C",
				repository,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.test",
				"commit",
				"--allow-empty",
				"-m",
				"checkpoint",
			],
			{ stdio: "ignore" },
		);
		execFileSync(realGit, [
			"-C",
			repository,
			"remote",
			"add",
			"origin",
			remote,
		]);
		execFileSync(realGit, [
			"-C",
			repository,
			"config",
			"alias.publish",
			"push",
		]);

		const attempted = spawnSync(
			runtime.gitShimFile,
			["-C", repository, "publish", "origin", "HEAD:main"],
			{ encoding: "utf8", env: runtime.environment },
		);
		expect(attempted.status).not.toBe(0);
		expect(attempted.stderr).toMatch(/transport 'file' not allowed/i);
	});
});

const unix = process.platform === "win32" ? describe.skip : describe;

unix("workflow supervisor runtime filesystem permissions", () => {
	it("uses private directory, credential, config, and executable modes", () => {
		const runtime = materializeWorkflowSupervisorRuntime(fixture());
		for (const directory of [
			runtime.runtimeRoot,
			runtime.homeDir,
			runtime.tmpDir,
			runtime.agentDir,
			runtime.sessionDir,
			runtime.agentToolkitPackageRoot,
			runtime.binDir,
		])
			expect(statSync(directory).mode & 0o777).toBe(0o700);
		for (const file of [
			runtime.workflowAuthFile,
			runtime.settingsFile,
			runtime.modelsFile,
			runtime.gitConfigFile,
		])
			expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(runtime.piShimFile).mode & 0o777).toBe(0o700);
		expect(statSync(runtime.gitShimFile).mode & 0o777).toBe(0o700);
		expect(
			statSync(
				join(
					runtime.agentToolkitPackageRoot,
					"skills",
					"correctness",
					"scripts",
					"check.sh",
				),
			).mode & 0o777,
		).toBe(0o700);
	});
});
