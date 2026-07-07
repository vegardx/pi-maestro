// FakeTmux: a TmuxLike backed by forked node children instead of tmux
// sessions, so supervisor tests exercise spawn/kill/crash lifecycles without
// tmux or pi. The default forked entry is the fake-agent CLI (fake-agent.ts),
// which reads FAKE_AGENT_SOCK/ID/TOKEN/SCRIPT from its environment.

import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The slice of @vegardx/pi-tmux the execution side consumes. */
export interface TmuxLike {
	spawn(
		name: string,
		cwd: string,
		command: string,
		opts?: { width?: number; height?: number },
	): Promise<void>;
	hasSession(name: string): Promise<boolean>;
	kill(name: string): Promise<void>;
}

export interface FakeTmuxOptions {
	/** Module forked per "session". Default: the fake-agent CLI. */
	readonly entry?: string;
	/** Env merged into every child, on top of assignments parsed from the command. */
	readonly env?: Record<string, string>;
}

export interface FakeSessionInfo {
	readonly name: string;
	readonly cwd: string;
	readonly command: string;
	readonly env: Record<string, string>;
	readonly pid: number | undefined;
	readonly alive: boolean;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	/** Combined stdout+stderr, for debugging boot failures. */
	readonly output: string;
}

interface FakeSession {
	readonly name: string;
	readonly cwd: string;
	readonly command: string;
	readonly env: Record<string, string>;
	readonly child: ChildProcess;
	readonly exit: Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>;
	killed: boolean;
	exited: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	output: string;
}

const FAKE_AGENT_ENTRY = fileURLToPath(
	new URL("./fake-agent.ts", import.meta.url),
);

/**
 * Leading KEY=VALUE tokens of a shell-ish command string (the form the
 * execution adapter builds: `ENV=… ENV=… pi …`). Values must be space-free.
 */
export function parseEnvAssignments(command: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const token of command.trim().split(/\s+/)) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
		if (!match) break;
		env[match[1]] = match[2];
	}
	return env;
}

export class FakeTmux implements TmuxLike {
	private readonly sessions = new Map<string, FakeSession>();
	private readonly options: FakeTmuxOptions;

	constructor(options: FakeTmuxOptions = {}) {
		this.options = options;
	}

	async spawn(
		name: string,
		cwd: string,
		command: string,
		_opts?: { width?: number; height?: number },
	): Promise<void> {
		const existing = this.sessions.get(name);
		if (existing && !existing.exited && !existing.killed) {
			throw new Error(`duplicate session: ${name}`);
		}
		const env = { ...parseEnvAssignments(command), ...this.options.env };
		const child = fork(this.options.entry ?? FAKE_AGENT_ENTRY, [], {
			cwd,
			env: { ...process.env, ...env },
			// Children run TS directly; never inherit vitest's execArgv.
			execArgv: ["--import", "jiti/register"],
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		const session: FakeSession = {
			name,
			cwd,
			command,
			env,
			child,
			killed: false,
			exited: false,
			exitCode: null,
			signal: null,
			output: "",
			exit: new Promise((resolve) => {
				child.once("exit", (code, signal) => resolve({ code, signal }));
			}),
		};
		child.stdout?.on("data", (chunk) => {
			session.output += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			session.output += String(chunk);
		});
		child.once("exit", (code, signal) => {
			session.exited = true;
			session.exitCode = code;
			session.signal = signal;
		});
		this.sessions.set(name, session);
	}

	async hasSession(name: string): Promise<boolean> {
		const session = this.sessions.get(name);
		return !!session && !session.exited && !session.killed;
	}

	async kill(name: string): Promise<void> {
		const session = this.sessions.get(name);
		if (!session || session.exited || session.killed) {
			throw new Error(`no such session: ${name}`);
		}
		// tmux kill-session removes the session immediately.
		session.killed = true;
		session.child.kill("SIGTERM");
	}

	/**
	 * SIGKILL the child with no bookkeeping — the session only reads as dead
	 * once the process actually exits, like a crashed pi.
	 */
	simulateCrash(name: string): void {
		const session = this.sessions.get(name);
		if (!session) throw new Error(`no such session: ${name}`);
		session.child.kill("SIGKILL");
	}

	async waitForExit(
		name: string,
		timeoutMs = 10_000,
	): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
		const session = this.sessions.get(name);
		if (!session) throw new Error(`no such session: ${name}`);
		if (session.exited) {
			return { code: session.exitCode, signal: session.signal };
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				session.exit,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						reject(new Error(`timed out waiting for ${name} to exit`));
					}, timeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	getSession(name: string): FakeSessionInfo | undefined {
		const session = this.sessions.get(name);
		if (!session) return undefined;
		return {
			name: session.name,
			cwd: session.cwd,
			command: session.command,
			env: session.env,
			pid: session.child.pid,
			alive: !session.exited && !session.killed,
			exitCode: session.exitCode,
			signal: session.signal,
			output: session.output,
		};
	}

	/** Names of currently live sessions. */
	list(): string[] {
		return [...this.sessions.values()]
			.filter((s) => !s.exited && !s.killed)
			.map((s) => s.name);
	}

	/** SIGKILL every child and wait for all exits. */
	async destroy(): Promise<void> {
		const pending: Promise<unknown>[] = [];
		for (const session of this.sessions.values()) {
			if (!session.exited) {
				session.killed = true;
				session.child.kill("SIGKILL");
				pending.push(session.exit);
			}
		}
		await Promise.all(pending);
		this.sessions.clear();
	}
}
