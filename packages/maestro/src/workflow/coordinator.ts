// Depth-zero composition for the package-external workflow supervisor.
// Workflow specifications and execution manifests arrive already approved;
// this module only binds them to seat-owned state, runtime, and launch authority.

import { randomBytes, randomUUID } from "node:crypto";
import {
	chmod,
	link,
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { UsageLedgerV1 } from "@vegardx/pi-contracts";
import { currentDepth } from "../spawn.js";
import type { WorkflowSupervisorRequest } from "./supervisor-entry.js";
import {
	digestWorkflowExecutionManifest,
	validateWorkflowExecutionManifestLaunch,
	type WorkflowExecutionManifest,
} from "./supervisor-execution-manifest.js";
import {
	type LaunchWorkflowSupervisorRequest,
	type WorkflowSupervisorExit,
	type WorkflowSupervisorHandle,
	WorkflowSupervisorLauncher,
} from "./supervisor-launcher.js";
import {
	type MaterializeWorkflowSupervisorRuntimeOptions,
	materializeWorkflowSupervisorRuntime,
	type WorkflowSupervisorRuntimeMaterialization,
} from "./supervisor-runtime.js";
import type { WorkflowSupervisorSandboxRoots } from "./supervisor-sandbox.js";
import {
	materializeWorkflowSupervisorState,
	type WorkflowSupervisorStateLayout,
} from "./supervisor-state.js";

export type UnboundWorkflowSupervisorRequest = Omit<
	WorkflowSupervisorRequest,
	"executionManifestPath" | "executionManifestSha256"
>;

export interface WorkflowCoordinatorLaunchInput {
	readonly executionManifest: WorkflowExecutionManifest;
	readonly executionManifestDigest: string;
	readonly workflowRequest: UnboundWorkflowSupervisorRequest;
	readonly runtimeOptions: MaterializeWorkflowSupervisorRuntimeOptions;
	readonly sandboxRoots: Omit<WorkflowSupervisorSandboxRoots, "scratchRoots">;
	readonly signal?: AbortSignal;
}

export type WorkflowCoordinatorTerminalStatus =
	| "completed"
	| "blocked"
	| "supervisor-failed";

export interface WorkflowCoordinatorTerminalProjection {
	readonly runId: string;
	readonly action: WorkflowSupervisorRequest["action"];
	readonly status: WorkflowCoordinatorTerminalStatus;
	/** Process outcome only. Package-native workflow state remains authoritative. */
	readonly supervisorExit: WorkflowSupervisorExit;
}

export interface WorkflowCoordinatorLifecycleProjection {
	readonly runId: string;
	readonly action: WorkflowSupervisorRequest["action"];
	readonly status: "running";
	readonly pid: number | undefined;
	readonly stdoutPath: string;
	readonly stderrPath: string;
	readonly completion: Promise<WorkflowCoordinatorTerminalProjection>;
}

export interface WorkflowCoordinatorDependencies<Runtime> {
	readonly materializeState: (
		coordinatedRunRoot: string,
	) => WorkflowSupervisorStateLayout | Promise<WorkflowSupervisorStateLayout>;
	readonly materializeRuntime: (
		options: MaterializeWorkflowSupervisorRuntimeOptions,
		state: WorkflowSupervisorStateLayout,
	) => Runtime | Promise<Runtime>;
	readonly claimStart: (
		state: WorkflowSupervisorStateLayout,
		runId: string,
		executionManifestDigest: string,
	) =>
		| WorkflowCoordinatorStartAuthority
		| Promise<WorkflowCoordinatorStartAuthority>;
	readonly observeWorkflowRun?: (
		cwd: string,
		runId: string,
	) => undefined | (() => void);
	readonly launch: (
		input: WorkflowCoordinatorLaunchInput,
		state: WorkflowSupervisorStateLayout,
		runtime: Runtime,
	) => WorkflowSupervisorHandle | Promise<WorkflowSupervisorHandle>;
}

export type WorkflowCoordinatorStartAuthority =
	| { readonly status: "existing" }
	| { readonly status: "busy" }
	| {
			readonly status: "claimed";
			readonly markStarted: (
				supervisorPid: number | undefined,
			) => Promise<void>;
			readonly release: () => Promise<void>;
	  };

interface InFlightLaunch {
	readonly action: WorkflowSupervisorRequest["action"];
	readonly fingerprint: string;
	readonly projection: Promise<WorkflowCoordinatorLifecycleProjection>;
	readonly settled: Promise<void>;
	done: boolean;
}

export class WorkflowCoordinator<Runtime> {
	readonly #dependencies: WorkflowCoordinatorDependencies<Runtime>;
	readonly #inFlight = new Map<string, InFlightLaunch>();

	constructor(dependencies: WorkflowCoordinatorDependencies<Runtime>) {
		this.#dependencies = dependencies;
	}

	start(
		input: WorkflowCoordinatorLaunchInput,
	): Promise<WorkflowCoordinatorLifecycleProjection> {
		return this.#serializedRun("start", input);
	}

	continue(
		input: WorkflowCoordinatorLaunchInput,
	): Promise<WorkflowCoordinatorLifecycleProjection> {
		return this.#serializedRun("continue", input);
	}

	#serializedRun(
		action: WorkflowSupervisorRequest["action"],
		input: WorkflowCoordinatorLaunchInput,
	): Promise<WorkflowCoordinatorLifecycleProjection> {
		if (input.workflowRequest.action !== action)
			return Promise.reject(
				new Error(
					`workflow coordinator ${action} requires a supervisor request whose action is ${action}`,
				),
			);
		try {
			if (
				digestWorkflowExecutionManifest(input.executionManifest) !==
				input.executionManifestDigest
			)
				return Promise.reject(
					new Error("workflow coordinator execution manifest digest mismatch"),
				);
		} catch (error) {
			return Promise.reject(error);
		}
		if (
			input.executionManifest.runId !== input.workflowRequest.runId ||
			input.executionManifest.artifacts.spec.path !==
				input.workflowRequest.specPath ||
			input.executionManifest.artifacts.spec.sha256 !==
				input.workflowRequest.specSha256
		)
			return Promise.reject(
				new Error("workflow coordinator manifest launch binding mismatch"),
			);
		try {
			validateWorkflowExecutionManifestLaunch(
				input.executionManifest,
				input.workflowRequest,
			);
		} catch (error) {
			return Promise.reject(error);
		}
		const key = `${input.workflowRequest.runId}\0${input.executionManifestDigest}`;
		const fingerprint = launchFingerprint(input);
		const current = this.#inFlight.get(key);
		if (current) {
			if (current.done) {
				this.#inFlight.delete(key);
				return this.#serializedRun(action, input);
			}
			if (current.action === action) {
				if (current.fingerprint !== fingerprint)
					return Promise.reject(
						new Error("conflicting in-flight workflow coordinator launch"),
					);
				return current.projection;
			}
			return current.settled.then(() => this.#serializedRun(action, input));
		}

		const projection = this.#launch(input);
		let flight: InFlightLaunch;
		const markDone = () => {
			flight.done = true;
			if (this.#inFlight.get(key) === flight) this.#inFlight.delete(key);
		};
		const settled = projection.then(
			(value) => value.completion.then(markDone, markDone),
			() => markDone(),
		);
		flight = { action, fingerprint, projection, settled, done: false };
		this.#inFlight.set(key, flight);
		return projection;
	}

	async #launch(
		input: WorkflowCoordinatorLaunchInput,
	): Promise<WorkflowCoordinatorLifecycleProjection> {
		const state = await this.#dependencies.materializeState(
			input.sandboxRoots.coordinatedRunRoot,
		);
		const runtime = await this.#dependencies.materializeRuntime(
			input.runtimeOptions,
			state,
		);
		let effectiveInput = input;
		let startAuthority:
			| Extract<WorkflowCoordinatorStartAuthority, { status: "claimed" }>
			| undefined;
		if (input.workflowRequest.action === "start") {
			const claim = await this.#dependencies.claimStart(
				state,
				input.workflowRequest.runId,
				input.executionManifestDigest,
			);
			if (claim.status === "busy")
				throw new Error(
					`workflow start for ${input.workflowRequest.runId} is owned by a live coordinator`,
				);
			if (claim.status === "existing")
				effectiveInput = {
					...input,
					workflowRequest: { ...input.workflowRequest, action: "continue" },
				};
			else startAuthority = claim;
		}
		let stopObserving: (() => void) | undefined;
		let closed = false;
		const closeResources = async () => {
			if (closed) return;
			closed = true;
			try {
				stopObserving?.();
			} finally {
				await startAuthority?.release();
			}
		};
		try {
			const observation = this.#dependencies.observeWorkflowRun?.(
				effectiveInput.workflowRequest.cwd,
				effectiveInput.workflowRequest.runId,
			);
			if (observation) stopObserving = observation;
			const handle = await this.#dependencies.launch(
				effectiveInput,
				state,
				runtime,
			);
			await startAuthority?.markStarted(handle.pid);
			// The usage ledger owns its successful poller until package state becomes
			// terminal. Cancelling it with the supervisor process would lose the final
			// task snapshots for short workflows. We only cancel if launch itself fails.
			stopObserving = undefined;
			return projectLifecycle(
				effectiveInput.workflowRequest,
				handle,
				closeResources,
			);
		} catch (error) {
			await closeResources();
			throw error;
		}
	}
}

