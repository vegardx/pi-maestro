import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	claimWorkflowCoordinatorStart,
	createWorkflowCoordinator,
	WorkflowCoordinator,
	type WorkflowCoordinatorLaunchInput,
} from "../../../packages/maestro/src/workflow/coordinator.js";
import {
	digestWorkflowExecutionManifest,
	type WorkflowExecutionManifest,
} from "../../../packages/maestro/src/workflow/supervisor-execution-manifest.js";
import type { WorkflowSupervisorRuntimeMaterialization } from "../../../packages/maestro/src/workflow/supervisor-runtime.js";

function input(action: "start" | "continue"): WorkflowCoordinatorLaunchInput {
	const digest = "a".repeat(64);
	const manifest: WorkflowExecutionManifest = {
		version: 1,
		runId: "run_001",
		launch: {
			task: "Implement the approved workflow.",
			executionProfile: null,
			inputOverrides: {},
		},
		artifacts: {
			spec: { path: "/run/runtime/bundle/workflow.json", sha256: digest },
			bundle: {
				root: "/run/runtime/bundle",
				files: [{ path: "workflow.json", sha256: digest }],
			},
			helpers: [],
			models: { path: "/run/runtime/models.json", sha256: digest },
			profile: { path: "/run/runtime/profile.json", sha256: digest },
		},
		repositories: [{ id: "project", root: "/run/repos/project" }],
		authorityPolicy: {
			path: "/run/runtime/authority.json",
			sha256: digest,
		},
		materialization: {
			runtimeRoot: "/run/scratch/workflow-supervisor",
			workflowStateRoot: "/run/runtime/.pi",
			deniedReadRoots: [],
			writableRoots: [
				"/run/repos/project",
				"/run/runtime/.pi",
				"/run/scratch/workflow-supervisor/mutable/auth.json",
				"/run/scratch/workflow-supervisor/mutable/home",
				"/run/scratch/workflow-supervisor/mutable/sessions",
				"/run/scratch/workflow-supervisor/mutable/tmp",
			],
			materializationDigest: digest,
			agentToolkitDigest: digest,
			agentToolkitName: "@vegardx/agent-toolkit",
			agentToolkitVersion: "1.0.0",
			agentToolkitSourceRevision: "b".repeat(40),
		},
	};
	return {
		workflowRequest: {
			version: 1,
			action,
			runId: "run_001",
			cwd: "/run",
			specPath: "/run/runtime/bundle/workflow.json",
			specSha256: digest,
			task: "Implement the approved workflow.",
			waitTimeoutMs: 60_000,
		},
		executionManifest: manifest,
		executionManifestDigest: digestWorkflowExecutionManifest(manifest),
		runtimeOptions: { coordinatedRunRoot: "/run" } as never,
		sandboxRoots: {
			coordinatedRunRoot: "/run",
			workflowStateRoot: "/run/runtime/.pi",
			coordinatedWorktreeRoots: ["/run/repos/project"],
			worktreeAccess: "write",
		},
	};
}

