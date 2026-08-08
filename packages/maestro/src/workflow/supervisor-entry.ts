// The executable boundary inside the workflow supervisor sandbox.
//
// The seat chooses and validates the run id, spec, task, and execution profile,
// then writes this request beneath the coordinated runtime root. This process
// starts (or continues) the run only after the outer sandbox and replacement
// environment are active. Calling runWorkflowSpec in the seat would be too
// early: that API immediately schedules the first tasks.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	refreshRun,
	resumeRun,
	runWorkflowSpec,
	waitForRun,
} from "@agwab/pi-workflow";
import {
	readCanonicalWorkflowExecutionManifest,
	validateWorkflowExecutionManifestLaunch,
	verifyWorkflowExecutionManifest,
} from "./supervisor-execution-manifest.js";
import { verifyWorkflowSupervisorRuntimeSeal } from "./supervisor-runtime.js";

export interface WorkflowSupervisorRequest {
	readonly version: 1;
	readonly action: "start" | "continue";
	readonly runId: string;
	readonly cwd: string;
	readonly specPath: string;
	readonly specSha256: string;
	readonly executionManifestPath: string;
	readonly executionManifestSha256: string;
	readonly task: string;
	readonly executionProfile?: string;
	readonly inputOverrides?: Readonly<Record<string, unknown>>;
	readonly waitTimeoutMs: number;
}

export interface WorkflowSupervisorResult {
	readonly runId: string;
	readonly status: string;
}

export interface WorkflowSupervisorEntryOperations {
	readonly start: (
		specPath: string,
		cwd: string,
		options: {
			readonly runId: string;
			readonly task: string;
			readonly executionProfile?: string;
			readonly inputOverrides?: Readonly<Record<string, unknown>>;
		},
	) => Promise<{ readonly runId: string }>;
	readonly inspect: (
		cwd: string,
		runId: string,
	) => Promise<{ readonly runId: string; readonly status: string }>;
	readonly resume: (
		cwd: string,
		runId: string,
	) => Promise<{ readonly runId: string; readonly status: string }>;
	readonly wait: (
		cwd: string,
		runId: string,
		timeoutMs: number,
	) => Promise<{ readonly runId: string; readonly status: string }>;
	readonly verifySpec: (
		specPath: string,
		expectedSha256: string,
	) => Promise<void>;
	readonly verifyExecutionManifest: (
		request: WorkflowSupervisorRequest,
	) => Promise<void>;
}

const DEFAULT_OPERATIONS: WorkflowSupervisorEntryOperations = {
	start: (specPath, cwd, options) => runWorkflowSpec(specPath, cwd, options),
	inspect: (cwd, runId) => refreshRun(cwd, runId),
	resume: async (cwd, runId) => (await resumeRun(cwd, runId)).run,
	wait: (cwd, runId, timeoutMs) => waitForRun(cwd, runId, timeoutMs),
	verifySpec: verifyWorkflowSpecDigest,
	verifyExecutionManifest: verifyRequestExecutionManifest,
};

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const WORKFLOW_SUPERVISOR_REQUEST_KEYS = new Set([
	"version",
	"action",
	"runId",
	"cwd",
	"specPath",
	"specSha256",
	"executionManifestPath",
	"executionManifestSha256",
	"task",
	"executionProfile",
	"inputOverrides",
	"waitTimeoutMs",
]);

export async function executeWorkflowSupervisorRequest(
	request: WorkflowSupervisorRequest,
	operations: WorkflowSupervisorEntryOperations = DEFAULT_OPERATIONS,
): Promise<WorkflowSupervisorResult> {
	validateWorkflowSupervisorRequest(request);
	await operations.verifyExecutionManifest(request);
	await operations.verifySpec(request.specPath, request.specSha256);
	if (request.action === "start") {
		const started = await operations.start(request.specPath, request.cwd, {
			runId: request.runId,
			task: request.task,
			...(request.executionProfile
				? { executionProfile: request.executionProfile }
				: {}),
			...(request.inputOverrides
				? { inputOverrides: request.inputOverrides }
				: {}),
		});
		if (started.runId !== request.runId)
			throw new Error("workflow runtime returned an unexpected run ID");
	} else {
		let existing = await operations.inspect(request.cwd, request.runId);
		assertExpectedRunId(existing, request.runId, "continuation");
		if (existing.status === "completed")
			return { runId: existing.runId, status: existing.status };
		if (
			existing.status === "blocked" ||
			existing.status === "failed" ||
			existing.status === "interrupted"
		) {
			existing = await operations.resume(request.cwd, request.runId);
			assertExpectedRunId(existing, request.runId, "resume");
		}
	}

	const finished = await waitForTerminalWorkflow(request, operations);
	return { runId: finished.runId, status: finished.status };
}

