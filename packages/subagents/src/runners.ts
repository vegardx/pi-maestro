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

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { RpcClientOptions } from "@earendil-works/pi-coding-agent";
import type { RunId, RunResult } from "@vegardx/pi-contracts";
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
	abort(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: (event: AgentEvent) => void): () => void;
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
	/** Fired when a run settles (the background completion notification). */
	readonly onSettled?: (runId: RunId, result: RunResult) => void;
}

const DEFAULT_RESULT_CAP = 16 * 1024;

export function createAgentRunner(opts: RunnerOptions): AgentRunner {
	const cap = opts.resultCapBytes ?? DEFAULT_RESULT_CAP;

	return {
		launch(request: LaunchRequest, bus: RunBus): RunnerController {
			const abort = new AbortController();
			let client: RpcLike | undefined;
			// Liveness: bumped on every child event so a watchdog can tell a
			// stalled run (event silence) from a slow-but-working one.
			const activity = { at: Date.now() };

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
			).then((result) => {
				opts.onSettled?.(request.runId, result);
				return result;
			});

			return {
				steer(guidance: string) {
					void client?.steer?.(guidance);
				},
				stop() {
					abort.abort();
					void client?.abort();
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

async function execute(
	request: LaunchRequest,
	bus: RunBus,
	signal: AbortSignal,
	opts: RunnerOptions,
	cap: number,
	bindClient: (client: RpcLike) => void,
	activity?: { at: number },
): Promise<RunResult> {
	const { runId, prompt, invocation } = request;

	if (signal.aborted)
		return settle(bus, runId, stopped("aborted before start"));

	let release: (() => void) | undefined;
	let client: RpcLike | undefined;
	let unsubscribe: (() => void) | undefined;

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
			if (activity) activity.at = Date.now();
			mapEvent(bus, runId, event);
		});

		// Own the idle wait instead of client.waitForIdle: RpcClient's version
		// carries a hidden 60s DEFAULT timeout when called without one, which
		// killed every child that needed more than a minute of honest work.
		// One timeout owner: opts.timeoutMs (unset ⇒ no runner-level timeout —
		// callers like the research watchdog own stall/timeout policy).
		// Subscribed BEFORE prompt so a fast run can't end before we listen.
		const idle = waitUntilIdle(client);
		idle.catch(() => {}); // guard: abort/timeout may win the race first

		await client.start();
		bus.publish({ type: "status", runId, status: "running", at: Date.now() });

		await client.prompt(prompt);
		await raceAbort(withTimeout(idle, opts.timeoutMs), signal);

		if (signal.aborted) return settle(bus, runId, stopped("aborted"));

		const text = (await client.getLastAssistantText()) ?? "";
		return settle(bus, runId, {
			status: "succeeded",
			summary: capText(text, cap),
		});
	} catch (err) {
		if (signal.aborted) return settle(bus, runId, stopped("aborted"));
		return settle(bus, runId, {
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		unsubscribe?.();
		await client?.stop().catch(() => {});
		release?.();
	}
}

/** How often the idle wait probes for a silently dead child process. */
const DEAD_POLL_MS = 5_000;

/**
 * Resolve when the child reports `agent_end`; reject when its process dies.
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
			if (event.type === "agent_end") {
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

function mapEvent(bus: RunBus, runId: RunId, event: AgentEvent): void {
	// Forward all events for live-view subscribers.
	bus.publish({ type: "agentEvent", runId, event });
	// Keep the progress shortcut for the widget.
	if (event.type === "tool_execution_start") {
		bus.publish({
			type: "progress",
			runId,
			delta: { text: event.toolName },
		});
	}
	// Token progress: assistant messages carry per-turn usage. Best-effort —
	// absent usage just means no token delta for this turn.
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
		if (usage && (usage.input !== undefined || usage.output !== undefined)) {
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
		timer = setTimeout(() => reject(new Error("run timed out")), timeoutMs);
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
function raceAbort(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => resolve();
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}
