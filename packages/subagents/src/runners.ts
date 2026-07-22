// AgentRunner backed by an RpcClient subprocess. It maps the child's event
// stream onto the run-bus (status/progress/result), gates concurrency through
// the shared semaphore, caps the captured result, and propagates abort +
// timeout. The RpcClient is injected behind a minimal RpcLike interface so the
// runner tests without spawning real processes.
//
// Foreground vs background is the caller's choice of whether to await
// result(): a foreground run is awaited within the turn; a background run is
// fire-and-forget with onSettled firing the completion notification. The
// mechanics are identical, so one runner serves both.

import type {
	AgentSessionEvent,
	RpcClientOptions,
} from "@earendil-works/pi-coding-agent";
import type {
	InterruptResult,
	RunId,
	RunResult,
	RunWatchdogConfig,
} from "@vegardx/pi-contracts";
import type { RunBus } from "./bus.js";
import type { Semaphore } from "./semaphore.js";
import type {
	AgentRunner,
	LaunchRequest,
	RunnerController,
} from "./service.js";
import { RUN_ID_ENV } from "./supervisor.js";

/** The slice of RpcClient the runner uses. */
export interface RpcLike {
	start(): Promise<void>;
	prompt(message: string): Promise<void>;
	steer?(message: string): Promise<void>;
	/** Queue a message processed after the current turn — the `ask` transport
	 *  for persistent standby children. */
	followUp?(message: string): Promise<void>;
	abort(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: (event: AgentSessionEvent) => void): () => void;
	getLastAssistantText(): Promise<string | null>;
}

export type ClientFactory = (options: RpcClientOptions) => RpcLike;

export interface RunnerOptions {
	readonly factory: ClientFactory;
	readonly semaphore: Semaphore;
	/** CLI entry point for the child (RpcClientOptions.cliPath). */
	readonly cliPath?: string;
	/** Base env merged under the invocation's explicit maestro-flag env. */
	readonly baseEnv?: Record<string, string>;
	/** Cap captured result text. Default 16 KiB. */
	readonly resultCapBytes?: number;
	/** Idle timeout for a run. Default none. */
	readonly timeoutMs?: number;
	/** Transport startup/readiness deadline (client.start). Default 20s. */
	readonly startupTimeoutMs?: number;
	/** Deadline for each individual RPC request (prompt/abort/getLast…).
	 *  This bounds the request ACK, not the child's thinking time — the run
	 *  itself is bounded by watchdog/timeoutMs. Default 30s. */
	readonly rpcTimeoutMs?: number;
	/** Fired when a run settles (the background completion notification). */
	readonly onSettled?: (runId: RunId, result: RunResult) => void;
}

const DEFAULT_RESULT_CAP = 16 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** A deadline kill — settles the run `timed-out`, distinct from `failed`. */
export class DeadlineError extends Error {
	constructor(boundary: string, ms: number) {
		super(`${boundary} deadline exceeded (${Math.round(ms / 1000)}s)`);
		this.name = "DeadlineError";
	}
}

/** One run's settle-once latch, shared between execute() and the controller. */
interface Lifecycle {
	settled: boolean;
	interruptPublished: boolean;
}

