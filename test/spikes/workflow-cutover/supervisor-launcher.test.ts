import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, writeSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	digestWorkflowExecutionManifest,
	type WorkflowExecutionManifest,
} from "../../../packages/maestro/src/workflow/supervisor-execution-manifest.js";
import {
	defaultWorkflowSupervisorEntryPath,
	persistWorkflowSupervisorRequest,
	prepareWorkflowSupervisorLogs,
	type WorkflowSupervisorHandle,
	WorkflowSupervisorLauncher,
	workflowSupervisorEntryCommand,
} from "../../../packages/maestro/src/workflow/supervisor-launcher.js";
import { WORKFLOW_CREDENTIAL_RESET_ENV } from "../../../packages/maestro/src/workflow/supervisor-runtime.js";

function runtime(over: Record<string, string> = {}) {
	const runtimeRoot = "/run/scratch/supervisor";
	const homeDir = "/run/scratch/supervisor/home";
	const tmpDir = "/run/scratch/supervisor/tmp";
	const agentDir = "/run/scratch/supervisor/agent";
	const sessionDir = "/run/scratch/supervisor/sessions";
	const workflowAuthFile = "/run/scratch/supervisor/auth.json";
	const gitConfigFile = "/run/scratch/supervisor/gitconfig";
	return {
		runtimeRoot,
		homeDir,
		tmpDir,
		agentDir,
		sessionDir,
		workflowAuthFile,
		gitConfigFile,
		agentToolkitDigest: "d".repeat(64),
		agentToolkitVersion: "1.2.3",
		agentToolkitSourceRevision: "e".repeat(40),
		materializationDigest: "c".repeat(64),
		scratchRoots: [homeDir, tmpDir, sessionDir, workflowAuthFile],
		environment: {
			PATH: "/runtime/bin",
			HOME: homeDir,
			TMPDIR: tmpDir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_CODING_AGENT_SESSION_DIR: sessionDir,
			PI_WORKFLOW_AUTH_FILE: workflowAuthFile,
			GIT_CONFIG_GLOBAL: gitConfigFile,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			...WORKFLOW_CREDENTIAL_RESET_ENV,
			ANTHROPIC_API_KEY: "provider-secret",
			PI_MAESTRO_TOKEN: "stale-maestro-token",
			...over,
		},
	};
}

function fakeChild(pid = 4242): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.defineProperties(child, {
		pid: { value: pid, enumerable: true },
		unref: { value: vi.fn(() => child), enumerable: true },
	});
	return child;
}

function preparedLogs(stderr = "") {
	return {
		stdoutPath: "/run/runtime/.pi/supervisor-logs/run-1-start.stdout.log",
		stderrPath: "/run/runtime/.pi/supervisor-logs/run-1-start.stderr.log",
		stdoutFd: 41,
		stderrFd: 42,
		closeParent: vi.fn(async () => undefined),
		readStderr: vi.fn(async () => stderr),
	};
}

const roots = {
	coordinatedRunRoot: "/run",
	workflowStateRoot: "/run/runtime/.pi",
	coordinatedWorktreeRoots: ["/run/repos/api"],
	worktreeAccess: "write",
} as const;

function workflowRequest(over: Record<string, unknown> = {}) {
	return {
		version: 1 as const,
		action: "start" as const,
		runId: "run-1",
		cwd: "/run",
		specPath: "/run/runtime/workflow-bundle/workflow.json",
		specSha256: "a".repeat(64),
		executionManifestPath: "/run/runtime/.pi/execution-manifests/run-1.json",
		executionManifestSha256: "b".repeat(64),
		task: "Implement the approved plan",
		waitTimeoutMs: 60_000,
		...over,
	};
}

