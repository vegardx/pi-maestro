// Detached-tmux transport for one-shot subagents. The child still speaks pi's
// JSONL RPC protocol, but stdin/stdout are bridged through append-only files so
// the actual pi process (and its terminal output) lives in an inspectable tmux
// session rather than as an opaque child of the host.
//
// Hardening contract (dogfood post-mortems, 2026-07-15):
//   - the initial prompt can never be lost: the bridge tails the input file
//     FROM THE BEGINNING (-n +1) and start() completes only after the bridge
//     proves it is up (ready marker observed in the output stream);
//   - every RPC request carries its own deadline and removes its pending
//     entry on expiry — no unbounded pending map;
//   - child death is detected (process-group liveness probe) and rejects
//     every pending request, whether or not one was in flight;
//   - output is drained with positional incremental reads on an open
//     descriptor — never a re-read of the whole growing file;
//   - the transport publishes only process facts (pid/session/pane); the
//     caller's role/displayName identity from the service is never touched;
//   - executable discovery mirrors the proven headless runner: runnable
//     script → packaged executable (process.execPath, /$bunfs/) → pi from
//     PATH; failures surface as bounded startup errors, not hangs.

import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	AgentSessionEvent,
	RpcClientOptions,
} from "@earendil-works/pi-coding-agent";
import type { RunId, RunProcessMetadata } from "@vegardx/pi-contracts";
import { capturePane, shellEscape, spawn, tmuxExec } from "@vegardx/pi-tmux";
import type { RunBus } from "./bus.js";
import {
	createAgentRunner,
	DeadlineError,
	type RpcLike,
	type RunnerOptions,
} from "./runners.js";
import type {
	AgentRunner,
	LaunchRequest,
	RunnerController,
} from "./service.js";

export interface TmuxRunnerOptions extends Omit<RunnerOptions, "factory"> {
	readonly runsRoot: string;
	readonly tmux?: {
		spawn: typeof spawn;
		capturePane: typeof capturePane;
		exec: typeof tmuxExec;
	};
	/** Child-death probe cadence (tests tighten it). Default 1s. */
	readonly alivePollMs?: number;
}

/** Deadline for one bridge RPC request (ack, not the child's work). */
const TMUX_RPC_TIMEOUT_MS = 10_000;
/** How often the liveness probe checks the child process group. */
const ALIVE_POLL_MS = 1_000;
/** SIGTERM → SIGKILL escalation grace on stop(). */
const KILL_GRACE_MS = 3_000;
/** The bridge's first output line — proof the session shell is up. */
const READY_MARKER = '{"type":"bridge_ready"}';

