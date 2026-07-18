// SubagentService — the subagents.v1 capability. It owns the run lifecycle and
// projects it onto the run-bus + store; it does NOT know how a child process is
// actually launched. The launch mechanism is an injected AgentRunner so the
// service tests as pure orchestration (the real RpcClient / foreground runners
// land in the runners+concurrency child deliverable).

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type {
	InterruptResult,
	RunHandle,
	RunId,
	RunRecord,
	RunResult,
	RunTransport,
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
import { isTerminal } from "./state-machine.js";
import type { RunStore } from "./store.js";
import { RUN_ID_ENV } from "./supervisor.js";

/** Live control over one launched child. Implemented by the runners. */
export interface RunnerController {
	steer(guidance: string): void;
	interrupt?(reason?: string): Promise<InterruptResult>;
	stop(reason?: string): void;
	/** Resolves when the child settles. */
	result(): Promise<RunResult>;
	/** Timestamp of the child's most recent event (liveness for watchdogs). */
	lastEventAt?(): number;
	/** Last completed assistant text — salvage for stopped runs. */
	partialText?(): Promise<string | undefined>;
	capture?(lines?: number): Promise<string | undefined>;
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
	/**
	 * Extension paths merged into EVERY spawn's extraExtensions (read fresh
	 * per spawn). The childExtensions passthrough: children run -ne, which
	 * also suppresses tool-less infra like custom model providers — this is
	 * the single seam that restores them for all callers.
	 */
	readonly extraExtensions?: () => readonly string[];
	/**
	 * Transport for profiles that don't select one. Defaults to "tmux" —
	 * inspectable runs are the norm; headless is an explicit choice.
	 */
	readonly defaultTransport?: RunTransport;
	/**
	 * Cross-process control seams for the steer/interrupt transport fallbacks
	 * (runs owned by another process have no in-process controller here).
	 * Tests fake them; the defaults hit the real OS/tmux.
	 */
	readonly killProcessGroup?: (
		processGroup: number,
		signal: NodeJS.Signals,
	) => void;
	readonly tmuxSendKeys?: (session: string, keys: string) => void;
}

const DEFAULT_MAX_DEPTH = 3;

/**
 * Spawn-transport precedence: the operator's PI_MAESTRO_TRANSPORT override
 * beats a per-spawn profile/runtime-policy transport, which beats the service
 * default. The escape hatch exists for harness/sandbox runs where no usable
 * tmux server matches the maestro's environment; a policy that pins tmux there
 * spawns children into the wrong world (the e2e's plan reviewer did exactly
 * that and died on the host's model catalog).
 */
export function resolveSpawnTransport(
	profileTransport: RunTransport | undefined,
	defaultTransport: RunTransport | undefined,
	env: NodeJS.ProcessEnv = process.env,
): RunTransport {
	const forced = env.PI_MAESTRO_TRANSPORT;
	if (forced === "headless" || forced === "tmux") return forced;
	return profileTransport ?? defaultTransport ?? "tmux";
}

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

	private readonly extraExtensions?: () => readonly string[];
	private readonly defaultTransport?: RunTransport;
	private readonly killProcessGroup: (
		processGroup: number,
		signal: NodeJS.Signals,
	) => void;
	private readonly tmuxSendKeys: (session: string, keys: string) => void;

	constructor(opts: SubagentServiceOptions) {
		this.bus = opts.bus;
		this.store = opts.store;
		this.runner = opts.runner;
		this.repoRoot = opts.repoRoot;
		this.spawnerCwd = opts.spawnerCwd;
		this.mintId = opts.mintId ?? defaultMintId;
		this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
		this.ownDepth = opts.ownDepth ?? currentDepth();
		this.extraExtensions = opts.extraExtensions;
		this.defaultTransport = opts.defaultTransport;
		this.killProcessGroup = opts.killProcessGroup ?? defaultKillProcessGroup;
		this.tmuxSendKeys = opts.tmuxSendKeys ?? defaultTmuxSendKeys;
	}

	spawn(prompt: string, profile: SpawnProfile): RunHandle {
		if (this.ownDepth >= this.maxDepth) {
			throw new Error(
				`subagent depth cap reached (${this.ownDepth}/${this.maxDepth})`,
			);
		}

		// Merge the configured passthrough extensions (deduped) so every
		// caller's children get e.g. custom model providers under -ne.
		const passthrough = this.extraExtensions?.() ?? [];
		if (passthrough.length > 0) {
			profile = {
				...profile,
				extraExtensions: [
					...new Set([...(profile.extraExtensions ?? []), ...passthrough]),
				],
			};
		}

		const runId = this.mintId();
		// Inspectable tmux runs are the default — pi-maestro requires tmux
		// (workers have always lived in it) and the transport-failure battery
		// covers the bridge. Headless is an explicit choice: per profile, per
		// service, or PI_MAESTRO_TRANSPORT=headless (see index.ts).
		const transport = resolveSpawnTransport(
			profile.transport,
			this.defaultTransport,
		);
		// Lineage is populated at the spawn boundary: a run spawning children
		// carries its own id in PI_MAESTRO_RUN_ID, so parent linkage (and with
		// it --children/--tree) works without every caller threading it.
		const parent =
			profile.parent ?? (process.env[RUN_ID_ENV] as RunId | undefined);
		profile = {
			...profile,
			transport,
			...(parent ? { parent } : {}),
			role: profile.role ?? profile.profile,
			displayName:
				profile.displayName ?? `${profile.role ?? profile.profile}-${runId}`,
			...(transport === "tmux"
				? {
						session: true,
						sessionFile:
							profile.sessionFile ??
							join(this.store.root, runId, "session.jsonl"),
					}
				: {}),
		};
		const ctx: SpawnContext = {
			spawnerCwd: this.spawnerCwd,
			repoRoot: this.repoRoot,
			parentDepth: this.ownDepth,
		};
		const invocation = mapProfileToInvocation(profile, ctx);

		// Announce the run first so the store has a record before the runner
		// emits any status/progress.
		this.bus.publish({
			type: "spawn",
			run: {
				id: runId,
				prompt,
				profile,
				...(profile.parent ? { parent: profile.parent } : {}),
			},
		});

		this.bus.publish({
			type: "metadata",
			runId,
			metadata: {
				transport,
				...(profile.parent ? { parent: profile.parent } : {}),
				...(profile.rootTurnId ? { rootTurnId: profile.rootTurnId } : {}),
				...(profile.sessionFile ? { sessionFile: profile.sessionFile } : {}),
				cwd: invocation.cwd,
				role: profile.role ?? profile.profile,
				displayName: profile.displayName ?? runId,
				...(profile.retainUntil ? { retainUntil: profile.retainUntil } : {}),
			},
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
			interrupt: (reason) => this.interrupt(runId, reason),
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
		const controller = this.controllers.get(runId);
		if (controller) {
			controller.steer(guidance);
			this.bus.publish({ type: "steer", runId, guidance });
			return;
		}
		this.steerViaTransport(runId, guidance);
	}

	async interrupt(runId: RunId, reason?: string): Promise<InterruptResult> {
		const controller = this.controllers.get(runId);
		if (!controller?.interrupt) {
			// The fallback is only for runs owned by ANOTHER process. A live
			// controller without interrupt support keeps the old contract.
			if (!controller) return this.interruptViaTransport(runId);
			return { outcome: "disconnected", targetId: `run:${runId}` };
		}
		this.bus.publish({ type: "interrupt", runId, reason, phase: "requested" });
		try {
			const result = await controller.interrupt(reason);
			this.bus.publish({
				type: "interrupt",
				runId,
				reason,
				phase: "acknowledged",
			});
			return result;
		} catch (error) {
			return {
				outcome: "disconnected",
				targetId: `run:${runId}`,
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}

	stop(runId: RunId, reason?: string): void {
		try {
			this.controllers.get(runId)?.stop(reason);
		} catch {
			// Stopping a settled run is a no-op; a transport error here must
			// never propagate into the caller (often a timer callback, where a
			// throw becomes an uncaught exception that kills pi).
		}
		this.bus.publish({ type: "stop", runId, reason });
	}

	async capture(runId: RunId, lines?: number): Promise<string | undefined> {
		const text = await this.controllers.get(runId)?.capture?.(lines);
		if (text) this.bus.publish({ type: "capture", runId, text });
		return text;
	}

	/**
	 * Transport-level steer for a run owned by another process. The tmux file
	 * bridge is append-only and the child's tail reads it regardless of which
	 * process appends — so a well-formed steer line reaches the child without
	 * an in-process controller. No-op for terminal/unknown runs.
	 */
	private steerViaTransport(runId: RunId, guidance: string): void {
		const record = this.store.readRecord(runId);
		if (!record || isTerminal(record.status)) return;
		if (record.metadata?.transport !== "tmux") return;
		// Host-minted id, disjoint from the owning supervisor's r<N> counter —
		// its pending map ignores response ids it never issued.
		const line = JSON.stringify({
			id: `xsteer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			type: "steer",
			message: guidance,
		});
		try {
			appendFileSync(
				join(this.store.root, runId, "rpc-input.jsonl"),
				`${line}\n`,
			);
		} catch {
			return; // Bridge file unwritable — nothing reachable to steer.
		}
		this.bus.publish({ type: "steer", runId, guidance });
	}

	/**
	 * Transport-level interrupt for a run owned by another process, derived
	 * from the persisted record: signal the recorded process group directly,
	 * falling back to C-c into the tmux session when only the session is
	 * known. Terminal runs are never signalled — their process facts are stale
	 * (pids recycle), so a signal could hit an unrelated process.
	 */
	private async interruptViaTransport(runId: RunId): Promise<InterruptResult> {
		const targetId = `run:${runId}`;
		const record = this.store.readRecord(runId);
		if (!record) return { outcome: "disconnected", targetId };
		if (isTerminal(record.status)) return { outcome: "already-idle", targetId };

		const metadata = record.metadata;
		const detail = "via transport (no in-process controller)";
		if (metadata?.processGroup) {
			try {
				this.killProcessGroup(metadata.processGroup, "SIGTERM");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				// ESRCH: already gone; EPERM: alive but not ours to signal —
				// either way the interrupt request itself stands.
				if (code !== "ESRCH" && code !== "EPERM") {
					return {
						outcome: "disconnected",
						targetId,
						detail: error instanceof Error ? error.message : String(error),
					};
				}
			}
			this.bus.publish({
				type: "status",
				runId,
				status: "interrupting",
				at: Date.now(),
			});
			return { outcome: "accepted", targetId, detail };
		}
		if (metadata?.tmuxSession) {
			try {
				this.tmuxSendKeys(metadata.tmuxSession, "C-c");
			} catch (error) {
				return {
					outcome: "disconnected",
					targetId,
					detail: error instanceof Error ? error.message : String(error),
				};
			}
			this.bus.publish({
				type: "status",
				runId,
				status: "interrupting",
				at: Date.now(),
			});
			return { outcome: "accepted", targetId, detail };
		}
		return { outcome: "disconnected", targetId };
	}
}

function defaultKillProcessGroup(
	processGroup: number,
	signal: NodeJS.Signals,
): void {
	process.kill(-processGroup, signal);
}

function defaultTmuxSendKeys(session: string, keys: string): void {
	const result = spawnSync("tmux", ["send-keys", "-t", session, keys], {
		stdio: "ignore",
		timeout: 5_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`tmux send-keys exited ${result.status}`);
	}
}

function defaultMintId(): RunId {
	const stamp = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `run-${stamp}-${rand}` as RunId;
}