function launchFingerprint(input: WorkflowCoordinatorLaunchInput): string {
	const { signal: _signal, ...durableInput } = input;
	return canonicalValue(durableInput);
}

function canonicalValue(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? "null" : serialized;
	}
	if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
	const record = value as Readonly<Record<string, unknown>>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
		.join(",")}}`;
}

/** Production adapter: materialize once, then make the launcher reuse it. */
export function createWorkflowCoordinator(
	options: {
		readonly launcher?: Pick<
			WorkflowSupervisorLauncher<WorkflowSupervisorRuntimeMaterialization>,
			"launch"
		>;
		readonly materializeState?: typeof materializeWorkflowSupervisorState;
		readonly materializeRuntime?: WorkflowCoordinatorDependencies<WorkflowSupervisorRuntimeMaterialization>["materializeRuntime"];
		readonly claimStart?: WorkflowCoordinatorDependencies<WorkflowSupervisorRuntimeMaterialization>["claimStart"];
		readonly usage?: Pick<UsageLedgerV1, "trackWorkflowRun">;
		readonly depth?: () => number;
	} = {},
): WorkflowCoordinator<WorkflowSupervisorRuntimeMaterialization> {
	if ((options.depth ?? currentDepth)() !== 0)
		throw new Error(
			"workflow coordinator production authority belongs to depth 0",
		);
	const launcher =
		options.launcher ??
		new WorkflowSupervisorLauncher<WorkflowSupervisorRuntimeMaterialization>({
			materialize: (runtime) => runtime,
		});
	return new WorkflowCoordinator({
		materializeState:
			options.materializeState ?? materializeWorkflowSupervisorState,
		materializeRuntime:
			options.materializeRuntime ?? materializeWorkflowSupervisorRuntime,
		claimStart: options.claimStart ?? claimWorkflowCoordinatorStart,
		...(options.usage
			? {
					observeWorkflowRun: (cwd: string, runId: string) =>
						options.usage?.trackWorkflowRun(cwd, runId),
				}
			: {}),
		launch: (input, state, runtime) => {
			assertStateBinding(input, state);
			const launchRequest: LaunchWorkflowSupervisorRequest<WorkflowSupervisorRuntimeMaterialization> =
				{
					workflowRequest: input.workflowRequest,
					executionManifest: input.executionManifest,
					executionManifestDigest: input.executionManifestDigest,
					materializerOptions: runtime,
					sandboxRoots: {
						coordinatedRunRoot: input.sandboxRoots.coordinatedRunRoot,
						workflowStateRoot: input.sandboxRoots.workflowStateRoot,
						coordinatedWorktreeRoots:
							input.sandboxRoots.coordinatedWorktreeRoots,
						worktreeAccess: input.sandboxRoots.worktreeAccess,
						...(input.sandboxRoots.deniedReadRoots
							? { deniedReadRoots: input.sandboxRoots.deniedReadRoots }
							: {}),
					},
					...(input.signal ? { signal: input.signal } : {}),
				};
			return launcher.launch(launchRequest);
		},
	});
}

async function persistPrivateExactFile(
	path: string,
	contents: string,
): Promise<boolean> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await chmod(dirname(path), 0o700);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		try {
			await handle.writeFile(contents, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await link(temporary, path);
			return true;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
			const existing = await readFile(path, "utf8");
			if (existing !== contents)
				throw new Error(`workflow private file conflicts: ${path}`);
			return false;
		}
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		});
	}
}

function assertSafeCoordinatorIdentifier(value: string, label: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
		throw new Error(`${label} is not safe`);
}

interface WorkflowCoordinatorStartClaim {
	readonly version: 2;
	readonly runId: string;
	readonly executionManifestDigest: string;
	readonly status: "claimed" | "started" | "bound";
	readonly ownerPid: number;
	readonly ownerToken: string;
	readonly supervisorPid?: number;
}

export interface WorkflowCoordinatorStartClaimOptions {
	/** Test seam for crash/takeover behavior. */
	readonly ownerPid?: number;
	/** Test seam; production probes the recorded process with signal zero. */
	readonly isProcessAlive?: (pid: number) => boolean;
}

/**
 * Lease the package's start edge. The active lease exists only until the
 * supervisor settles; once run.json exists it becomes a durable manifest-digest
 * binding and package state is the exactly-once authority every later request
 * continues. A dead lease with no package run is safe to reclaim after a seat
 * crash before launch.
 */
export async function claimWorkflowCoordinatorStart(
	state: WorkflowSupervisorStateLayout,
	runId: string,
	executionManifestDigest: string,
	options: WorkflowCoordinatorStartClaimOptions = {},
): Promise<WorkflowCoordinatorStartAuthority> {
	assertSafeCoordinatorIdentifier(runId, "workflow run id");
	if (!/^[a-f0-9]{64}$/.test(executionManifestDigest))
		throw new Error("workflow execution manifest digest is invalid");
	// A sibling of package-owned `.pi`, beneath the seat-owned runtime container.
	// Workflow descendants can write `.pi`; they cannot erase this launch claim.
	const directory = join(
		state.coordinatedRunRoot,
		"runtime",
		"maestro-start-claims",
	);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const directoryInfo = await lstat(directory);
	if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
		throw new Error("workflow coordinator start claim path is not a directory");
	const canonicalRunRoot = await realpath(state.coordinatedRunRoot);
	const canonicalDirectory = await realpath(directory);
	const directoryRelative = relative(canonicalRunRoot, canonicalDirectory);
	if (
		!directoryRelative ||
		directoryRelative.startsWith("..") ||
		isAbsolute(directoryRelative)
	)
		throw new Error("workflow coordinator start claim path escaped run state");
	await chmod(directory, 0o700);
	const target = join(directory, `${runId}.json`);
	const ownerPid = options.ownerPid ?? process.pid;
	if (!Number.isSafeInteger(ownerPid) || ownerPid < 1)
		throw new Error("workflow start lease owner pid is invalid");
	const ownerToken = randomBytes(32).toString("base64url");
	const isAlive = options.isProcessAlive ?? processIsAlive;
	return await withStartClaimLock(directory, runId, ownerPid, async () => {
		const existing = await readStartClaim(target, runId);
		if (
			existing &&
			existing.executionManifestDigest !== executionManifestDigest
		)
			throw new Error(
				`workflow coordinator start claim conflicts for ${runId}`,
			);
		if (await workflowPackageRunExists(state, runId))
			return { status: "existing" };
		if (
			existing &&
			existing.status !== "bound" &&
			(isAlive(existing.ownerPid) ||
				(existing.supervisorPid !== undefined &&
					isAlive(existing.supervisorPid)))
		)
			return { status: "busy" };

		const claim: WorkflowCoordinatorStartClaim = {
			version: 2,
			runId,
			executionManifestDigest,
			status: "claimed",
			ownerPid,
			ownerToken,
		};
		await replacePrivateFile(target, `${JSON.stringify(claim)}\n`);
		return startLease(state, directory, target, claim);
	});
}

function startLease(
	state: WorkflowSupervisorStateLayout,
	directory: string,
	target: string,
	claim: WorkflowCoordinatorStartClaim,
): Extract<WorkflowCoordinatorStartAuthority, { status: "claimed" }> {
	const update = async (supervisorPid: number | undefined) => {
		await withStartClaimLock(
			directory,
			claim.runId,
			claim.ownerPid,
			async () => {
				const current = await readStartClaim(target, claim.runId);
				if (!current || current.ownerToken !== claim.ownerToken)
					throw new Error(`workflow start lease was lost for ${claim.runId}`);
				await replacePrivateFile(
					target,
					`${JSON.stringify({
						...current,
						status: "started",
						...(supervisorPid !== undefined ? { supervisorPid } : {}),
					})}\n`,
				);
			},
		);
	};
	const release = async () => {
		await withStartClaimLock(
			directory,
			claim.runId,
			claim.ownerPid,
			async () => {
				const current = await readStartClaim(target, claim.runId);
				if (current?.ownerToken !== claim.ownerToken) return;
				if (await workflowPackageRunExists(state, claim.runId)) {
					const bound: WorkflowCoordinatorStartClaim = {
						version: 2,
						runId: current.runId,
						executionManifestDigest: current.executionManifestDigest,
						status: "bound",
						ownerPid: current.ownerPid,
						ownerToken: current.ownerToken,
					};
					await replacePrivateFile(target, `${JSON.stringify(bound)}\n`);
					return;
				}
				await unlink(target);
			},
		);
	};
	return { status: "claimed", markStarted: update, release };
}

async function workflowPackageRunExists(
	state: WorkflowSupervisorStateLayout,
	runId: string,
): Promise<boolean> {
	const path = join(state.workflowStateRoot, "workflows", runId, "run.json");
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink())
			throw new Error(
				`workflow package run state is not a regular file: ${path}`,
			);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

async function readStartClaim(
	path: string,
	runId: string,
): Promise<WorkflowCoordinatorStartClaim | undefined> {
	try {
		const info = await lstat(path);
		if (
			!info.isFile() ||
			info.isSymbolicLink() ||
			(info.mode & 0o777) !== 0o600
		)
			throw new Error(
				`workflow coordinator start claim is not a private regular file for ${runId}`,
			);
		const value = JSON.parse(
			await readFile(path, "utf8"),
		) as Partial<WorkflowCoordinatorStartClaim>;
		if (
			value.version !== 2 ||
			value.runId !== runId ||
			(value.status !== "claimed" &&
				value.status !== "started" &&
				value.status !== "bound") ||
			typeof value.executionManifestDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.executionManifestDigest) ||
			typeof value.ownerPid !== "number" ||
			!Number.isSafeInteger(value.ownerPid) ||
			value.ownerPid < 1 ||
			typeof value.ownerToken !== "string" ||
			value.ownerToken.length < 32 ||
			(value.supervisorPid !== undefined &&
				(typeof value.supervisorPid !== "number" ||
					!Number.isSafeInteger(value.supervisorPid) ||
					value.supervisorPid < 1))
		)
			throw new Error(
				`workflow coordinator start claim is invalid for ${runId}`,
			);
		return value as WorkflowCoordinatorStartClaim;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function withStartClaimLock<T>(
	directory: string,
	runId: string,
	ownerPid: number,
	action: () => Promise<T>,
): Promise<T> {
	const lockPath = join(directory, `${runId}.lock`);
	const lockToken = randomBytes(32).toString("base64url");
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const temporary = join(directory, `.lock-${ownerPid}-${randomUUID()}.tmp`);
		await persistPrivateExactFile(
			temporary,
			`${JSON.stringify({ version: 1, ownerPid, lockToken })}\n`,
		);
		try {
			try {
				await link(temporary, lockPath);
			} catch (error) {
				if (!isNodeError(error) || error.code !== "EEXIST") throw error;
				await new Promise((resolveWait) => setTimeout(resolveWait, 10));
				continue;
			}
			try {
				return await action();
			} finally {
				const held = JSON.parse(await readFile(lockPath, "utf8")) as {
					lockToken?: unknown;
				};
				if (held.lockToken === lockToken) await unlink(lockPath);
			}
		} finally {
			await unlink(temporary).catch((error: unknown) => {
				if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			});
		}
	}
	throw new Error(`timed out acquiring workflow start lease for ${runId}`);
}

async function replacePrivateFile(
	path: string,
	contents: string,
): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		try {
			await handle.writeFile(contents, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		});
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error) && error.code === "EPERM";
	}
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value;
}

function assertStateBinding(
	input: WorkflowCoordinatorLaunchInput,
	state: WorkflowSupervisorStateLayout,
): void {
	if (
		state.coordinatedRunRoot !== input.sandboxRoots.coordinatedRunRoot ||
		state.workflowStateRoot !== input.sandboxRoots.workflowStateRoot ||
		input.runtimeOptions.coordinatedRunRoot !== state.coordinatedRunRoot
	)
		throw new Error("workflow coordinator state binding mismatch");
}

function projectLifecycle(
	request: UnboundWorkflowSupervisorRequest,
	handle: WorkflowSupervisorHandle,
	closeResources?: () => Promise<void>,
): WorkflowCoordinatorLifecycleProjection {
	const completion = handle.completion.then((supervisorExit) => ({
		runId: request.runId,
		action: request.action,
		status: terminalStatus(supervisorExit),
		supervisorExit,
	}));
	return {
		runId: request.runId,
		action: request.action,
		status: "running",
		pid: handle.pid,
		stdoutPath: handle.stdoutPath,
		stderrPath: handle.stderrPath,
		completion: closeResources
			? completion.finally(closeResources)
			: completion,
	};
}

function terminalStatus(
	exit: WorkflowSupervisorExit,
): WorkflowCoordinatorTerminalStatus {
	if (!exit.error && exit.signal === null && exit.code === 0)
		return "completed";
	if (!exit.error && exit.signal === null && exit.code === 2) return "blocked";
	return "supervisor-failed";
}