export function createAgentRunner(opts: RunnerOptions): AgentRunner {
	const cap = opts.resultCapBytes ?? DEFAULT_RESULT_CAP;

	return {
		launch(request: LaunchRequest, bus: RunBus): RunnerController {
			if (request.profile.standby)
				return launchStandby(request, bus, opts, cap);
			const abort = new AbortController();
			const rpcMs = opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
			let client: RpcLike | undefined;
			// Liveness: bumped on every child event so a watchdog can tell a
			// stalled run (event silence) from a slow-but-working one.
			const activity = { at: Date.now() };
			const lifecycle: Lifecycle = {
				settled: false,
				interruptPublished: false,
			};

			const done = execute(
				request,
				bus,
				abort.signal,
				opts,
				cap,
				(c) => {
					client = c;
				},
				activity,
				lifecycle,
			).then((result) => {
				opts.onSettled?.(request.runId, result);
				return result;
			});

			return {
				steer(guidance: string) {
					try {
						asFireAndForget(client?.steer?.(guidance));
					} catch {
						// Steering a finished run is a no-op.
					}
				},
				interrupt: makeInterrupt(
					request,
					bus,
					abort,
					lifecycle,
					() => client,
					rpcMs,
				),
				stop(reason?: string) {
					// Fire-and-forget interrupt. Never throws out of a timer callback
					// (the RPC client throws synchronously once its transport is gone;
					// that escaped as an uncaught post-/handoff crash before).
					this.interrupt?.(reason)?.catch(() => {});
				},
				result: () => done,
				lastEventAt: () => activity.at,
				async partialText() {
					if (!client) return undefined;
					try {
						return (await client.getLastAssistantText()) ?? undefined;
					} catch {
						return undefined;
					}
				},
			};
		},
	};
}

/**
 * Shared interrupt: settle-once, publish `interrupting`, salvage the last text
 * BEFORE aborting (abort kills the child), then abort. Used by both the
 * one-shot and standby controllers so their interrupt semantics are identical.
 */
function makeInterrupt(
	request: LaunchRequest,
	bus: RunBus,
	abort: AbortController,
	lifecycle: Lifecycle,
	getClient: () => RpcLike | undefined,
	rpcMs: number,
): (reason?: string) => Promise<InterruptResult> {
	return async (reason?: string): Promise<InterruptResult> => {
		const targetId = `run:${request.runId}`;
		// Interrupt settles once: after settlement it is a no-op report, and a
		// second interrupt while one is in flight is acknowledged, not repeated.
		if (lifecycle.settled) return { outcome: "already-idle", targetId };
		if (lifecycle.interruptPublished)
			return { outcome: "already-interrupting", targetId };
		lifecycle.interruptPublished = true;
		bus.publish({
			type: "status",
			runId: request.runId,
			status: "interrupting",
			at: Date.now(),
		});
		let partialText: string | undefined;
		const client = getClient();
		if (client) {
			try {
				partialText =
					(
						await deadline(client.getLastAssistantText(), rpcMs, "salvage")
					)?.trim() || undefined;
			} catch {
				// best-effort salvage
			}
		}
		abort.abort(reason);
		try {
			await deadline(getClient()?.abort() ?? Promise.resolve(), rpcMs, "abort");
		} catch {
			// The process may have settled between observation and abort.
		}
		return {
			outcome: "accepted",
			targetId,
			...(reason ? { detail: reason } : {}),
			...(partialText ? { partialText } : {}),
		};
	};
}

/** One pending `ask`: a message and the promise settlers for its reply turn. */
interface AskRequest {
	readonly message: string;
	resolve(text: string): void;
	reject(err: unknown): void;
}

/**
 * A single-consumer FIFO channel between the standby controller's `ask` and the
 * standby run loop. Idle between asks (no busy-wait); `close()` drains pending
 * asks with a rejection so no caller hangs after the run settles.
 */
class AskChannel {
	private readonly queue: AskRequest[] = [];
	private waiter?: (req: AskRequest | undefined) => void;
	private closed = false;

	push(req: AskRequest): void {
		if (this.closed) {
			req.reject(new Error("run has settled — cannot ask"));
			return;
		}
		if (this.waiter) {
			const waiter = this.waiter;
			this.waiter = undefined;
			waiter(req);
			return;
		}
		this.queue.push(req);
	}

	/** Resolves with the next ask, or `undefined` once the channel closes. */
	next(): Promise<AskRequest | undefined> {
		const queued = this.queue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.closed) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			this.waiter = resolve;
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.waiter) {
			const waiter = this.waiter;
			this.waiter = undefined;
			waiter(undefined);
		}
		for (const req of this.queue.splice(0))
			req.reject(new Error("run has settled — cannot ask"));
	}
}

