// Dedicated process seam for the package-external workflow supervisor.
// The supervisor starts from a materialized scratch runtime, a replacement
// environment, and one outer sandbox inherited by every descendant.

import {
	type ChildProcess,
	spawn as nodeSpawn,
	type SpawnOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
	chmod,
	type FileHandle,
	link,
	mkdir,
	open,
	readFile,
	unlink,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildWorkflowChildEnvironment,
	workflowChildEnvironmentPolicy,
} from "./child-environment.js";
import {
	validateWorkflowSupervisorRequest,
	type WorkflowSupervisorRequest,
} from "./supervisor-entry.js";
import {
	isWorkflowPublicationEnvironmentKey,
	type MaterializeWorkflowSupervisorRuntimeOptions,
	materializeWorkflowSupervisorRuntime,
	WORKFLOW_CREDENTIAL_RESET_ENV,
} from "./supervisor-runtime.js";
import {
	type WorkflowSupervisorSandboxRoots,
	workflowSupervisorWriteProfile,
	wrapWorkflowSupervisorCommand,
} from "./supervisor-sandbox.js";

export interface WorkflowSupervisorRuntimeMaterializationLike {
	readonly homeDir: string;
	readonly tmpDir: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	readonly workflowAuthFile: string;
	readonly gitConfigFile: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly scratchRoots: readonly string[];
}

export type MaterializeWorkflowSupervisorRuntime<Options> = (
	options: Options,
) =>
	| Promise<WorkflowSupervisorRuntimeMaterializationLike>
	| WorkflowSupervisorRuntimeMaterializationLike;

export type SpawnWorkflowSupervisorProcess = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

export type WrapWorkflowSupervisor = (
	command: string,
	roots: WorkflowSupervisorSandboxRoots,
	signal?: AbortSignal,
) => Promise<string>;

export type PersistWorkflowSupervisorRequest = (
	request: WorkflowSupervisorRequest,
	workflowStateRoot: string,
) => Promise<string>;

export interface WorkflowSupervisorLogs {
	readonly stdoutPath: string;
	readonly stderrPath: string;
	readonly stdoutFd: number;
	readonly stderrFd: number;
	readonly closeParent: () => Promise<void>;
	readonly readStderr: () => Promise<string>;
}

export type PrepareWorkflowSupervisorLogs = (
	request: WorkflowSupervisorRequest,
	workflowStateRoot: string,
) => Promise<WorkflowSupervisorLogs>;

export interface WorkflowSupervisorLauncherOptions<MaterializerOptions> {
	readonly materialize: MaterializeWorkflowSupervisorRuntime<MaterializerOptions>;
	readonly spawn?: SpawnWorkflowSupervisorProcess;
	readonly wrap?: WrapWorkflowSupervisor;
	readonly persistRequest?: PersistWorkflowSupervisorRequest;
	readonly prepareLogs?: PrepareWorkflowSupervisorLogs;
	/** Shell used only to execute the trusted sandbox wrapper command. */
	readonly shellCommand?: readonly [string, ...string[]];
	readonly executablePath?: string;
	readonly supervisorEntryPath?: string;
}

export interface LaunchWorkflowSupervisorRequest<MaterializerOptions> {
	readonly workflowRequest: WorkflowSupervisorRequest;
	readonly materializerOptions: MaterializerOptions;
	readonly sandboxRoots: Omit<WorkflowSupervisorSandboxRoots, "scratchRoots">;
	readonly signal?: AbortSignal;
}

export interface WorkflowSupervisorExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly error?: Error;
	readonly stderr: string;
}

export interface WorkflowSupervisorHandle {
	readonly pid: number | undefined;
	readonly stdoutPath: string;
	readonly stderrPath: string;
	readonly completion: Promise<WorkflowSupervisorExit>;
}

const STDERR_CAP_BYTES = 64 * 1024;

export class WorkflowSupervisorLauncher<MaterializerOptions> {
	readonly #materialize: MaterializeWorkflowSupervisorRuntime<MaterializerOptions>;
	readonly #spawn: SpawnWorkflowSupervisorProcess;
	readonly #wrap: WrapWorkflowSupervisor;
	readonly #persistRequest: PersistWorkflowSupervisorRequest;
	readonly #prepareLogs: PrepareWorkflowSupervisorLogs;
	readonly #shellCommand: readonly [string, ...string[]];
	readonly #executablePath: string;
	readonly #supervisorEntryPath: string;

