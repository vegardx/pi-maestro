// Detached-tmux transport for one-shot subagents. The child still speaks pi's
// JSONL RPC protocol, but stdin/stdout are bridged through append-only files so
// the actual pi process (and its terminal output) lives in an inspectable tmux
// session rather than as an opaque child of the host.

import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { RpcClientOptions } from "@earendil-works/pi-coding-agent";
import type { RunId } from "@vegardx/pi-contracts";
import { capturePane, shellEscape, spawn, tmuxExec } from "@vegardx/pi-tmux";
import type { RunBus } from "./bus.js";
import {
	createAgentRunner,
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
}

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

class TmuxRpcClient implements RpcLike {
	private readonly listeners = new Set<(event: AgentEvent) => void>();
	private readonly pending = new Map<string, Pending>();
	private readonly runDir: string;
	private readonly input: string;
	private readonly output: string;
	private readonly stderr: string;
	private readonly session: string;
	private offset = 0;
	private remainder = "";
	private timer: ReturnType<typeof setInterval> | undefined;
	private requestId = 0;
	private lastAssistant = "";
	private stopped = false;
	private processGroup: number | undefined;
	private readonly tmux;

	constructor(
		private readonly options: RpcClientOptions,
		private readonly runId: RunId,
		runsRoot: string,
		tmux: TmuxRunnerOptions["tmux"],
		private readonly onMetadata: (metadata: {
			transport: "tmux";
			pid?: number;
			processGroup?: number;
			tmuxSession: string;
			tmuxPane?: string;
			sessionFile?: string;
			cwd?: string;
			role: string;
			displayName: string;
		}) => void,
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
		const cli = this.options.cliPath ?? process.argv[1];
		if (!cli) throw new Error("tmux subagent transport cannot resolve pi CLI");
		const argv = ["node", cli, "--mode", "rpc"];
		if (this.options.model) argv.push("--model", this.options.model);
		argv.push(...(this.options.args ?? []));
		const command =
			`tail -n 0 -F ${shellEscape(this.input)} | ` +
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
		this.timer = setInterval(() => this.drain(), 20);
		this.timer.unref?.();
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
		const sessionIndex = this.options.args?.indexOf("--session") ?? -1;
		this.onMetadata({
			transport: "tmux",
			...(pid ? { pid, processGroup: pid } : {}),
			tmuxSession: this.session,
			...(pane ? { tmuxPane: pane } : {}),
			...(sessionIndex >= 0 && this.options.args?.[sessionIndex + 1]
				? { sessionFile: this.options.args[sessionIndex + 1] }
				: {}),
			cwd: this.options.cwd,
			role: "run",
			displayName: this.runId,
		});
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
	onEvent(listener: (event: AgentEvent) => void): () => void {
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
		this.drain();
		// Preserve the pane for bounded post-mortem inspection. Terminate the
		// process group, but leave tmux's dead pane/session retained; run-store
		// retention later removes the corresponding metadata/artifacts.
		await this.tmux
			.exec(["set-option", "-t", this.session, "remain-on-exit", "on"])
			.catch(() => {});
		if (this.processGroup) {
			try {
				process.kill(-this.processGroup, "SIGTERM");
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

	private send(command: Record<string, unknown>): Promise<unknown> {
		if (this.stopped) return Promise.reject(new Error("tmux run stopped"));
		const id = `r${++this.requestId}`;
		appendFileSync(this.input, `${JSON.stringify({ id, ...command })}\n`);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
	}

	private drain(): void {
		let raw: string;
		try {
			raw = readFileSync(this.output, "utf8");
		} catch {
			return;
		}
		if (raw.length <= this.offset) return;
		const chunk = this.remainder + raw.slice(this.offset);
		this.offset = raw.length;
		const lines = chunk.split("\n");
		this.remainder = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
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
				const event = value as unknown as AgentEvent;
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