function executionManifest(
	launch: WorkflowExecutionManifest["launch"] = {
		task: "Implement the approved plan",
		executionProfile: null,
		inputOverrides: {},
	},
	deniedReadRoots: readonly string[] = [],
	worktreeAccess: "read" | "write" = "write",
): WorkflowExecutionManifest {
	const artifact = (name: string) => ({
		path: `/run/runtime/${name}`,
		sha256: "a".repeat(64),
	});
	return {
		version: 1,
		runId: "run-1",
		launch,
		artifacts: {
			spec: {
				path: "/run/runtime/workflow-bundle/workflow.json",
				sha256: "a".repeat(64),
			},
			bundle: {
				root: "/run/runtime/workflow-bundle",
				files: [{ path: "workflow.json", sha256: "a".repeat(64) }],
			},
			helpers: [],
			models: artifact("models.json"),
			profile: artifact("profile.json"),
		},
		repositories: [{ id: "api", root: "/run/repos/api" }],
		authorityPolicy: artifact("authority.json"),
		materialization: {
			runtimeRoot: "/run/scratch/supervisor",
			workflowStateRoot: "/run/runtime/.pi",
			writableRoots: [
				...(worktreeAccess === "write" ? ["/run/repos/api"] : []),
				"/run/runtime/.pi",
				"/run/scratch/supervisor/auth.json",
				"/run/scratch/supervisor/home",
				"/run/scratch/supervisor/sessions",
				"/run/scratch/supervisor/tmp",
			].sort(),
			deniedReadRoots,
			materializationDigest: "c".repeat(64),
			agentToolkitDigest: "d".repeat(64),
			agentToolkitName: "@vegardx/agent-toolkit",
			agentToolkitVersion: "1.2.3",
			agentToolkitSourceRevision: "e".repeat(40),
		},
	};
}

function approvedExecution(
	deniedReadRoots: readonly string[] = [],
	worktreeAccess: "read" | "write" = "write",
) {
	const manifest = executionManifest(
		undefined,
		deniedReadRoots,
		worktreeAccess,
	);
	return {
		executionManifest: manifest,
		executionManifestDigest: digestWorkflowExecutionManifest(manifest),
	};
}

const persistApprovedManifest = async (manifest: WorkflowExecutionManifest) =>
	`/run/runtime/.pi/execution-manifests/${manifest.runId}.json`;
const verifyApprovedManifest = async () => undefined;