	constructor(options: WorkflowSupervisorLauncherOptions<MaterializerOptions>) {
		this.#materialize = options.materialize;
		this.#spawn = options.spawn ?? nodeSpawn;
		this.#wrap = options.wrap ?? wrapWorkflowSupervisorCommand;
		this.#persistRequest =
			options.persistRequest ?? persistWorkflowSupervisorRequest;
		this.#prepareLogs = options.prepareLogs ?? prepareWorkflowSupervisorLogs;
		this.#shellCommand = options.shellCommand ?? ["/bin/bash", "-c"];
		this.#executablePath = options.executablePath ?? process.execPath;
		this.#supervisorEntryPath =
			options.supervisorEntryPath ?? defaultWorkflowSupervisorEntryPath();
	}

	async launch(
		request: LaunchWorkflowSupervisorRequest<MaterializerOptions>,
	): Promise<WorkflowSupervisorHandle> {
		if (request.signal?.aborted)
			throw new Error("workflow supervisor launch was already aborted");
		validateWorkflowSupervisorRequest(request.workflowRequest);
		validateLaunchContainment(request.workflowRequest, request.sandboxRoots);

		// Materialization happens before wrapping/spawn. A partial or invalid runtime
		// therefore cannot fall through to an unconfined child.
		const runtime = await this.#materialize(request.materializerOptions);
		validateMaterializedEnvironment(runtime);
		const sandboxRoots = {
			...request.sandboxRoots,
			scratchRoots: runtime.scratchRoots,
		};
		// Validate the write boundary before persisting anything. The wrapper repeats
		// this check while constructing the actual sandbox command.
		workflowSupervisorWriteProfile(sandboxRoots);
		const requestPath = await this.#persistRequest(
			request.workflowRequest,
			request.sandboxRoots.workflowStateRoot,
		);
		// The materializer has already selected the profile's provider variables.
		// Re-filter its result only to enforce the child-process denylist; do not
		// consult or merge the ambient process environment here.
		const environment = buildWorkflowChildEnvironment(
			runtime.environment,
			workflowChildEnvironmentPolicy(Object.keys(runtime.environment)),
		);
		assertNoPublicationEnvironment(Object.keys(environment));

		const command = workflowSupervisorEntryCommand(
			this.#executablePath,
			this.#supervisorEntryPath,
			requestPath,
		);
		const wrapped = await this.#wrap(command, sandboxRoots, request.signal);
		if (!wrapped.trim())
			throw new Error("workflow supervisor sandbox returned no command");
		const logs = await this.#prepareLogs(
			request.workflowRequest,
			request.sandboxRoots.workflowStateRoot,
		);

		const [shell, ...prefix] = this.#shellCommand;
		let child: ChildProcess;
		try {
			child = this.#spawn(shell, [...prefix, wrapped], {
				cwd: request.workflowRequest.cwd,
				detached: true,
				env: environment,
				stdio: ["ignore", logs.stdoutFd, logs.stderrFd],
				signal: request.signal,
			});
		} catch (error) {
			await logs.closeParent();
			return {
				pid: undefined,
				stdoutPath: logs.stdoutPath,
				stderrPath: logs.stderrPath,
				completion: Promise.resolve({
					code: null,
					signal: null,
					error: asError(error),
					stderr: "",
				}),
			};
		}
		// Subscribe before the first await after spawn. A fast failure can emit both
		// `error` and `close` while the parent log descriptors are being closed.
		const childCompletion = captureCompletion(child, logs.readStderr);
		const closeError = await logs.closeParent().then(
			() => undefined,
			(error: unknown) => asError(error),
		);
		child.unref();

		return {
			pid: child.pid,
			stdoutPath: logs.stdoutPath,
			stderrPath: logs.stderrPath,
			completion: closeError
				? childCompletion.then((result) => ({
						...result,
						error: result.error ?? closeError,
					}))
				: childCompletion,
		};
	}
}

export function defaultWorkflowSupervisorEntryPath(): string {
	return fileURLToPath(new URL("./supervisor-entry.ts", import.meta.url));
}