/**
 * Persistent standby controller. The child is launched, given its initial
 * prompt, then KEPT ALIVE: each `ask` delivers a follow-up, waits for the child
 * to go idle, and resolves with that turn's assistant text. The slot is held
 * for the whole standby lifetime (slot-yield lands in a later phase); the run
 * settles when interrupted/stopped or its parent ends. See
 * docs/design/multi-model-agents.md §4.
 */
function launchStandby(
	request: LaunchRequest,
	bus: RunBus,
	opts: RunnerOptions,
	cap: number,
): RunnerController {
	const abort = new AbortController();
	const rpcMs = opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
	let client: RpcLike | undefined;
	const activity = { at: Date.now() };
	const lifecycle: Lifecycle = { settled: false, interruptPublished: false };
	const channel = new AskChannel();

	const done = executeStandby(
		request,
		bus,
		abort.signal,
		opts,
		cap,
		(c) => {
			client = c;
		},
		activity,
		lifecycle,
		channel,
	).then((result) => {
		opts.onSettled?.(request.runId, result);
		return result;
	});

	return {
		steer(guidance: string) {
			try {
				asFireAndForget(client?.steer?.(guidance));
			} catch {
				// Steering a finished run is a no-op.
			}
		},
		ask(message: string): Promise<string> {
			if (lifecycle.settled || abort.signal.aborted)
				return Promise.reject(new Error("run has settled — cannot ask"));
			return new Promise<string>((resolve, reject) =>
				channel.push({ message, resolve, reject }),
			);
		},
		interrupt: makeInterrupt(
			request,
			bus,
			abort,
			lifecycle,
			() => client,
			rpcMs,
		),
		stop(reason?: string) {
			this.interrupt?.(reason)?.catch(() => {});
		},
		result: () => done,
		lastEventAt: () => activity.at,
		async partialText() {
			if (!client) return undefined;
			try {
				return (await client.getLastAssistantText()) ?? undefined;
			} catch {
				return undefined;
			}
		},
	};
}

/** Deliver one turn: subscribe to idle BEFORE sending, send, await idle. */
async function runTurn(
	client: RpcLike,
	send: () => Promise<void>,
	rpcMs: number,
	signal: AbortSignal,
): Promise<void> {
	const idle = waitUntilIdle(client);
	idle.catch(() => {}); // abort may win the race first
	await deadline(send(), rpcMs, "prompt request");
	await raceAbort(idle, signal);
}

/** Next ask, or `undefined` when the run aborts or the child process dies. */
function raceAsk(
	channel: AskChannel,
	client: RpcLike,
	signal: AbortSignal,
): Promise<AskRequest | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		let settled = false;
		const cleanup = (): void => {
			signal.removeEventListener("abort", onAbort);
			if (timer) clearInterval(timer);
		};
		const finish = (v: AskRequest | undefined): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(v);
		};
		const onAbort = (): void => finish(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		const timer = setInterval(() => {
			if ((client as { exitError?: Error | null }).exitError) finish(undefined);
		}, DEAD_POLL_MS);
		timer.unref?.();
		void channel.next().then(finish);
	});
}