export function createTmuxAgentRunner(opts: TmuxRunnerOptions): AgentRunner {
	return {
		launch(request: LaunchRequest, bus: RunBus): RunnerController {
			let client: TmuxRpcClient | undefined;
			const runner = createAgentRunner({
				...opts,
				factory: (rpcOptions) => {
					client = new TmuxRpcClient(
						rpcOptions,
						request.runId,
						opts.runsRoot,
						opts.tmux,
						(metadata) =>
							bus.publish({ type: "metadata", runId: request.runId, metadata }),
						opts.rpcTimeoutMs ?? TMUX_RPC_TIMEOUT_MS,
						opts.alivePollMs ?? ALIVE_POLL_MS,
					);
					return client;
				},
			});
			const inner = runner.launch(request, bus);
			return {
				...inner,
				capture: (lines) =>
					client ? client.capture(lines) : Promise.resolve(undefined),
			};
		},
	};
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

/**
 * Resolve how the bridged child is executed, mirroring the headless runner's
 * discovery order: a node-runnable script when the host provides one, the
 * packaged executable when running from a bundled snapshot (/$bunfs/), and
 * `pi` from PATH otherwise (TypeScript/jiti development, where argv[1] is not
 * node-runnable). A missing executable fails the pipeline immediately, which
 * the liveness probe turns into a bounded, explicit startup error.
 */
export function resolveChildArgv(cliPath: string | undefined): string[] {
	if (cliPath && /\.(cjs|mjs|js)$/.test(cliPath)) return ["node", cliPath];
	if (process.argv[1]?.startsWith("/$bunfs/")) return [process.execPath];
	return ["pi"];
}

class TmuxRpcClient implements RpcLike {
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly pending = new Map<string, Pending>();
	private readonly runDir: string;
	private readonly input: string;
	private readonly output: string;
	private readonly stderr: string;
	private readonly session: string;
	private offset = 0;
	private outputFd: number | undefined;
	private remainder = "";
	private timer: ReturnType<typeof setInterval> | undefined;
	private aliveTimer: ReturnType<typeof setInterval> | undefined;
	private requestId = 0;
	private lastAssistant = "";
	private stopped = false;
	private bridgeReady = false;
	// Read by the generic runner's waitUntilIdle probe (same contract as the
	// headless RpcClient): non-null means the child is gone.
	private exitError: Error | null = null;
	private probing = false;
	private processGroup: number | undefined;
	private readonly tmux;

	constructor(
		private readonly options: RpcClientOptions,
		runId: RunId,
		runsRoot: string,
		tmux: TmuxRunnerOptions["tmux"],
		private readonly onMetadata: (metadata: RunProcessMetadata) => void,
		private readonly rpcTimeoutMs: number = TMUX_RPC_TIMEOUT_MS,
		private readonly alivePollMs: number = ALIVE_POLL_MS,
	) {
		this.runDir = join(runsRoot, runId);
		this.input = join(this.runDir, "rpc-input.jsonl");
		this.output = join(this.runDir, "rpc-output.jsonl");
		this.stderr = join(this.runDir, "stderr.log");
		this.session = sanitizeSession(`maestro-run-${runId}`);
		this.tmux = tmux ?? { spawn, capturePane, exec: tmuxExec };
	}

	async start(): Promise<void> {
		mkdirSync(this.runDir, { recursive: true });
		writeFileSync(this.input, "");
		writeFileSync(this.output, "");
		writeFileSync(this.stderr, "");
		const argv = resolveChildArgv(this.options.cliPath);
		argv.push("--mode", "rpc");
		if (this.options.model) argv.push("--model", this.options.model);
		argv.push(...(this.options.args ?? []));
		// Ready marker first (proves shell + writable output), then the bridge.
		// tail reads the input FROM THE BEGINNING: a prompt appended before
		// tail opens the file is still delivered — the -n 0 race lost it.
		const command =
			`printf '%s\\n' ${shellEscape(READY_MARKER)} >> ${shellEscape(this.output)}; ` +
			`tail -n +1 -F ${shellEscape(this.input)} | ` +
			`${argv.map(shellEscape).join(" ")} ` +
			`2>>${shellEscape(this.stderr)} | tee -a ${shellEscape(this.output)}`;
		await this.tmux.spawn(
			this.session,
			this.options.cwd ?? process.cwd(),
			command,
			{
				env: this.options.env,
			},
		);
		this.outputFd = openSync(this.output, "r");
		this.timer = setInterval(() => this.drain(), 25);
		this.timer.unref?.();
		this.aliveTimer = setInterval(
			() => void this.checkAlive(),
			this.alivePollMs,
		);
		this.aliveTimer.unref?.();
		let pid: number | undefined;
		let pane: string | undefined;
		try {
			const raw = await this.tmux.exec([
				"display-message",
				"-p",
				"-t",
				this.session,
				"#{pane_pid}:#{pane_id}",
			]);
			const [pidText, paneId] = raw.trim().split(":");
			pid = Number(pidText) || undefined;
			this.processGroup = pid;
			pane = paneId || undefined;
		} catch {
			// Session remains usable even if metadata probing races startup.
		}
		// Process facts only — the service already published the caller's
		// role/displayName identity; a transport must never overwrite it.
		this.onMetadata({
			transport: "tmux",
			...(pid ? { pid, processGroup: pid } : {}),
			tmuxSession: this.session,
			...(pane ? { tmuxPane: pane } : {}),
			...(this.sessionFileArg() ? { sessionFile: this.sessionFileArg() } : {}),
			cwd: this.options.cwd,
		});
		// Readiness handshake: start() completes only once the bridge proves
		// it is up. The generic runner's startup deadline bounds this wait.
		while (!this.bridgeReady) {
			if (this.exitError) throw this.exitError;
			if (this.stopped) throw new Error("tmux run stopped during startup");
			await delay(25);
		}
	}

	prompt(message: string): Promise<void> {
		return this.send({ type: "prompt", message }).then(() => undefined);
	}
	steer(message: string): Promise<void> {
		return this.send({ type: "steer", message }).then(() => undefined);
	}
	abort(): Promise<void> {
		return this.send({ type: "abort" }).then(() => undefined);
	}
	onEvent(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async getLastAssistantText(): Promise<string | null> {
		try {
			const response = (await this.send({
				type: "get_last_assistant_text",
			})) as {
				data?: { text?: string } | string;
			};
			if (typeof response.data === "string") return response.data;
			return response.data?.text ?? (this.lastAssistant || null);
		} catch {
			return this.lastAssistant || null;
		}
	}
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		if (this.aliveTimer) clearInterval(this.aliveTimer);
		this.drain();
		if (this.outputFd !== undefined) {
			closeSync(this.outputFd);
			this.outputFd = undefined;
		}
		// Preserve the pane for bounded post-mortem inspection. Terminate the
		// process group (SIGTERM, escalating to SIGKILL after a grace), but
		// leave tmux's dead pane/session retained; retention later kills the
		// session and verifies it is gone BEFORE removing the run's metadata.
		await this.tmux
			.exec(["set-option", "-t", this.session, "remain-on-exit", "on"])
			.catch(() => {});
		if (this.processGroup) {
			const pgid = this.processGroup;
			try {
				process.kill(-pgid, "SIGTERM");
				const escalate = setTimeout(() => {
					try {
						process.kill(-pgid, "SIGKILL");
					} catch {
						// Gone after SIGTERM — the normal case.
					}
				}, KILL_GRACE_MS);
				escalate.unref?.();
			} catch {
				// The run may already have exited.
			}
		} else {
			await this.tmux
				.exec(["send-keys", "-t", this.session, "C-c"])
				.catch(() => {});
		}
		for (const pending of this.pending.values())
			pending.reject(new Error("tmux run stopped"));
		this.pending.clear();
	}
	capture(lines = 80): Promise<string | undefined> {
		return this.tmux.capturePane(this.session, lines).catch(() => {
			try {
				return readFileSync(this.output, "utf8")
					.split("\n")
					.slice(-lines)
					.join("\n");
			} catch {
				return undefined;
			}
		});
	}

	private sessionFileArg(): string | undefined {
		const index = this.options.args?.indexOf("--session") ?? -1;
		return index >= 0 ? this.options.args?.[index + 1] : undefined;
	}

	private send(command: Record<string, unknown>): Promise<unknown> {
		if (this.stopped || this.exitError) {
			return Promise.reject(this.exitError ?? new Error("tmux run stopped"));
		}
		const id = `r${++this.requestId}`;
		try {
			appendFileSync(this.input, `${JSON.stringify({ id, ...command })}\n`);
		} catch (err) {
			return Promise.reject(
				err instanceof Error ? err : new Error(String(err)),
			);
		}
		// Every request carries a deadline and removes its pending entry on
		// expiry — a lost response must never strand a promise forever.
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				// DeadlineError so the generic runner settles this run timed-out
				// (terminal, never retried) rather than failed.
				reject(
					new DeadlineError(
						`tmux RPC ${String(command.type)} request`,
						this.rpcTimeoutMs,
					),
				);
			}, this.rpcTimeoutMs);
			timer.unref?.();
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
	}

	/**
	 * Incremental positional reads on the open descriptor — the event loop
	 * never re-reads the whole growing file. Fully drains available bytes.
	 */
	private drain(): void {
		if (this.outputFd === undefined) return;
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (;;) {
			let bytes = 0;
			try {
				bytes = readSync(this.outputFd, buffer, 0, buffer.length, this.offset);
			} catch {
				return;
			}
			if (bytes === 0) return;
			this.offset += bytes;
			this.consume(buffer.subarray(0, bytes).toString("utf8"));
			if (bytes < buffer.length) return;
		}
	}

	private consume(text: string): void {
		const chunk = this.remainder + text;
		const lines = chunk.split("\n");
		this.remainder = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			if (line.trim() === READY_MARKER) {
				this.bridgeReady = true;
				continue;
			}
			try {
				const value = JSON.parse(line) as Record<string, unknown>;
				if (value.type === "response" && typeof value.id === "string") {
					const pending = this.pending.get(value.id);
					if (pending) {
						this.pending.delete(value.id);
						value.success === false
							? pending.reject(new Error(String(value.error ?? "RPC failed")))
							: pending.resolve(value);
					}
					continue;
				}
				const event = value as unknown as AgentSessionEvent;
				if (event.type === "message_end") {
					const message = (
						event as { message?: { role?: string; content?: unknown } }
					).message;
					if (message?.role === "assistant")
						this.lastAssistant = assistantText(message.content);
				}
				for (const listener of this.listeners) listener(event);
			} catch {
				// Pane decoration/non-JSON output stays inspectable but is not an RPC event.
			}
		}
	}

	/**
	 * Child-death detection, independent of whether a request is in flight:
	 * a dead child rejects every pending call AND flips exitError so the
	 * generic runner's idle probe settles the run instead of hanging until a
	 * watchdog. Uses a signal-0 process-group probe (no subprocess per tick);
	 * falls back to tmux has-session when the pid was never learned.
	 */
	private async checkAlive(): Promise<void> {
		if (this.stopped || this.exitError || this.probing) return;
		this.probing = true;
		try {
			if (this.processGroup) {
				try {
					process.kill(-this.processGroup, 0);
					return; // alive
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "EPERM") return; // alive, not ours to signal
				}
			} else {
				try {
					await this.tmux.exec(["has-session", "-t", this.session]);
					return; // alive
				} catch {
					// fall through: dead
				}
			}
			this.drain(); // capture the child's last words first
			this.exitError = new Error(
				`tmux child exited (session ${this.session}); see ${this.stderr}`,
			);
			for (const pending of this.pending.values())
				pending.reject(this.exitError);
			this.pending.clear();
		} finally {
			this.probing = false;
		}
	}
}

function assistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && "text" in part
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

function sanitizeSession(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 96);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		t.unref?.();
	});
}