export async function persistWorkflowSupervisorRequest(
	request: WorkflowSupervisorRequest,
	workflowStateRoot: string,
): Promise<string> {
	validateWorkflowSupervisorRequest(request);
	if (!isAbsolute(workflowStateRoot))
		throw new Error("workflow state root must be absolute");
	const requestDirectory = join(
		resolve(workflowStateRoot),
		"supervisor-requests",
	);
	await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
	await chmod(requestDirectory, 0o700);
	const requestPath = join(
		requestDirectory,
		`${request.runId}-${request.action}.json`,
	);
	const serialized = `${stableJson(request)}\n`;
	if (request.action === "continue") {
		const startPath = join(requestDirectory, `${request.runId}-start.json`);
		let frozenStart: string;
		try {
			frozenStart = await readFile(startPath, "utf8");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT")
				throw new Error(
					`workflow supervisor continuation has no frozen start request for ${request.runId}`,
				);
			throw error;
		}
		const expectedStart = `${stableJson({ ...request, action: "start" })}\n`;
		if (frozenStart !== expectedStart)
			throw new Error(
				`workflow supervisor continuation conflicts with frozen start request for ${request.runId}`,
			);
	}
	const temporaryPath = join(
		requestDirectory,
		`.request-${process.pid}-${randomUUID()}.tmp`,
	);
	const temporary = await open(temporaryPath, "wx", 0o600);
	try {
		try {
			await temporary.writeFile(serialized, "utf8");
			await temporary.sync();
		} finally {
			await temporary.close();
		}
		try {
			await link(temporaryPath, requestPath);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
			const existing = await readFile(requestPath, "utf8");
			if (existing !== serialized)
				throw new Error(
					`conflicting workflow supervisor request already exists for ${request.runId}`,
				);
		}
	} finally {
		await unlink(temporaryPath).catch((error: unknown) => {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		});
	}
	return requestPath;
}

export async function prepareWorkflowSupervisorLogs(
	request: WorkflowSupervisorRequest,
	workflowStateRoot: string,
): Promise<WorkflowSupervisorLogs> {
	validateWorkflowSupervisorRequest(request);
	if (!isAbsolute(workflowStateRoot))
		throw new Error("workflow state root must be absolute");
	const logDirectory = join(resolve(workflowStateRoot), "supervisor-logs");
	await mkdir(logDirectory, { recursive: true, mode: 0o700 });
	await chmod(logDirectory, 0o700);
	const prefix = `${request.runId}-${request.action}`;
	const stdoutPath = join(logDirectory, `${prefix}.stdout.log`);
	const stderrPath = join(logDirectory, `${prefix}.stderr.log`);
	const stdout = await open(stdoutPath, "a", 0o600);
	let stderr: FileHandle;
	try {
		stderr = await open(stderrPath, "a", 0o600);
	} catch (error) {
		await stdout.close();
		throw error;
	}
	await Promise.all([chmod(stdoutPath, 0o600), chmod(stderrPath, 0o600)]);
	const stderrStart = (await stderr.stat()).size;
	return {
		stdoutPath,
		stderrPath,
		stdoutFd: stdout.fd,
		stderrFd: stderr.fd,
		closeParent: async () => {
			const results = await Promise.allSettled([
				stdout.close(),
				stderr.close(),
			]);
			const failure = results.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			if (failure) throw failure.reason;
		},
		readStderr: () => readFileTail(stderrPath, stderrStart),
	};
}

export function workflowSupervisorEntryCommand(
	executablePath: string,
	entryPath: string,
	requestPath: string,
): string {
	return [executablePath, entryPath, requestPath]
		.map(shellQuoteWorkflowArgument)
		.join(" ");
}

function shellQuoteWorkflowArgument(value: string): string {
	if (!value || value.includes("\0"))
		throw new Error("invalid workflow supervisor command path");
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateLaunchContainment(
	request: WorkflowSupervisorRequest,
	roots: Omit<WorkflowSupervisorSandboxRoots, "scratchRoots">,
): void {
	const runRoot = canonicalPath(roots.coordinatedRunRoot);
	if (
		resolve(request.cwd) !== runRoot ||
		canonicalPath(request.cwd) !== runRoot
	)
		throw new Error("workflow request cwd must equal the coordinated run root");
	const runtimeRoot = canonicalPath(resolve(runRoot, "runtime"));
	const specification = canonicalPath(request.specPath);
	const rel = relative(runtimeRoot, specification);
	if (!rel || rel.startsWith("..") || isAbsolute(rel))
		throw new Error(
			"workflow request spec must be a strict child of the coordinated runtime root",
		);
}

/** Resolve symlinks through the nearest existing ancestor, including new paths. */
function canonicalPath(input: string): string {
	let cursor = resolve(input);
	const missing: string[] = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		missing.unshift(basename(cursor));
		cursor = parent;
	}
	return resolve(realpathSync(cursor), ...missing);
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		if (serialized === undefined)
			throw new Error("workflow supervisor request is not serializable");
		return serialized;
	}
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Readonly<Record<string, unknown>>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