async function executeStandby(
	request: LaunchRequest,
	bus: RunBus,
	signal: AbortSignal,
	opts: RunnerOptions,
	cap: number,
	bindClient: (client: RpcLike) => void,
	activity: { at: number },
	lifecycle: Lifecycle,
	channel: AskChannel,
): Promise<RunResult> {
	const { runId, prompt, invocation } = request;
	const done = (result: RunResult): RunResult => {
		lifecycle.settled = true;
		return settle(bus, runId, result);
	};
	if (signal.aborted) return done(stopped("aborted before start"));

	let release: (() => void) | undefined;
	let client: RpcLike | undefined;
	let unsubscribe: (() => void) | undefined;
	const rpcMs = opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

	try {
		release = await opts.semaphore.acquire(signal);

		const options: RpcClientOptions = {
			cliPath: opts.cliPath,
			cwd: invocation.cwd,
			model: invocation.model,
			args: invocation.args,
			env: { ...opts.baseEnv, ...invocation.env, [RUN_ID_ENV]: runId },
		};
		client = opts.factory(options);
		bindClient(client);
		if (!client.followUp)
			throw new Error(
				"transport does not support follow-up (standby ask requires a persistent RPC child)",
			);
		// Bind follow-up off the narrowed `client`, then alias to a const so the
		// mutable `client` narrows inside the turn closures; the outer `client`
		// stays for the catch/finally undefined-tolerant paths.
		const followUp = client.followUp.bind(client);
		const session = client;

		unsubscribe = session.onEvent((event) => {
			activity.at = Date.now();
			mapEvent(bus, runId, event);
		});
		bus.publish({ type: "status", runId, status: "starting", at: Date.now() });

		// Startup + initial prompt, bounded by the startup deadline and abort.
		await raceAbort(
			(async () => {
				await deadline(
					session.start(),
					opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
					"startup",
				);
				bus.publish({
					type: "status",
					runId,
					status: "running",
					at: Date.now(),
				});
				await runTurn(session, () => session.prompt(prompt), rpcMs, signal);
			})(),
			signal,
		);

		// Standby loop: park idle (0 tokens) until the next ask, then run one
		// follow-up turn and hand its text back to that ask's caller.
		while (!signal.aborted) {
			// Slot-yield (docs/design/multi-model-agents.md §7): a standby run
			// blocked waiting for its next ask must NOT count against concurrency,
			// or idle parents starve the leaves. Release the permit while parked
			// (→ blocked) and re-acquire on resume (→ running).
			if (release) {
				release();
				release = undefined;
				bus.publish({
					type: "status",
					runId,
					status: "blocked",
					at: Date.now(),
				});
			}
			const req = await raceAsk(channel, session, signal);
			if (!req) break; // aborted, stopped, or the child process died
			try {
				release = await opts.semaphore.acquire(signal);
				bus.publish({
					type: "status",
					runId,
					status: "running",
					at: Date.now(),
				});
				await runTurn(session, () => followUp(req.message), rpcMs, signal);
				if (signal.aborted) {
					req.reject(new Error("run interrupted"));
					break;
				}
				const text =
					(
						await deadline(
							session.getLastAssistantText(),
							rpcMs,
							"result request",
						).catch(() => null)
					)?.trim() ?? "";
				req.resolve(capText(text, cap));
			} catch (err) {
				// A failed re-acquire (aborted) or turn error rejects this ask; the
				// loop guard then exits on the aborted signal.
				req.reject(err instanceof Error ? err : new Error(String(err)));
				if ((session as { exitError?: Error | null }).exitError) break;
			}
		}

		const text = (
			await deadline(
				session.getLastAssistantText(),
				rpcMs,
				"result request",
			).catch(() => null)
		)?.trim();
		if (signal.aborted)
			return done({
				status: "stopped",
				error: abortReason(signal),
				...(text ? { summary: capText(text, cap) } : {}),
			});
		return done({
			status: "succeeded",
			...(text ? { summary: capText(text, cap) } : {}),
		});
	} catch (err) {
		if (signal.aborted) {
			const partial = client
				? (
						await deadline(
							client.getLastAssistantText(),
							rpcMs,
							"salvage",
						).catch(() => null)
					)?.trim()
				: undefined;
			return done({
				status: "stopped",
				error: abortReason(signal),
				...(partial ? { summary: capText(partial, cap) } : {}),
			});
		}
		if (err instanceof DeadlineError)
			return done({ status: "timed-out", error: err.message });
		return done({
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		channel.close();
		unsubscribe?.();
		await client?.stop().catch(() => {});
		release?.();
	}
}

async function execute(
	request: LaunchRequest,
	bus: RunBus,
	signal: AbortSignal,
	opts: RunnerOptions,
	cap: number,
	bindClient: (client: RpcLike) => void,
	activity: { at: number },
	lifecycle: Lifecycle,
): Promise<RunResult> {
	const { runId, prompt, invocation } = request;
	const done = (result: RunResult): RunResult => {
		lifecycle.settled = true;
		return settle(bus, runId, result);
	};

	if (signal.aborted) return done(stopped("aborted before start"));

	let release: (() => void) | undefined;
	let client: RpcLike | undefined;
	let unsubscribe: (() => void) | undefined;
	const rpcMs = opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

	try {
		release = await opts.semaphore.acquire(signal);

		const options: RpcClientOptions = {
			cliPath: opts.cliPath,
			cwd: invocation.cwd,
			model: invocation.model,
			args: invocation.args,
			// baseEnv first, then the invocation's explicit maestro flags, then the
			// run id so the child's contact_supervisor tool can tag its messages.
			env: { ...opts.baseEnv, ...invocation.env, [RUN_ID_ENV]: runId },
		};
		client = opts.factory(options);
		bindClient(client);

		unsubscribe = client.onEvent((event) => {
			activity.at = Date.now();
			mapEvent(bus, runId, event);
		});

		bus.publish({ type: "status", runId, status: "starting", at: Date.now() });

		// Own the idle wait instead of client.waitForIdle: RpcClient's version
		// carries a hidden 60s DEFAULT timeout when called without one, which
		// killed every child that needed more than a minute of honest work.
		// One timeout owner: opts.timeoutMs (unset ⇒ no runner-level timeout —
		// per-run policy comes from profile.watchdog below).
		// Subscribed BEFORE prompt so a fast run can't end before we listen.
		const idle = waitUntilIdle(client);
		idle.catch(() => {}); // guard: abort/timeout may win the race first

		// Startup, the initial prompt, and the idle wait all run INSIDE the
		// watchdog/timeout race. These were awaited bare before it, so a child
		// that wedged during startup or never acked the first prompt hung the
		// run with no protection at all — liveness must exist before the first
		// transport await, not after it. The per-request deadlines bound the
		// ACK of each RPC; the child's actual work is bounded by the watchdog.
		const body = (async () => {
			await deadline(
				client.start(),
				opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
				"startup",
			);
			bus.publish({ type: "status", runId, status: "running", at: Date.now() });
			await deadline(client.prompt(prompt), rpcMs, "prompt request");
			await idle;
		})();
		body.catch(() => {}); // raced below; abort/trip may win first

		// Per-run liveness watchdog (profile.watchdog): stall kills wedged
		// children fast, the soft deadline steers slow ones to wrap up, the
		// hard cap backstops unbounded runs. Applied here so EVERY child —
		// research, named agents, general delegates — gets one implementation.
		const wd = request.profile.watchdog;
		let tripped: string | undefined;
		if (wd) {
			tripped = await raceAbort(
				withTimeout(raceWatchdog(body, wd, client, activity), opts.timeoutMs),
				signal,
			);
		} else {
			await raceAbort(
				withTimeout(
					body.then(() => undefined),
					opts.timeoutMs,
				),
				signal,
			);
		}

		if (signal.aborted) {
			// Explicit interrupt: salvage what the child had (bounded — a wedged
			// transport must not hang the settle) and settle stopped, terminal.
			const partial = (
				await deadline(client.getLastAssistantText(), rpcMs, "salvage").catch(
					() => null,
				)
			)?.trim();
			return done({
				status: "stopped",
				error: abortReason(signal),
				...(partial ? { summary: capText(partial, cap) } : {}),
			});
		}

		if (tripped) {
			// Salvage BEFORE aborting — abort kills the child process. The
			// partial text is diagnostic material for the caller; consumers
			// (for example a typed review stage) must never accept it as a valid report.
			const partial = (
				await deadline(client.getLastAssistantText(), rpcMs, "salvage").catch(
					() => null,
				)
			)?.trim();
			await deadline(client.abort(), rpcMs, "abort request").catch(() => {});
			return done({
				status: "timed-out",
				error: tripped,
				...(partial ? { summary: capText(partial, cap) } : {}),
			});
		}

		const text =
			(await deadline(
				client.getLastAssistantText(),
				rpcMs,
				"result request",
			).catch(() => null)) ?? "";
		return done({
			status: "succeeded",
			summary: capText(text, cap),
		});
	} catch (err) {
		// Explicit interrupt is terminal and wins over whatever the abort broke
		// mid-flight; deadline kills settle timed-out; everything else failed
		// (including child death, which rejects the idle wait and thereby every
		// pending operation of this run).
		if (signal.aborted) {
			const partial = client
				? (
						await deadline(
							client.getLastAssistantText(),
							rpcMs,
							"salvage",
						).catch(() => null)
					)?.trim()
				: undefined;
			return done({
				status: "stopped",
				error: abortReason(signal),
				...(partial ? { summary: capText(partial, cap) } : {}),
			});
		}
		if (err instanceof DeadlineError) {
			return done({ status: "timed-out", error: err.message });
		}
		return done({
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		unsubscribe?.();
		await client?.stop().catch(() => {});
		release?.();
	}
}

/**
 * Race the run body (startup → prompt → idle) against the run's watchdog
 * thresholds. Resolves `undefined` when the run finishes on its own, or a
 * human-readable trip reason when the watchdog fires (stall / hard cap). The
 * soft deadline doesn't trip — it steers the child ONCE to wrap up and keeps
 * waiting. A trip settles the run `timed-out`; it is never retried.
 */
function raceWatchdog(
	idle: Promise<void>,
	wd: RunWatchdogConfig,
	client: RpcLike,
	activity: { at: number },
): Promise<string | undefined> {
	const startedAt = Date.now();
	const thresholds = [wd.stallMs, wd.softMs, wd.hardMs].filter(
		(n): n is number => typeof n === "number" && n > 0,
	);
	if (thresholds.length === 0) return idle.then(() => undefined);
	// Poll fast enough to honor the tightest threshold (tests use tiny ones).
	const pollMs = Math.max(
		1,
		Math.min(5_000, Math.floor(Math.min(...thresholds) / 4)),
	);
	let steered = false;
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const finish = (v: string | undefined): void => {
			if (timer) clearInterval(timer);
			resolve(v);
		};
		idle.then(
			() => finish(undefined),
			(err) => {
				if (timer) clearInterval(timer);
				reject(err);
			},
		);
		timer = setInterval(() => {
			const now = Date.now();
			if (wd.stallMs && now - activity.at > wd.stallMs) {
				finish(
					`stalled: no activity for ${Math.round((now - activity.at) / 1000)}s`,
				);
				return;
			}
			if (wd.hardMs && now - startedAt > wd.hardMs) {
				finish(
					`hard cap: still running after ${Math.round(wd.hardMs / 1000)}s`,
				);
				return;
			}
			if (
				!steered &&
				wd.softMs &&
				wd.wrapUpSteer &&
				now - startedAt > wd.softMs
			) {
				steered = true;
				void client.steer?.(wd.wrapUpSteer);
			}
		}, pollMs);
		timer.unref?.();
	});
}

/** How often the idle wait probes for a silently dead child process. */
const DEAD_POLL_MS = 5_000;

/**
 * Resolve when the child reports `agent_settled`; reject when its process dies.
 * RpcClient rejects pending send() requests on exit but never notifies
 * onEvent subscribers, so a child dying mid-run (no outstanding request)
 * would hang a bare event wait forever — poll the client's `exitError`
 * (set on process exit/error) to catch that.
 */
function waitUntilIdle(client: RpcLike, pollMs = DEAD_POLL_MS): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const cleanup = (): void => {
			if (timer) clearInterval(timer);
			unsub();
		};
		const unsub = client.onEvent((event) => {
			if (event.type === "agent_settled") {
				cleanup();
				resolve();
			}
		});
		const checkDead = (): void => {
			const err = (client as { exitError?: Error | null }).exitError;
			if (err) {
				cleanup();
				reject(err);
			}
		};
		timer = setInterval(checkDead, pollMs);
		timer.unref?.();
		checkDead(); // it may already be dead
	});
}