function state() {
	return {
		coordinatedRunRoot: "/run",
		workflowStateRoot: "/run/runtime/.pi",
		workflowStateLink: "/run/.pi",
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function claimedStart() {
	return {
		status: "claimed" as const,
		markStarted: vi.fn(async () => undefined),
		release: vi.fn(async () => undefined),
	};
}

describe("depth-zero workflow coordinator", () => {
	it.each([
		["start" as const, 0, "completed"],
		["continue" as const, 2, "blocked"],
		["start" as const, 1, "supervisor-failed"],
	])(
		"composes approved launch authority for %s and projects exit %s",
		async (action, exitCode, terminalStatus) => {
			const calls: string[] = [];
			const materializeState = vi.fn(async () => {
				calls.push("state");
				return state();
			});
			const materializeRuntime = vi.fn(async () => {
				calls.push("runtime");
				return { scratch: "/run/scratch/supervisor" };
			});
			const launch = vi.fn(async () => {
				calls.push("launch");
				return {
					pid: 42,
					stdoutPath: "/run/runtime/stdout.log",
					stderrPath: "/run/runtime/stderr.log",
					completion: Promise.resolve({
						code: exitCode,
						signal: null,
						stderr: "",
					}),
				};
			});
			const coordinator = new WorkflowCoordinator({
				materializeState,
				claimStart: async () => claimedStart(),
				materializeRuntime,
				launch,
			});
			const approved = input(action);

			const projection = await coordinator[action](approved);

			expect(calls).toEqual(["state", "runtime", "launch"]);
			expect(materializeRuntime).toHaveBeenCalledWith(
				approved.runtimeOptions,
				state(),
			);
			expect(launch).toHaveBeenCalledWith(approved, state(), {
				scratch: "/run/scratch/supervisor",
			});
			expect(projection).toMatchObject({
				runId: "run_001",
				action,
				status: "running",
				pid: 42,
			});
			await expect(projection.completion).resolves.toMatchObject({
				runId: "run_001",
				action,
				status: terminalStatus,
				supervisorExit: { code: exitCode },
			});
		},
	);

	it("deduplicates one in-flight action for the same run and manifest", async () => {
		const completion = deferred<{
			code: number;
			signal: null;
			stderr: string;
		}>();
		const launch = vi.fn(async () => ({
			pid: 42,
			stdoutPath: "/stdout",
			stderrPath: "/stderr",
			completion: completion.promise,
		}));
		const coordinator = new WorkflowCoordinator({
			materializeState: async () => state(),
			claimStart: async () => claimedStart(),
			materializeRuntime: async () => ({ runtime: true }),
			launch,
		});
		const approved = input("start");

		const first = coordinator.start(approved);
		const duplicate = coordinator.start(approved);
		expect(duplicate).toBe(first);
		await first;
		expect(launch).toHaveBeenCalledTimes(1);
		completion.resolve({ code: 0, signal: null, stderr: "" });
		await (await first).completion;
	});

	it("rejects a conflicting same-key launch instead of piggybacking authority", async () => {
		const completion = deferred<{
			code: number;
			signal: null;
			stderr: string;
		}>();
		const coordinator = new WorkflowCoordinator({
			materializeState: async () => state(),
			claimStart: async () => claimedStart(),
			materializeRuntime: async () => ({ runtime: true }),
			launch: async () => ({
				pid: 42,
				stdoutPath: "/stdout",
				stderrPath: "/stderr",
				completion: completion.promise,
			}),
		});
		const approved = input("start");
		await coordinator.start(approved);
		const changed = {
			...input("start"),
			runtimeOptions: {
				...input("start").runtimeOptions,
				approvedProviderIds: ["different"],
			},
		};

		await expect(coordinator.start(changed)).rejects.toThrow(
			/conflicting in-flight/,
		);
		completion.resolve({ code: 0, signal: null, stderr: "" });
	});

	it("serializes continue behind an in-flight start", async () => {
		const firstExit = deferred<{
			code: number;
			signal: null;
			stderr: string;
		}>();
		const launch = vi
			.fn()
			.mockResolvedValueOnce({
				pid: 1,
				stdoutPath: "/stdout-1",
				stderrPath: "/stderr-1",
				completion: firstExit.promise,
			})
			.mockResolvedValueOnce({
				pid: 2,
				stdoutPath: "/stdout-2",
				stderrPath: "/stderr-2",
				completion: Promise.resolve({ code: 0, signal: null, stderr: "" }),
			});
		const coordinator = new WorkflowCoordinator({
			materializeState: async () => state(),
			claimStart: async () => claimedStart(),
			materializeRuntime: async () => ({ runtime: true }),
			launch,
		});

		const started = coordinator.start(input("start"));
		const continued = coordinator.continue(input("continue"));
		await started;
		expect(launch).toHaveBeenCalledTimes(1);
		firstExit.resolve({ code: 1, signal: null, stderr: "crashed" });
		await continued;
		expect(launch).toHaveBeenCalledTimes(2);
	});

	it("converts a sequential repeated start into continuation", async () => {
		let claimed = false;
		const actions: string[] = [];
		const coordinator = new WorkflowCoordinator({
			materializeState: async () => state(),
			claimStart: async () => {
				if (claimed) return { status: "existing" as const };
				claimed = true;
				return claimedStart();
			},
			materializeRuntime: async () => ({ runtime: true }),
			launch: async (approved) => {
				actions.push(approved.workflowRequest.action);
				return {
					pid: 42,
					stdoutPath: "/stdout",
					stderrPath: "/stderr",
					completion: Promise.resolve({ code: 0, signal: null, stderr: "" }),
				};
			},
		});

		await (await coordinator.start(input("start"))).completion;
		await Promise.resolve();
		const repeated = await coordinator.start(input("start"));
		expect(repeated.action).toBe("continue");
		expect(actions).toEqual(["start", "continue"]);
	});

	it("continues package state across coordinator reconstruction", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "maestro-start-claim-"));
		try {
			const workflowStateRoot = join(fixture, "runtime", ".pi");
			await mkdir(workflowStateRoot, { recursive: true });
			const durableState = {
				coordinatedRunRoot: fixture,
				workflowStateRoot,
				workflowStateLink: join(fixture, ".pi"),
			};
			const actions: string[] = [];
			const construct = () =>
				new WorkflowCoordinator({
					materializeState: async () => durableState,
					claimStart: claimWorkflowCoordinatorStart,
					materializeRuntime: async () => ({ runtime: true }),
					launch: async (approved) => {
						actions.push(approved.workflowRequest.action);
						if (approved.workflowRequest.action === "start") {
							const packageRunDirectory = join(
								workflowStateRoot,
								"workflows",
								"run_001",
							);
							await mkdir(packageRunDirectory, { recursive: true });
							await writeFile(join(packageRunDirectory, "run.json"), "{}\n");
						}
						return {
							pid: 42,
							stdoutPath: "/stdout",
							stderrPath: "/stderr",
							completion: Promise.resolve({
								code: 0,
								signal: null,
								stderr: "",
							}),
						};
					},
				});

			await (await construct().start(input("start"))).completion;
			const restarted = await construct().start(input("start"));
			expect(restarted.action).toBe("continue");
			expect(actions).toEqual(["start", "continue"]);
			await restarted.completion;
			await expect(
				claimWorkflowCoordinatorStart(durableState, "run_001", "0".repeat(64)),
			).rejects.toThrow(/claim conflicts/);
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	it("reclaims a dead pre-launch lease without allowing concurrent starts", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "maestro-start-takeover-"));
		try {
			const workflowStateRoot = join(fixture, "runtime", ".pi");
			await mkdir(workflowStateRoot, { recursive: true });
			const durableState = {
				coordinatedRunRoot: fixture,
				workflowStateRoot,
				workflowStateLink: join(fixture, ".pi"),
			};
			const live = new Set([101, 202, 303]);
			const isProcessAlive = (pid: number) => live.has(pid);
			const crashed = await claimWorkflowCoordinatorStart(
				durableState,
				"run_001",
				"a".repeat(64),
				{ ownerPid: 101, isProcessAlive },
			);
			expect(crashed.status).toBe("claimed");
			live.delete(101);

			const reclaimed = await claimWorkflowCoordinatorStart(
				durableState,
				"run_001",
				"a".repeat(64),
				{ ownerPid: 202, isProcessAlive },
			);
			expect(reclaimed.status).toBe("claimed");
			if (reclaimed.status === "claimed") await reclaimed.release();

			const competing = await Promise.all([
				claimWorkflowCoordinatorStart(durableState, "run_002", "b".repeat(64), {
					ownerPid: 202,
					isProcessAlive,
				}),
				claimWorkflowCoordinatorStart(durableState, "run_002", "b".repeat(64), {
					ownerPid: 303,
					isProcessAlive,
				}),
			]);
			expect(competing.map(({ status }) => status).sort()).toEqual([
				"busy",
				"claimed",
			]);
			const winner = competing.find(({ status }) => status === "claimed");
			if (winner?.status === "claimed") await winner.release();
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	it("releases a pre-launch lease when supervisor launch fails", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "maestro-start-failure-"));
		try {
			const workflowStateRoot = join(fixture, "runtime", ".pi");
			await mkdir(workflowStateRoot, { recursive: true });
			const durableState = {
				coordinatedRunRoot: fixture,
				workflowStateRoot,
				workflowStateLink: join(fixture, ".pi"),
			};
			const failing = new WorkflowCoordinator({
				materializeState: async () => durableState,
				claimStart: claimWorkflowCoordinatorStart,
				materializeRuntime: async () => ({}),
				launch: async () => {
					throw new Error("spawn refused");
				},
			});
			await expect(failing.start(input("start"))).rejects.toThrow(
				/spawn refused/,
			);

			const launch = vi.fn(async () => ({
				pid: 42,
				stdoutPath: "/stdout",
				stderrPath: "/stderr",
				completion: Promise.resolve({ code: 0, signal: null, stderr: "" }),
			}));
			const recovered = new WorkflowCoordinator({
				materializeState: async () => durableState,
				claimStart: claimWorkflowCoordinatorStart,
				materializeRuntime: async () => ({}),
				launch,
			});
			const projection = await recovered.start(input("start"));
			expect(projection.action).toBe("start");
			expect(launch).toHaveBeenCalledOnce();
			await projection.completion;
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	it("refuses an action mismatch before any authority is exercised", async () => {
		const materializeState = vi.fn();
		const coordinator = new WorkflowCoordinator({
			materializeState,
			claimStart: vi.fn(),
			materializeRuntime: vi.fn(),
			launch: vi.fn(),
		});

		await expect(coordinator.start(input("continue"))).rejects.toThrow(
			/action is start/,
		);
		expect(materializeState).not.toHaveBeenCalled();
	});

	it("refuses an unapproved manifest digest before materialization", async () => {
		const materializeState = vi.fn();
		const coordinator = new WorkflowCoordinator({
			materializeState,
			claimStart: vi.fn(),
			materializeRuntime: vi.fn(),
			launch: vi.fn(),
		});
		await expect(
			coordinator.start({
				...input("start"),
				executionManifestDigest: "0".repeat(64),
			}),
		).rejects.toThrow(/manifest digest mismatch/);
		expect(materializeState).not.toHaveBeenCalled();
	});

	it("production composition is depth-zero only and reuses its runtime", async () => {
		expect(() => createWorkflowCoordinator({ depth: () => 1 })).toThrow(
			/depth 0/,
		);
		const runtime = { runtimeRoot: "/run/scratch/runtime" } as
			| WorkflowSupervisorRuntimeMaterialization
			| never;
		const launch = vi.fn(async () => ({
			pid: 42,
			stdoutPath: "/stdout",
			stderrPath: "/stderr",
			completion: Promise.resolve({ code: 0, signal: null, stderr: "" }),
		}));
		const coordinator = createWorkflowCoordinator({
			depth: () => 0,
			materializeState: () => state(),
			materializeRuntime: vi.fn(async () => runtime),
			claimStart: async () => claimedStart(),
			launcher: { launch },
		});
		const approved = input("start");

		await coordinator.start(approved);
		expect(launch).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowRequest: approved.workflowRequest,
				executionManifest: approved.executionManifest,
				executionManifestDigest: approved.executionManifestDigest,
				materializerOptions: runtime,
				sandboxRoots: approved.sandboxRoots,
			}),
		);
	});

	it("observes every effective workflow action through the typed usage seam", async () => {
		const stop = vi.fn();
		const trackWorkflowRun = vi.fn(() => stop);
		const coordinator = createWorkflowCoordinator({
			depth: () => 0,
			materializeState: () => state(),
			materializeRuntime: async () => ({}) as never,
			claimStart: async () => claimedStart(),
			usage: { trackWorkflowRun },
			launcher: {
				launch: async () => ({
					pid: 42,
					stdoutPath: "/stdout",
					stderrPath: "/stderr",
					completion: Promise.resolve({ code: 0, signal: null, stderr: "" }),
				}),
			},
		});

		await (await coordinator.start(input("start"))).completion;
		await (await coordinator.continue(input("continue"))).completion;
		expect(trackWorkflowRun).toHaveBeenNthCalledWith(1, "/run", "run_001");
		expect(trackWorkflowRun).toHaveBeenNthCalledWith(2, "/run", "run_001");
		expect(stop).not.toHaveBeenCalled();

		const failed = createWorkflowCoordinator({
			depth: () => 0,
			materializeState: () => state(),
			materializeRuntime: async () => ({}) as never,
			claimStart: async () => claimedStart(),
			usage: { trackWorkflowRun },
			launcher: {
				launch: async () => {
					throw new Error("spawn failed");
				},
			},
		});
		await expect(failed.start(input("start"))).rejects.toThrow(/spawn failed/);
		expect(stop).toHaveBeenCalledOnce();
	});
});
