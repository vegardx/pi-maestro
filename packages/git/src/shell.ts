// Canonical shell runner for the maestro suite. Sync + async command execution
// with a non-interactive environment (git/gh/ssh never prompt), a hard timeout
// (so a hung child can't freeze the event loop), abort support (async), and an
// output cap. Domain git helpers in this package call through here.

import { spawn, spawnSync } from "node:child_process";

export interface ShellResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
	/** Killed for exceeding its timeout. */
	timedOut?: boolean;
	/** Killed by an external AbortSignal (e.g. the TUI's Esc). */
	aborted?: boolean;
}

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Default ceiling for any subprocess. spawnSync blocks the event loop for the
 * child's lifetime, so an unbounded command (network stall, held index.lock)
 * would freeze the TUI. 60s is generous for network ops.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export interface RunCommandOpts {
	cwd?: string;
	stdin?: string;
	timeoutMs?: number;
	/** Inherit process.env instead of the non-interactive overlay. */
	inheritEnv?: boolean;
}

export interface RunCommandAsyncOpts extends RunCommandOpts {
	signal?: AbortSignal;
}

/**
 * Non-interactive environment for git/gh/ssh. A credential helper or SSH
 * passphrase prompt opens /dev/tty and blocks forever; these vars make the
 * tools fail fast instead of prompting. A user's GIT_SSH_COMMAND wins.
 */
export function nonInteractiveEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	env.GIT_TERMINAL_PROMPT = "0";
	env.GCM_INTERACTIVE = "never";
	if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
	env.GIT_ASKPASS = "";
	env.SSH_ASKPASS = "";
	env.SSH_ASKPASS_REQUIRE = "never";
	delete env.DISPLAY;
	env.GH_PROMPT_DISABLED = "1";
	env.GH_NO_UPDATE_NOTIFIER = "1";
	return env;
}

/** spawnSync wrapper that never throws; branch on ok/exitCode/timedOut. */
export function runCommand(
	command: string,
	args: readonly string[],
	opts: RunCommandOpts = {},
): ShellResult {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	const env = opts.inheritEnv ? process.env : nonInteractiveEnv();
	const result = spawnSync(command, [...args], {
		cwd: opts.cwd,
		input: opts.stdin ?? "",
		encoding: "utf8",
		shell: false,
		env,
		timeout: timeoutMs,
		killSignal: "SIGKILL",
		maxBuffer: MAX_OUTPUT_BYTES,
	});
	const timedOut =
		(result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
		result.signal === "SIGKILL";
	const spawnError =
		result.error && !timedOut ? (result.error as Error).message : undefined;
	const exitCode = typeof result.status === "number" ? result.status : -1;
	return {
		ok: exitCode === 0 && !timedOut,
		stdout: (result.stdout ?? "").toString(),
		stderr: timedOut
			? `timed out after ${timeoutMs}ms`
			: (spawnError ?? (result.stderr ?? "").toString()),
		exitCode,
		timedOut,
	};
}

/** Async, abortable sibling of runCommand for interruptible network ops. */
export function runCommandAsync(
	command: string,
	args: readonly string[],
	opts: RunCommandAsyncOpts = {},
): Promise<ShellResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

	if (opts.signal?.aborted) {
		return Promise.resolve({
			ok: false,
			stdout: "",
			stderr: "aborted",
			exitCode: -1,
			aborted: true,
		});
	}

	const env = opts.inheritEnv ? process.env : nonInteractiveEnv();

	return new Promise<ShellResult>((resolve) => {
		const child = spawn(command, [...args], {
			cwd: opts.cwd,
			shell: false,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutLen = 0;
		let stderrLen = 0;
		let settled = false;
		let timedOut = false;
		let aborted = false;

		const onAbort = () => {
			aborted = true;
			clearTimeout(timer);
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => {
			timedOut = true;
			opts.signal?.removeEventListener("abort", onAbort);
			child.kill("SIGKILL");
		}, timeoutMs);
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		const settle = (result: ShellResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdoutLen >= MAX_OUTPUT_BYTES) return;
			stdoutChunks.push(chunk);
			stdoutLen += chunk.length;
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderrLen >= MAX_OUTPUT_BYTES) return;
			stderrChunks.push(chunk);
			stderrLen += chunk.length;
		});

		child.on("error", (err: Error) => {
			settle({ ok: false, stdout: "", stderr: err.message, exitCode: -1 });
		});

		child.on("close", (code) => {
			const exitCode = typeof code === "number" ? code : -1;
			settle({
				ok: exitCode === 0 && !timedOut && !aborted,
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: aborted
					? "aborted"
					: timedOut
						? `timed out after ${timeoutMs}ms`
						: Buffer.concat(stderrChunks).toString("utf8"),
				exitCode,
				timedOut: timedOut || undefined,
				aborted: aborted || undefined,
			});
		});

		if (child.stdin) {
			child.stdin.end(opts.stdin ?? "");
		}
	});
}