function mapEvent(bus: RunBus, runId: RunId, event: AgentSessionEvent): void {
	// Lifecycle events only. Children stream token-by-token deltas
	// (thinking/text/message_update) at hundreds of messages per second per
	// run; forwarding them onto the host bus meant a synchronous events.jsonl
	// append AND a status.json rewrite per token, across every parallel run —
	// the maestro's event loop drowned (221MB of delta logs, laggy TUI,
	// 2026-07-15 dogfood). Nothing consumes them: watchdog liveness is
	// tracked in the runner's own onEvent (before this filter), salvage uses
	// getLastAssistantText, and live inspection watches the tmux pane.
	if (event.type === "tool_execution_start") {
		bus.publish({ type: "agentEvent", runId, event });
		// Keep the progress shortcut for the widget.
		bus.publish({
			type: "progress",
			runId,
			delta: { text: event.toolName },
		});
		return;
	}
	if (event.type === "agent_end") {
		bus.publish({ type: "agentEvent", runId, event });
		return;
	}
	// Token progress: assistant messages carry per-turn usage. Best-effort —
	// absent usage just means no token delta for this turn. The full message
	// body stays OUT of the bus/journal (it already lives in the child's
	// session file); only the usage numbers travel.
	if (event.type === "turn_end") {
		const usage = (
			event.message as {
				usage?: {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					cost?: { total?: number };
				};
			}
		)?.usage;
		bus.publish({
			type: "agentEvent",
			runId,
			event: { type: "turn_end", ...(usage ? { message: { usage } } : {}) },
		});
		if (
			usage &&
			(usage.input !== undefined ||
				usage.output !== undefined ||
				usage.cacheRead !== undefined ||
				usage.cacheWrite !== undefined ||
				usage.cost?.total !== undefined)
		) {
			bus.publish({
				type: "progress",
				runId,
				delta: {
					tokensIn: usage.input,
					tokensOut: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					cost: usage.cost?.total,
				},
			});
		}
	}
}