async function readFileTail(path: string, startingAt: number): Promise<string> {
	const file = await open(path, "r");
	try {
		const size = (await file.stat()).size;
		const start = Math.max(startingAt, size - STDERR_CAP_BYTES);
		const length = Math.max(0, size - start);
		const output = Buffer.alloc(length);
		if (length > 0) await file.read(output, 0, length, start);
		return output.toString("utf8");
	} finally {
		await file.close();
	}
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value;
}

/** Production composition; tests can instantiate the generic class directly. */
export function createWorkflowSupervisorLauncher(
	options: Omit<
		WorkflowSupervisorLauncherOptions<MaterializeWorkflowSupervisorRuntimeOptions>,
		"materialize"
	> = {},
): WorkflowSupervisorLauncher<MaterializeWorkflowSupervisorRuntimeOptions> {
	return new WorkflowSupervisorLauncher({
		...options,
		materialize: materializeWorkflowSupervisorRuntime,
	});
}

function validateMaterializedEnvironment(
	runtime: WorkflowSupervisorRuntimeMaterializationLike,
): void {
	if (runtime.scratchRoots.length === 0)
		throw new Error("workflow supervisor runtime has no scratch root");
	const required: ReadonlyArray<readonly [string, string]> = [
		["HOME", runtime.homeDir],
		["TMPDIR", runtime.tmpDir],
		["PI_CODING_AGENT_DIR", runtime.agentDir],
		["PI_CODING_AGENT_SESSION_DIR", runtime.sessionDir],
		["PI_WORKFLOW_AUTH_FILE", runtime.workflowAuthFile],
		["GIT_CONFIG_GLOBAL", runtime.gitConfigFile],
	];
	for (const [key, expected] of required) {
		if (!expected || runtime.environment[key] !== expected)
			throw new Error(`workflow supervisor runtime has invalid ${key}`);
	}
	assertCredentialResetEnvironment(runtime.environment);
	assertNoPublicationEnvironment(Object.keys(runtime.environment));
}

function assertCredentialResetEnvironment(
	environment: Readonly<Record<string, string>>,
): void {
	for (const [key, expected] of Object.entries(WORKFLOW_CREDENTIAL_RESET_ENV)) {
		if (environment[key] !== expected)
			throw new Error(`workflow supervisor runtime has invalid ${key}`);
	}
	const trustedKeys = new Set(Object.keys(WORKFLOW_CREDENTIAL_RESET_ENV));
	const unexpected = Object.keys(environment).find(
		(key) =>
			(key === "GIT_CONFIG_COUNT" ||
				key.startsWith("GIT_CONFIG_KEY_") ||
				key.startsWith("GIT_CONFIG_VALUE_")) &&
			!trustedKeys.has(key),
	);
	if (unexpected)
		throw new Error(
			`workflow supervisor runtime has untrusted Git configuration ${unexpected}`,
		);
}

function assertNoPublicationEnvironment(keys: readonly string[]): void {
	const forbidden = keys.find((key) =>
		isWorkflowPublicationEnvironmentKey(key),
	);
	if (forbidden)
		throw new Error(
			`workflow supervisor environment cannot contain publication credential ${forbidden}`,
		);
}

function captureCompletion(
	child: ChildProcess,
	readStderr: () => Promise<string>,
): Promise<WorkflowSupervisorExit> {
	let processError: Error | undefined;
	child.once("error", (error) => {
		processError = asError(error);
	});
	return new Promise((resolve) => {
		child.once("close", (code, signal) => {
			readStderr().then(
				(stderr) =>
					resolve({
						code,
						signal: signal as NodeJS.Signals | null,
						...(processError ? { error: processError } : {}),
						stderr,
					}),
				(error: unknown) =>
					resolve({
						code,
						signal: signal as NodeJS.Signals | null,
						error: processError ?? asError(error),
						stderr: "",
					}),
			);
		});
	});
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