describe("workflow supervisor launcher", () => {
	it.each([
		["task", { task: "changed task" }],
		["profile", { executionProfile: "changed-profile" }],
		["inputs", { inputOverrides: { changed: true } }],
	])("rejects changed approved %s before spawn", async (_label, change) => {
		const spawn = vi.fn(() => fakeChild());
		const launcher = new WorkflowSupervisorLauncher({
			verifyExecutionManifest: verifyApprovedManifest,
			persistExecutionManifest: persistApprovedManifest,
			materialize: async () => runtime(),
			spawn,
		});
		const manifest = executionManifest();
		await expect(
			launcher.launch({
				workflowRequest: workflowRequest(change),
				executionManifest: manifest,
				executionManifestDigest: digestWorkflowExecutionManifest(manifest),
				materializerOptions: {},
				sandboxRoots: roots,
			}),
		).rejects.toThrow(/launch inputs mismatch/);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("materializes, wraps, and spawns with a replacement environment", async () => {
		const hostOnlyKey = "MAESTRO_LAUNCHER_TEST_HOST_ONLY";
		const previousHostOnly = process.env[hostOnlyKey];
		process.env[hostOnlyKey] = "must-not-leak";
		const materialize = vi.fn(async () => runtime());
		const persistRequest = vi.fn(
			async () => "/run/runtime/.pi/supervisor-requests/run-1-start.json",
		);
		const logs = preparedLogs("supervisor failed\n");
		const prepareLogs = vi.fn(async () => logs);
		const wrap = vi.fn(async (command: string) => `sandboxed:${command}`);
		const child = fakeChild();
		const spawnCalls: Array<{
			command: string;
			args: readonly string[];
			options: SpawnOptions;
		}> = [];
		const launcher = new WorkflowSupervisorLauncher({
			verifyExecutionManifest: verifyApprovedManifest,
			materialize,
			persistExecutionManifest: persistApprovedManifest,
			persistRequest,
			prepareLogs,
			wrap,
			executablePath: "/opt/node's/bin/node",
			runtimeLoaderPath: "/opt/jiti/register.mjs",
			supervisorEntryPath: "/opt/pi maestro/supervisor-entry.js",
			spawn: (command, args, options) => {
				spawnCalls.push({ command, args, options });
				return child;
			},
		});

		let handle: WorkflowSupervisorHandle;
		const deniedReadRoots = [] as const;
		const approved = approvedExecution(deniedReadRoots);
		try {
			handle = await launcher.launch({
				...approved,
				workflowRequest: workflowRequest(),
				materializerOptions: { runId: "run-1" },
				sandboxRoots: { ...roots, deniedReadRoots },
			});
		} finally {
			if (previousHostOnly === undefined) delete process.env[hostOnlyKey];
			else process.env[hostOnlyKey] = previousHostOnly;
		}

		expect(handle.pid).toBe(4242);
		expect(handle.stdoutPath).toBe(logs.stdoutPath);
		expect(handle.stderrPath).toBe(logs.stderrPath);
		expect(materialize).toHaveBeenCalledWith({ runId: "run-1" });
		expect(persistRequest).toHaveBeenCalledWith(
			workflowRequest({
				executionManifestSha256: approved.executionManifestDigest,
			}),
			"/run/runtime/.pi",
		);
		const expectedCommand =
			`'/opt/node'"'"'s/bin/node' '--import' '/opt/jiti/register.mjs' ` +
			`'/opt/pi maestro/supervisor-entry.js' ` +
			`'/run/runtime/.pi/supervisor-requests/run-1-start.json'`;
		expect(wrap).toHaveBeenCalledWith(
			expectedCommand,
			{
				...roots,
				deniedReadRoots,
				scratchRoots: runtime().scratchRoots,
			},
			undefined,
		);
		expect(spawnCalls[0]).toMatchObject({
			command: "/bin/bash",
			args: ["-c", `sandboxed:${expectedCommand}`],
			options: {
				cwd: "/run",
				detached: true,
				stdio: ["ignore", 41, 42],
			},
		});
		const environment = spawnCalls[0]?.options.env as Record<string, string>;
		expect(environment).toMatchObject({
			HOME: "/run/scratch/supervisor/home",
			PI_CODING_AGENT_DIR: "/run/scratch/supervisor/agent",
			PI_WORKFLOW_AUTH_FILE: "/run/scratch/supervisor/auth.json",
			GIT_CONFIG_GLOBAL: "/run/scratch/supervisor/gitconfig",
			ANTHROPIC_API_KEY: "provider-secret",
			PI_MAESTRO_WORKFLOW_DENIED_READ_ROOTS: JSON.stringify(deniedReadRoots),
		});
		expect(environment[hostOnlyKey]).toBeUndefined();
		expect(environment.PI_MAESTRO_TOKEN).toBeUndefined();
		expect(environment).not.toBe(process.env);
		expect(logs.closeParent).toHaveBeenCalledOnce();
		expect(child.unref).toHaveBeenCalledOnce();

		child.emit("close", 7, null);
		expect(await handle.completion).toEqual({
			code: 7,
			signal: null,
			stderr: "supervisor failed\n",
		});
	});

	it("fails closed before spawn when materialization or sandboxing fails", async () => {
		const spawn = vi.fn(() => fakeChild());
		const materializationFailure = new WorkflowSupervisorLauncher({
			verifyExecutionManifest: verifyApprovedManifest,
			persistExecutionManifest: persistApprovedManifest,
			materialize: async () => {
				throw new Error("runtime unavailable");
			},
			wrap: async () => "unused",
			persistRequest: async () => "unused",
			prepareLogs: async () => preparedLogs(),
			spawn,
		});
		await expect(
			materializationFailure.launch({
				...approvedExecution(),
				workflowRequest: workflowRequest(),
				materializerOptions: {},
				sandboxRoots: roots,
			}),
		).rejects.toThrow(/runtime unavailable/);

		const sandboxFailure = new WorkflowSupervisorLauncher({
			verifyExecutionManifest: verifyApprovedManifest,
			persistExecutionManifest: persistApprovedManifest,
			materialize: async () => runtime(),
			persistRequest: async () => "/run/runtime/.pi/request.json",
			prepareLogs: async () => preparedLogs(),
			wrap: async () => {
				throw new Error("sandbox unavailable");
			},
			spawn,
		});
		await expect(
			sandboxFailure.launch({
				...approvedExecution(),
				workflowRequest: workflowRequest(),
				materializerOptions: {},
				sandboxRoots: roots,
			}),
		).rejects.toThrow(/sandbox unavailable/);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("binds phase worktree access to the manifest writable roots", async () => {
		const child = fakeChild();
		const spawn = vi.fn(() => child);
		const launcher = new WorkflowSupervisorLauncher({
			verifyExecutionManifest: verifyApprovedManifest,
			persistExecutionManifest: persistApprovedManifest,
			materialize: async () => runtime(),
			persistRequest: async () => "/run/runtime/.pi/request.json",
			prepareLogs: async () => preparedLogs(),
			wrap: async (command) => command,
			spawn,
		});
		const reviewRoots = { ...roots, worktreeAccess: "read" as const };

		await expect(
			launcher.launch({
				...approvedExecution([], "write"),
				workflowRequest: workflowRequest(),
				materializerOptions: {},
				sandboxRoots: reviewRoots,
			}),
		).rejects.toThrow(/writable roots mismatch/);
		expect(spawn).not.toHaveBeenCalled();

		const handle = await launcher.launch({
			...approvedExecution([], "read"),
			workflowRequest: workflowRequest(),
			materializerOptions: {},
			sandboxRoots: reviewRoots,
		});
		expect(spawn).toHaveBeenCalledOnce();
		child.emit("close", 0, null);
		await expect(handle.completion).resolves.toMatchObject({ code: 0 });
	});

	it("rejects publication credentials emitted by a faulty materializer", async () => {
		const spawn = vi.fn(() => fakeChild());
		const launcher = new WorkflowSupervisorLauncher({
			verifyExecutionManifest: verifyApprovedManifest,
			persistExecutionManifest: persistApprovedManifest,
			materialize: async () => runtime({ GH_TOKEN: "must-not-leak" }),
			persistRequest: async () => "/run/runtime/.pi/request.json",
			prepareLogs: async () => preparedLogs(),
			wrap: async (command) => command,
			spawn,
		});
		await expect(
			launcher.launch({
				...approvedExecution(),
				workflowRequest: workflowRequest(),
				materializerOptions: {},
				sandboxRoots: roots,
			}),
		).rejects.toThrow(/publication credential GH_TOKEN/);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("captures synchronous and asynchronous process launch errors", async () => {
		const synchronous = new WorkflowSupervisorLauncher({
			verifyExecutionManifest: verifyApprovedManifest,
			persistExecutionManifest: persistApprovedManifest,
			materialize: async () => runtime(),
			persistRequest: async () => "/run/runtime/.pi/request.json",
			prepareLogs: async () => preparedLogs(),
			wrap: async (command) => command,
			spawn: () => {
				throw new Error("spawn threw");
			},
		});
		const syncHandle = await synchronous.launch({
			...approvedExecution(),
			workflowRequest: workflowRequest(),
			materializerOptions: {},
			sandboxRoots: roots,
		});
		expect(syncHandle.pid).toBeUndefined();
		expect((await syncHandle.completion).error?.message).toBe("spawn threw");

		const child = fakeChild(99);
		const asynchronous = new WorkflowSupervisorLauncher({
			verifyExecutionManifest: verifyApprovedManifest,
			persistExecutionManifest: persistApprovedManifest,
			materialize: async () => runtime(),
			persistRequest: async () => "/run/runtime/.pi/request.json",
			prepareLogs: async () => preparedLogs(),
			wrap: async (command) => command,
			spawn: () => child,
		});
		const asyncHandle = await asynchronous.launch({
			...approvedExecution(),
			workflowRequest: workflowRequest(),
			materializerOptions: {},
			sandboxRoots: roots,
		});
		child.emit("error", new Error("ENOENT"));
		child.emit("close", null, null);
		expect(asyncHandle.pid).toBe(99);
		expect((await asyncHandle.completion).error?.message).toBe("ENOENT");
	});

	it("subscribes to child completion before awaiting parent log closure", async () => {
		const child = fakeChild(101);
		const closeParent = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					child.emit("close", 9, null);
					setTimeout(resolve, 0);
				}),
		);
		const launcher = new WorkflowSupervisorLauncher({
			verifyExecutionManifest: verifyApprovedManifest,
			persistExecutionManifest: persistApprovedManifest,
			materialize: async () => runtime(),
			persistRequest: async () => "/run/runtime/.pi/request.json",
			prepareLogs: async () => ({
				stdoutPath: "/run/runtime/.pi/stdout.log",
				stderrPath: "/run/runtime/.pi/stderr.log",
				stdoutFd: 11,
				stderrFd: 12,
				closeParent,
				readStderr: async () => "fast failure\n",
			}),
			wrap: async (command) => command,
			spawn: () => child,
		});

		const handle = await launcher.launch({
			...approvedExecution(),
			workflowRequest: workflowRequest(),
			materializerOptions: {},
			sandboxRoots: roots,
		});
		expect(await handle.completion).toEqual({
			code: 9,
			signal: null,
			stderr: "fast failure\n",
		});
	});

	it("rejects requests outside the coordinated runtime before materializing", async () => {
		const materialize = vi.fn(async () => runtime());
		const launcher = new WorkflowSupervisorLauncher({
			verifyExecutionManifest: verifyApprovedManifest,
			persistExecutionManifest: persistApprovedManifest,
			materialize,
			persistRequest: async () => "unused",
			prepareLogs: async () => preparedLogs(),
			wrap: async (command) => command,
		});
		await expect(
			launcher.launch({
				...approvedExecution(),
				workflowRequest: workflowRequest({
					specPath: "/run/repos/api/spec.json",
				}),
				materializerOptions: {},
				sandboxRoots: roots,
			}),
		).rejects.toThrow(/strict child.*runtime root/);
		expect(materialize).not.toHaveBeenCalled();
	});

	it("rejects injected Git configuration outside the credential reset tuple", async () => {
		const spawn = vi.fn(() => fakeChild());
		const launcher = new WorkflowSupervisorLauncher({
			verifyExecutionManifest: verifyApprovedManifest,
			persistExecutionManifest: persistApprovedManifest,
			materialize: async () =>
				runtime({
					GIT_CONFIG_COUNT: "3",
					GIT_CONFIG_KEY_2: "credential.helper",
				}),
			persistRequest: async () => "/run/runtime/.pi/request.json",
			prepareLogs: async () => preparedLogs(),
			wrap: async (command) => command,
			spawn,
		});
		await expect(
			launcher.launch({
				...approvedExecution(),
				workflowRequest: workflowRequest(),
				materializerOptions: {},
				sandboxRoots: roots,
			}),
		).rejects.toThrow(/invalid GIT_CONFIG_COUNT|untrusted Git configuration/);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("persists one canonical mode-0600 request and rejects conflicting resume data", async () => {
		const fixture = await mkdtemp(
			join(tmpdir(), "maestro-supervisor-request-"),
		);
		try {
			const stateRoot = join(fixture, "runtime", ".pi");
			const request = workflowRequest({
				cwd: fixture,
				specPath: join(fixture, "runtime", "workflow.json"),
				inputOverrides: { z: 1, a: { second: true, first: false } },
			});
			const path = await persistWorkflowSupervisorRequest(request, stateRoot);
			expect(await persistWorkflowSupervisorRequest(request, stateRoot)).toBe(
				path,
			);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect(await readFile(path, "utf8")).toContain(
				'"inputOverrides":{"a":{"first":false,"second":true},"z":1}',
			);
			await expect(
				persistWorkflowSupervisorRequest(
					{ ...request, task: "A conflicting task" },
					stateRoot,
				),
			).rejects.toThrow(/conflicting workflow supervisor request/);
			const continuation = { ...request, action: "continue" as const };
			expect(
				await persistWorkflowSupervisorRequest(continuation, stateRoot),
			).toMatch(/run-1-continue\.json$/);
			await expect(
				persistWorkflowSupervisorRequest(
					{ ...continuation, task: "Changed after approval" },
					stateRoot,
				),
			).rejects.toThrow(/conflicts with frozen start request/);
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	it("quotes every supervisor entry argument for the POSIX shell", () => {
		expect(
			workflowSupervisorEntryCommand(
				"/node path/node",
				"/entry's/index.js",
				"/runtime/request; touch escaped",
				"/loader's/register.mjs",
			),
		).toBe(
			`'/node path/node' '--import' '/loader'"'"'s/register.mjs' ` +
				`'/entry'"'"'s/index.js' '/runtime/request; touch escaped'`,
		);
	});

	it("uses the shipped TypeScript supervisor entry and durable mode-0600 logs", async () => {
		expect(defaultWorkflowSupervisorEntryPath()).toMatch(
			/supervisor-entry\.ts$/,
		);
		expect(existsSync(defaultWorkflowSupervisorEntryPath())).toBe(true);
		const fixture = await mkdtemp(join(tmpdir(), "maestro-supervisor-logs-"));
		try {
			const logs = await prepareWorkflowSupervisorLogs(
				workflowRequest({ cwd: fixture }),
				join(fixture, "runtime", ".pi"),
			);
			writeSync(logs.stdoutFd, '{"status":"completed"}\n');
			writeSync(logs.stderrFd, "durable error\n");
			await logs.closeParent();
			expect((await stat(logs.stdoutPath)).mode & 0o777).toBe(0o600);
			expect((await stat(logs.stderrPath)).mode & 0o777).toBe(0o600);
			expect(await readFile(logs.stdoutPath, "utf8")).toContain("completed");
			expect(await logs.readStderr()).toBe("durable error\n");
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	it("passes the replacement environment through a real supervisor and grandchild", async () => {
		const temporary = await mkdtemp(
			join(tmpdir(), "maestro-supervisor-process-"),
		);
		const fixture = await realpath(temporary);
		const runtimeRoot = join(fixture, "scratch", "supervisor");
		const worktree = join(fixture, "repos", "api");
		const workflowState = join(fixture, "runtime", ".pi");
		const bundleRoot = join(fixture, "runtime", "workflow-bundle");
		const specPath = join(bundleRoot, "workflow.json");
		const entryPath = join(fixture, "runtime", "environment-entry.mjs");
		const homeDir = join(runtimeRoot, "home");
		const tmpDir = join(runtimeRoot, "tmp");
		const agentDir = join(runtimeRoot, "agent");
		const sessionDir = join(runtimeRoot, "sessions");
		const workflowAuthFile = join(agentDir, "auth.json");
		const gitConfigFile = join(homeDir, ".gitconfig");
		const hostOnlyKey = "MAESTRO_REAL_PROCESS_HOST_ONLY";
		const previousHostOnly = process.env[hostOnlyKey];
		process.env[hostOnlyKey] = "must-not-cross";
		try {
			await Promise.all(
				[
					worktree,
					bundleRoot,
					workflowState,
					homeDir,
					tmpDir,
					agentDir,
					sessionDir,
				].map((path) => mkdir(path, { recursive: true })),
			);
			await Promise.all([
				writeFile(specPath, "{}\n"),
				writeFile(workflowAuthFile, "{}\n"),
				writeFile(gitConfigFile, "[credential]\n\thelper =\n"),
				writeFile(
					entryPath,
					`import { spawnSync } from "node:child_process";
const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { encoding: "utf8", env: process.env });
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
process.exitCode = child.status ?? 1;
`,
				),
			]);
			const launcher = new WorkflowSupervisorLauncher({
				verifyExecutionManifest: verifyApprovedManifest,
				persistExecutionManifest: async (manifest) =>
					join(
						fixture,
						"runtime",
						".pi",
						"execution-manifests",
						`${manifest.runId}.json`,
					),
				materialize: async () => ({
					runtimeRoot,
					homeDir,
					tmpDir,
					agentDir,
					sessionDir,
					workflowAuthFile,
					gitConfigFile,
					materializationDigest: "c".repeat(64),
					agentToolkitDigest: "d".repeat(64),
					agentToolkitVersion: "1.2.3",
					agentToolkitSourceRevision: "e".repeat(40),
					scratchRoots: [homeDir, tmpDir, sessionDir, workflowAuthFile],
					environment: {
						PATH: process.env.PATH ?? "/usr/bin:/bin",
						HOME: homeDir,
						TMPDIR: tmpDir,
						PI_CODING_AGENT_DIR: agentDir,
						PI_CODING_AGENT_SESSION_DIR: sessionDir,
						PI_WORKFLOW_AUTH_FILE: workflowAuthFile,
						GIT_CONFIG_GLOBAL: gitConfigFile,
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_TERMINAL_PROMPT: "0",
						...WORKFLOW_CREDENTIAL_RESET_ENV,
						PI_MAESTRO_TOKEN: "stale-token",
					},
				}),
				wrap: async (command) => command,
				supervisorEntryPath: entryPath,
			});
			const request = workflowRequest({
				cwd: fixture,
				specPath,
				specSha256: createHash("sha256").update("{}\n").digest("hex"),
			});
			const baseManifest = executionManifest();
			const manifest: WorkflowExecutionManifest = {
				...baseManifest,
				artifacts: {
					...baseManifest.artifacts,
					spec: { path: specPath, sha256: request.specSha256 },
					bundle: {
						root: bundleRoot,
						files: [{ path: "workflow.json", sha256: request.specSha256 }],
					},
				},
				repositories: [{ id: "api", root: worktree }],
				materialization: {
					runtimeRoot,
					workflowStateRoot: workflowState,
					writableRoots: [
						homeDir,
						tmpDir,
						sessionDir,
						workflowAuthFile,
						workflowState,
						worktree,
					].sort(),
					deniedReadRoots: [],
					materializationDigest: "c".repeat(64),
					agentToolkitDigest: "d".repeat(64),
					agentToolkitName: "@vegardx/agent-toolkit",
					agentToolkitVersion: "1.2.3",
					agentToolkitSourceRevision: "e".repeat(40),
				},
			};
			const handle = await launcher.launch({
				executionManifest: manifest,
				executionManifestDigest: digestWorkflowExecutionManifest(manifest),
				workflowRequest: request,
				materializerOptions: {},
				sandboxRoots: {
					coordinatedRunRoot: fixture,
					workflowStateRoot: workflowState,
					coordinatedWorktreeRoots: [worktree],
					worktreeAccess: "write",
				},
			});
			expect(await handle.completion).toMatchObject({ code: 0, stderr: "" });
			const inherited = JSON.parse(
				await readFile(handle.stdoutPath, "utf8"),
			) as Record<string, string>;
			expect(inherited.HOME).toBe(homeDir);
			expect(inherited.PI_CODING_AGENT_DIR).toBe(agentDir);
			expect(inherited.GIT_ALLOW_PROTOCOL).toBe("");
			expect(inherited.PI_MAESTRO_TOKEN).toBeUndefined();
			expect(inherited[hostOnlyKey]).toBeUndefined();
		} finally {
			if (previousHostOnly === undefined) delete process.env[hostOnlyKey];
			else process.env[hostOnlyKey] = previousHostOnly;
			await rm(fixture, { recursive: true, force: true });
		}
	});
});