function settle(bus: RunBus, runId: RunId, result: RunResult): RunResult {
	bus.publish({ type: "status", runId, status: result.status, at: Date.now() });
	bus.publish({ type: "result", runId, result });
	return result;
}

function abortReason(signal: AbortSignal): string {
	return typeof signal.reason === "string" && signal.reason.trim()
		? signal.reason
		: "aborted";
}

function stopped(reason: string): RunResult {
	return { status: "stopped", error: reason };
}

function capText(text: string, cap: number): string {
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}\n…[truncated]`;
}

async function withTimeout<T>(
	work: Promise<T>,
	timeoutMs: number | undefined,
): Promise<T> {
	if (!timeoutMs) return work;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new DeadlineError("run", timeoutMs)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Bound one transport await; rejection carries the boundary that tripped. */
async function deadline<T>(
	work: Promise<T>,
	ms: number,
	boundary: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new DeadlineError(boundary, ms)), ms);
		timer.unref?.();
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// Resolve when the work finishes OR the signal aborts, whichever comes first.
// On abort the caller re-checks signal.aborted and settles as stopped; the
// orphaned work promise is left to unwind on its own (the client is aborted in
// the finally block).
function raceAbort<T>(
	work: Promise<T>,
	signal: AbortSignal,
): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise<T | undefined>((resolve, reject) => {
		const onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

/** Detach a possibly-undefined promise, swallowing its rejection. */
function asFireAndForget(p: Promise<unknown> | undefined): void {
	void p?.catch?.(() => {});
}
