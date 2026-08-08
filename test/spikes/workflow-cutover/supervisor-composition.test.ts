import { createHash } from "node:crypto";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";
import {
	digestWorkflowExecutionManifest,
	type WorkflowExecutionManifest,
} from "../../../packages/maestro/src/workflow/supervisor-execution-manifest.js";
import {
	WorkflowSupervisorLauncher,
	type WorkflowSupervisorRuntimeMaterializationLike,
} from "../../../packages/maestro/src/workflow/supervisor-launcher.js";
import {
	digestWorkflowRuntimePackage,
	WORKFLOW_CREDENTIAL_RESET_ENV,
} from "../../../packages/maestro/src/workflow/supervisor-runtime.js";
import { materializeWorkflowSupervisorState } from "../../../packages/maestro/src/workflow/supervisor-state.js";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const temporaryRoots: string[] = [];

interface ProbeLayout {
	runRoot: string;
	worktree: string;
	workflowState: string;
	specPath: string;
	specSha256: string;
	probeLog: string;
	runtime: WorkflowSupervisorRuntimeMaterializationLike;
	executionManifest: WorkflowExecutionManifest;
	executionManifestDigest: string;
}

afterEach(async () => {
	delete process.env.SUPERVISOR_HOST_ONLY_SECRET;
	await Promise.all(
		temporaryRoots.splice(0).map((root) =>
			rm(root, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 20,
			}),
		),
	);
});

async function makeLayout(): Promise<ProbeLayout> {
	const temporaryRoot = await mkdtemp(
		join(tmpdir(), "pi-maestro-supervisor-probe-"),
	);
	temporaryRoots.push(temporaryRoot);
	const runRoot = await realpath(temporaryRoot);
	const worktree = join(runRoot, "repos", "worktree-a");
	const scratch = join(runRoot, "scratch", "supervisor");
	const home = join(scratch, "home");
	const temporary = join(scratch, "tmp");
	const agent = join(scratch, "pi-agent");
	const sessions = join(scratch, "sessions");
	const bin = join(scratch, "bin");
	await Promise.all(
		[worktree, home, temporary, agent, sessions, bin].map((path) =>
			mkdir(path, { recursive: true }),
		),
	);
	const state = materializeWorkflowSupervisorState(runRoot);
	const bundleRoot = join(runRoot, "runtime", "workflow-bundle");
	await mkdir(bundleRoot, { recursive: true });
	const specPath = join(bundleRoot, "supervisor-composition.spec.json");
	await cp(join(fixtureRoot, "supervisor-composition.spec.json"), specPath);
	const specSha256 = createHash("sha256")
		.update(await readFile(specPath))
		.digest("hex");
	const fakePi = join(bin, "pi");
	await cp(join(fixtureRoot, "fake-pi.mjs"), fakePi);
	await chmod(fakePi, 0o700);
	const probeLog = join(scratch, "fake-pi-launches.ndjson");
	await writeFile(probeLog, "");
	const auth = join(agent, "auth.json");
	const gitConfig = join(home, ".gitconfig");
	await Promise.all([writeFile(auth, "{}\n"), writeFile(gitConfig, "")]);
	const immutable = join(scratch, "immutable");
	const sealedAgent = join(immutable, "pi-agent");
	const sealedBin = join(immutable, "bin");
	const sealedToolkit = join(sealedAgent, "packages", "agent-toolkit");
	await Promise.all([
		mkdir(sealedBin, { recursive: true }),
		mkdir(join(sealedToolkit, "skills", "probe"), { recursive: true }),
	]);
	const immutablePayloads = {
		"immutable/bin/git": "#!/bin/sh\nexit 0\n",
		"immutable/bin/pi": "#!/bin/sh\nexit 0\n",
		"immutable/gitconfig": "",
		"immutable/pi-agent/models.json": "{}\n",
		"immutable/pi-agent/settings.json": "{}\n",
	};
	await Promise.all(
		Object.entries(immutablePayloads).map(([relativePath, contents]) =>
			writeFile(join(scratch, relativePath), contents),
		),
	);
	await writeFile(
		join(sealedToolkit, "package.json"),
		JSON.stringify({ name: "@vegardx/agent-toolkit", version: "1.2.3" }),
	);
	await writeFile(
		join(sealedToolkit, "skills", "probe", "SKILL.md"),
		"probe\n",
	);
	const runtimeArtifacts = Object.fromEntries(
		await Promise.all(
			["models", "profile", "authority"].map(async (name) => {
				const path = join(runRoot, "runtime", `${name}.json`);
				if (name === "models") await cp(join(sealedAgent, "models.json"), path);
				else await writeFile(path, `${JSON.stringify({ probe: name })}\n`);
				return [name, { path, sha256: await digestFile(path) }] as const;
			}),
		),
	) as Record<string, { path: string; sha256: string }>;
	const materializationDigest = "1".repeat(64);
	const agentToolkitDigest = digestWorkflowRuntimePackage(sealedToolkit);
	const agentToolkitVersion = "1.2.3";
	const agentToolkitSourceRevision = "3".repeat(40);
	await writeFile(
		join(scratch, "materialization.json"),
		JSON.stringify({
			version: 1,
			runtimeNamespace: "supervisor",
			inputDigest: materializationDigest,
			agentToolkitDigest,
			agentToolkitVersion,
			agentToolkitSourceRevision,
			immutableFiles: Object.fromEntries(
				Object.entries(immutablePayloads).map(([path, contents]) => [
					path,
					createHash("sha256").update(contents).digest("hex"),
				]),
			),
			authCredentialTypes: {},
			immutableApiKeyDigests: {},
			oauthSchemas: {},
		}),
	);
	const writableRoots = [
		worktree,
		state.workflowStateRoot,
		home,
		temporary,
		sessions,
		auth,
	].sort();
	const executionManifest: WorkflowExecutionManifest = {
		version: 1,
		runId: "supervisor_composition_probe",
		launch: {
			task: "Prove the production package composition seam.",
			executionProfile: null,
			inputOverrides: {},
		},
		artifacts: {
			spec: { path: specPath, sha256: specSha256 },
			bundle: {
				root: bundleRoot,
				files: [
					{
						path: "supervisor-composition.spec.json",
						sha256: specSha256,
					},
				],
			},
			helpers: [],
			models: runtimeArtifacts.models!,
			profile: runtimeArtifacts.profile!,
		},
		repositories: [{ id: "worktree-a", root: worktree }],
		authorityPolicy: runtimeArtifacts.authority!,
		materialization: {
			runtimeRoot: scratch,
			workflowStateRoot: state.workflowStateRoot,
			writableRoots,
			deniedReadRoots: [],
			materializationDigest,
			agentToolkitDigest,
			agentToolkitName: "@vegardx/agent-toolkit",
			agentToolkitVersion,
			agentToolkitSourceRevision,
		},
	};
	return {
		runRoot,
		worktree,
		workflowState: state.workflowStateRoot,
		specPath,
		specSha256,
		probeLog,
		executionManifest,
		executionManifestDigest: digestWorkflowExecutionManifest(executionManifest),
		runtime: {
			runtimeRoot: scratch,
			homeDir: home,
			tmpDir: temporary,
			agentDir: agent,
			sessionDir: sessions,
			workflowAuthFile: auth,
			gitConfigFile: gitConfig,
			materializationDigest,
			agentToolkitDigest,
			agentToolkitVersion,
			agentToolkitSourceRevision,
			scratchRoots: [home, temporary, sessions, auth],
			environment: {
				HOME: home,
				TMPDIR: temporary,
				PI_CODING_AGENT_DIR: agent,
				PI_CODING_AGENT_SESSION_DIR: sessions,
				PI_WORKFLOW_AUTH_FILE: auth,
				GIT_CONFIG_GLOBAL: gitConfig,
				PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
				SUPERVISOR_COMPOSITION_LOG: probeLog,
				SUPERVISOR_REPLACEMENT_MARKER: "replacement-environment",
				...WORKFLOW_CREDENTIAL_RESET_ENV,
			},
		},
	};
}