async function waitForTerminalWorkflow(
	request: WorkflowSupervisorRequest,
	operations: WorkflowSupervisorEntryOperations,
): Promise<{ readonly runId: string; readonly status: string }> {
	for (;;) {
		try {
			const waited = await operations.wait(
				request.cwd,
				request.runId,
				request.waitTimeoutMs,
			);
			assertExpectedRunId(waited, request.runId, "wait");
			if (waited.status !== "running") return waited;
		} catch (error) {
			if (!isWorkflowWaitTimeout(error)) throw error;
			const refreshed = await operations.inspect(request.cwd, request.runId);
			assertExpectedRunId(refreshed, request.runId, "wait refresh");
			if (refreshed.status !== "running") return refreshed;
		}
	}
}

function assertExpectedRunId(
	value: { readonly runId: string },
	expected: string,
	operation: string,
): void {
	if (value.runId !== expected)
		throw new Error(`workflow ${operation} resolved an unexpected run ID`);
}

function isWorkflowWaitTimeout(error: unknown): boolean {
	return (
		error instanceof Error &&
		/^Flow run .+ still running(?: .+)? after \d+ms wait/.test(error.message)
	);
}

export async function runWorkflowSupervisorEntry(
	argv: readonly string[],
	operations: WorkflowSupervisorEntryOperations = DEFAULT_OPERATIONS,
): Promise<number> {
	if (argv.length !== 1)
		throw new Error("workflow supervisor requires exactly one request path");
	const requestPath = argv[0] as string;
	if (!isAbsolute(requestPath))
		throw new Error("workflow supervisor request path must be absolute");
	const request: unknown = JSON.parse(await readFile(requestPath, "utf8"));
	validateWorkflowSupervisorRequest(request);
	const result = await executeWorkflowSupervisorRequest(request, operations);
	process.stdout.write(`${JSON.stringify(result)}\n`);
	return result.status === "completed"
		? 0
		: result.status === "blocked"
			? 2
			: 1;
}

export function validateWorkflowSupervisorRequest(
	value: unknown,
): asserts value is WorkflowSupervisorRequest {
	if (
		!isRecord(value) ||
		Object.keys(value).some(
			(key) => !WORKFLOW_SUPERVISOR_REQUEST_KEYS.has(key),
		) ||
		value.version !== 1 ||
		(value.action !== "start" && value.action !== "continue") ||
		typeof value.runId !== "string" ||
		!RUN_ID_PATTERN.test(value.runId) ||
		typeof value.cwd !== "string" ||
		!isAbsolute(value.cwd) ||
		typeof value.specPath !== "string" ||
		!isAbsolute(value.specPath) ||
		typeof value.specSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.specSha256) ||
		typeof value.executionManifestPath !== "string" ||
		!isAbsolute(value.executionManifestPath) ||
		typeof value.executionManifestSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.executionManifestSha256) ||
		typeof value.task !== "string" ||
		!value.task.trim() ||
		(value.executionProfile !== undefined &&
			(typeof value.executionProfile !== "string" ||
				!value.executionProfile.trim())) ||
		(value.inputOverrides !== undefined &&
			(!isRecord(value.inputOverrides) ||
				!isJsonValue(value.inputOverrides))) ||
		typeof value.waitTimeoutMs !== "number" ||
		!Number.isSafeInteger(value.waitTimeoutMs) ||
		value.waitTimeoutMs < 1_000 ||
		value.waitTimeoutMs > 14_400_000
	)
		throw new Error("invalid workflow supervisor request");
}

