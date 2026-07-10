// SubagentService — the subagents.v1 capability. It owns the run lifecycle and
// projects it onto the run-bus + store; it does NOT know how a child process is
// actually launched. The launch mechanism is an injected AgentRunner so the
// service tests as pure orchestration (the real RpcClient / foreground runners
// land in the runners+concurrency child deliverable).

import type {
	RunHandle,
	RunId,
	RunRecord,
	RunResult,
	SpawnProfile,
	SubagentsCapabilityV1,
} from "@vegardx/pi-contracts";
import type { RunBus } from "./bus.js";
import {
	type ChildInvocation,
	currentDepth,
	mapProfileToInvocation,
	type SpawnContext,
} from "./invocation.js";
import type { RunStore } from "./store.js";

/** Live control over one launched child. Implemented by the runners. */
export interface RunnerController {
	steer(guidance: string): void;
	stop(reason?: string): void;
	/** Resolves when the child settles. */
	result(): Promise<RunResult>;
	/** Timestamp of the child's most recent event (liveness for watchdogs). */
	lastEventAt?(): number;
	/** Last completed assistant text — salvage for stopped runs. */
	partialText?(): Promise<string | undefined>;
}

export interface LaunchRequest {
	readonly runId: RunId;
	readonly prompt: string;
	readonly profile: SpawnProfile;
	readonly invocation: ChildInvocation;
}

/** Launches a child and reports lifecycle back over the run-bus. */
export interface AgentRunner {
	launch(request: LaunchRequest, bus: RunBus): RunnerController;
}

export interface SubagentServiceOptions {
	readonly bus: RunBus;
	readonly store: RunStore;
	readonly runner: AgentRunner;
	readonly repoRoot: string;
	/** Defaults to the spawner's cwd from its context. */
	readonly spawnerCwd?: string;
	/** Mint a unique run id. Defaults to a time+random id. */
	readonly mintId?: () => RunId;
	/** Hard recursion cap across the whole tree. */
	readonly maxDepth?: number;
	/** This agent's own nesting depth. Defaults to reading PI_MAESTRO_DEPTH. */
	readonly ownDepth?: number;
}

const DEFAULT_MAX_DEPTH = 3;

export class SubagentService implements SubagentsCapabilityV1 {
	private readonly bus: RunBus;
	private readonly store: RunStore;
	private readonly runner: AgentRunner;
	private readonly repoRoot: string;
	private readonly spawnerCwd?: string;
	private readonly mintId: () => RunId;
	private readonly maxDepth: number;
	private readonly ownDepth: number;
	private readonly controllers = new Map<RunId, RunnerController>();

	constructor(opts: SubagentServiceOptions) {
		this.bus = opts.bus;
		this.store = opts.store;
		this.runner = opts.runner;
		this.repoRoot = opts.repoRoot;
		this.spawnerCwd = opts.spawnerCwd;
		this.mintId = opts.mintId ?? defaultMintId;
		this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
		this.ownDepth = opts.ownDepth ?? currentDepth();
	}

	spawn(prompt: string, profile: SpawnProfile): RunHandle {
		if (this.ownDepth >= this.maxDepth) {
			throw new Error(
				`subagent depth cap reached (${this.ownDepth}/${this.maxDepth})`,
			);
		}

		const ctx: SpawnContext = {
			spawnerCwd: this.spawnerCwd,
			repoRoot: this.repoRoot,
			parentDepth: this.ownDepth,
		};
		const invocation = mapProfileToInvocation(profile, ctx);
		const runId = this.mintId();

		// Announce the run first so the store has a record before the runner
		// emits any status/progress.
		this.bus.publish({
			type: "spawn",
			run: { id: runId, prompt, profile },
		});

		const controller = this.runner.launch(
			{ runId, prompt, profile, invocation },
			this.bus,
		);
		this.controllers.set(runId, controller);

		return {
			id: runId,
			status: () => this.store.readRecord(runId)?.status ?? "queued",
			steer: (guidance) => this.steer(runId, guidance),
			stop: (reason) => this.stop(runId, reason),
			result: () => controller.result(),
			...(controller.lastEventAt
				? { lastEventAt: controller.lastEventAt.bind(controller) }
				: {}),
			...(controller.partialText
				? { partialText: controller.partialText.bind(controller) }
				: {}),
		};
	}

	get(runId: RunId): RunRecord | undefined {
		return this.store.readRecord(runId);
	}

	list(): readonly RunRecord[] {
		return this.store.list();
	}

	steer(runId: RunId, guidance: string): void {
		this.controllers.get(runId)?.steer(guidance);
		this.bus.publish({ type: "steer", runId, guidance });
	}

	stop(runId: RunId, reason?: string): void {
		this.controllers.get(runId)?.stop(reason);
		this.bus.publish({ type: "stop", runId, reason });
	}
}

function defaultMintId(): RunId {
	const stamp = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `run-${stamp}-${rand}` as RunId;
}