async function digestFile(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

describe("workflow supervisor real-process composition", () => {
	test("starts a flat pi-workflow through pi-subagent in the replacement environment and continues without relaunching", async () => {
		const layout = await makeLayout();
		process.env.SUPERVISOR_HOST_ONLY_SECRET = "must-not-cross-process-seam";
		const launcher = new WorkflowSupervisorLauncher({
			materialize: () => layout.runtime,
			// Sandbox command construction and host enforcement have their own tests.
			// Keeping this wrapper as identity isolates this probe to the real process,
			// package, environment, and durable-state composition seam.
			wrap: async (command) => command,
		});
		const commonRequest = {
			version: 1 as const,
			runId: "supervisor_composition_probe",
			cwd: layout.runRoot,
			specPath: layout.specPath,
			specSha256: layout.specSha256,
			task: "Prove the production package composition seam.",
			waitTimeoutMs: 20_000,
		};
		const sandboxRoots = {
			coordinatedRunRoot: layout.runRoot,
			workflowStateRoot: layout.workflowState,
			coordinatedWorktreeRoots: [layout.worktree],
			worktreeAccess: "write" as const,
		};

		const started = await launcher.launch({
			workflowRequest: { ...commonRequest, action: "start" },
			executionManifest: layout.executionManifest,
			executionManifestDigest: layout.executionManifestDigest,
			materializerOptions: undefined,
			sandboxRoots,
		});
		const startExit = await started.completion;
		expect(startExit, await readFile(started.stdoutPath, "utf8")).toMatchObject(
			{ code: 0, signal: null, stderr: "" },
		);

		const stateText = await readFile(
			join(layout.workflowState, "workflows", commonRequest.runId, "run.json"),
			"utf8",
		);
		const stateRecord = JSON.parse(stateText) as {
			status: string;
			tasks: Array<{ stageId: string; status: string }>;
		};
		expect(stateRecord.status).toBe("completed");
		expect(stateRecord.tasks).toEqual([
			expect.objectContaining({ stageId: "only-task", status: "completed" }),
		]);
		const firstLaunches = (await readFile(layout.probeLog, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(firstLaunches).toHaveLength(1);
		expect(firstLaunches[0]).toMatchObject({
			cwd: layout.runRoot,
			home: layout.runtime.homeDir,
			replacementMarker: "replacement-environment",
			hostSecretPresent: false,
			workflowState: layout.workflowState,
		});
		const argv = firstLaunches[0]?.argv as string[];
		expect(argv).toEqual(
			expect.arrayContaining(["--mode", "json", "--exclude-tools", "subagent"]),
		);
		expect(argv).not.toContain("--no-skills");
		expect(argv.at(-1)).toContain("SUPERVISOR_COMPOSITION_PROBE");

		const continued = await launcher.launch({
			workflowRequest: { ...commonRequest, action: "continue" },
			executionManifest: layout.executionManifest,
			executionManifestDigest: layout.executionManifestDigest,
			materializerOptions: undefined,
			sandboxRoots,
		});
		const continueExit = await continued.completion;
		expect(continueExit).toMatchObject({ code: 0, signal: null, stderr: "" });
		expect(
			(await readFile(layout.probeLog, "utf8")).trim().split("\n"),
		).toHaveLength(1);
	});
});