export async function verifyRequestExecutionManifest(
	request: WorkflowSupervisorRequest,
	verifyRuntimeSeal: typeof verifyWorkflowSupervisorRuntimeSeal = verifyWorkflowSupervisorRuntimeSeal,
): Promise<void> {
	if (!request.executionManifestPath || !request.executionManifestSha256)
		throw new Error("workflow execution manifest binding is absent");
	const manifest = await readCanonicalWorkflowExecutionManifest(
		request.executionManifestPath,
		request.executionManifestSha256,
	);
	if (manifest.runId !== request.runId)
		throw new Error("workflow execution manifest run ID mismatch");
	if (
		manifest.artifacts.spec.path !== request.specPath ||
		manifest.artifacts.spec.sha256 !== request.specSha256
	)
		throw new Error("workflow execution manifest spec mismatch");
	validateWorkflowExecutionManifestLaunch(manifest, request);
	const runtimeRoot = process.env.PI_MAESTRO_WORKFLOW_RUNTIME_ROOT;
	const materializationDigest =
		process.env.PI_MAESTRO_WORKFLOW_MATERIALIZATION_DIGEST;
	const agentToolkitDigest = process.env.PI_MAESTRO_WORKFLOW_TOOLKIT_DIGEST;
	const agentToolkitVersion = process.env.PI_MAESTRO_WORKFLOW_TOOLKIT_VERSION;
	const agentToolkitSourceRevision =
		process.env.PI_MAESTRO_WORKFLOW_TOOLKIT_SOURCE_REVISION;
	const workflowStateRoot = process.env.PI_MAESTRO_WORKFLOW_STATE_ROOT;
	const writableRoots = parseAbsolutePathArray(
		process.env.PI_MAESTRO_WORKFLOW_WRITABLE_ROOTS,
	);
	const deniedReadRoots = parseAbsolutePathArray(
		process.env.PI_MAESTRO_WORKFLOW_DENIED_READ_ROOTS,
		true,
	);
	if (
		!runtimeRoot ||
		!materializationDigest ||
		!agentToolkitDigest ||
		!agentToolkitVersion ||
		!agentToolkitSourceRevision ||
		!workflowStateRoot ||
		!isAbsolute(workflowStateRoot) ||
		!writableRoots ||
		!deniedReadRoots
	)
		throw new Error("workflow execution manifest runtime binding is absent");
	verifyRuntimeSeal(runtimeRoot, {
		materializationDigest,
		agentToolkitDigest,
		agentToolkitVersion,
		agentToolkitSourceRevision,
	});
	await verifyWorkflowExecutionManifest(
		manifest,
		request.executionManifestSha256,
		{
			coordinatedRunRoot: request.cwd,
			coordinatedWorktreeRoots: manifest.repositories.map(
				(repository) => repository.root,
			),
			runtimeRoot,
			workflowStateRoot,
			writableRoots,
			deniedReadRoots,
			materializationDigest,
			agentToolkitDigest,
			agentToolkitName: "@vegardx/agent-toolkit",
			agentToolkitVersion,
			agentToolkitSourceRevision,
		},
	);
}

function parseAbsolutePathArray(
	source: string | undefined,
	allowEmpty = false,
): string[] | undefined {
	if (!source) return undefined;
	try {
		const parsed: unknown = JSON.parse(source);
		if (
			!Array.isArray(parsed) ||
			(!allowEmpty && parsed.length === 0) ||
			parsed.some((value) => typeof value !== "string" || !isAbsolute(value))
		)
			return undefined;
		return parsed as string[];
	} catch {
		return undefined;
	}
}

export async function verifyWorkflowSpecDigest(
	specPath: string,
	expectedSha256: string,
): Promise<void> {
	const actual = createHash("sha256")
		.update(await readFile(specPath))
		.digest("hex");
	if (actual !== expectedSha256)
		throw new Error("workflow supervisor spec digest mismatch");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	runWorkflowSupervisorEntry(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			process.stderr.write(
				`workflow supervisor failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 1;
		},
	);
}
