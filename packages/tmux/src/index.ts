import { execFile } from "node:child_process";

export class TmuxError extends Error {
	readonly code: number;
	readonly stderr: string;

	constructor(code: number, stderr: string) {
		super(`tmux exited with code ${code}: ${stderr.trim()}`);
		this.name = "TmuxError";
		this.code = code;
		this.stderr = stderr;
	}
}

export interface TmuxSession {
	name: string;
	lastActivity: number;
	attached: boolean;
}

export interface SplitWindowOptions {
	target?: string;
	horizontal?: boolean;
	percent?: number;
	/** Don't focus the new pane (keep focus on current). */
	detach?: boolean;
	command: string;
}

/**
 * Returns true when running inside a tmux session.
 */
export function isTmuxAvailable(): boolean {
	return !!process.env.TMUX;
}

/**
 * Execute a raw tmux command. Returns stdout on success, throws TmuxError on failure.
 */
export async function tmuxExec(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("tmux", args, (error, stdout, stderr) => {
			if (error) {
				const code = error.code ?? 1;
				reject(new TmuxError(typeof code === "number" ? code : 1, stderr));
				return;
			}
			resolve(stdout);
		});
	});
}

/** POSIX single-quote escaping — the only safe way to embed a token in a shell word. */
export function shellEscape(token: string): string {
	return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Spawn a new detached tmux session. An argv-array command is escaped
 * per-token; env vars are passed via tmux `-e` flags, never interpolated
 * into the command string.
 */
export async function spawn(
	name: string,
	cwd: string,
	command: string | string[],
	opts?: { width?: number; height?: number; env?: Record<string, string> },
): Promise<void> {
	const args = ["new-session", "-d", "-s", name, "-c", cwd];
	if (opts?.width) args.push("-x", String(opts.width));
	if (opts?.height) args.push("-y", String(opts.height));
	for (const [key, value] of Object.entries(opts?.env ?? {})) {
		args.push("-e", `${key}=${value}`);
	}
	args.push(
		Array.isArray(command) ? command.map(shellEscape).join(" ") : command,
	);
	await tmuxExec(args);
}

/**
 * Send literal text to a tmux target followed by Enter.
 */
export async function sendKeys(target: string, text: string): Promise<void> {
	await tmuxExec(["send-keys", "-t", target, "-l", text, "Enter"]);
}

/**
 * Kill a tmux session by name.
 */
export async function kill(name: string): Promise<void> {
	await tmuxExec(["kill-session", "-t", name]);
}

/**
 * List all tmux sessions.
 */
export async function list(): Promise<TmuxSession[]> {
	const format =
		"#{session_name}:#{session_activity}:#{?session_attached,attached,detached}";
	const stdout = await tmuxExec(["list-sessions", "-F", format]);
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map(parseSessionLine);
}

function parseSessionLine(line: string): TmuxSession {
	const parts = line.split(":");
	return {
		name: parts[0],
		lastActivity: Number.parseInt(parts[1], 10),
		attached: parts[2] === "attached",
	};
}

/**
 * Check whether a session with the given name exists.
 */
export async function hasSession(name: string): Promise<boolean> {
	try {
		await tmuxExec(["has-session", "-t", name]);
		return true;
	} catch (err) {
		if (err instanceof TmuxError) return false;
		throw err;
	}
}

/**
 * Capture the visible content of a pane.
 */
export async function capturePane(target: string, lines = 50): Promise<string> {
	return tmuxExec(["capture-pane", "-t", target, "-p", "-S", `-${lines}`]);
}

/**
 * Switch the current tmux client to a different session.
 */
export async function switchClient(target: string): Promise<void> {
	await tmuxExec(["switch-client", "-t", target]);
}

/**
 * Split the current (or specified) pane and run a command in the new pane.
 * Returns the new pane ID (e.g. "%3").
 */
export async function splitWindow(
	options: SplitWindowOptions,
): Promise<string> {
	const args = ["split-window"];
	if (options.horizontal !== false) args.push("-h");
	if (options.detach) args.push("-d");
	if (options.percent != null) args.push("-p", String(options.percent));
	if (options.target) args.push("-t", options.target);
	args.push("-P", "-F", "#{pane_id}");
	args.push(options.command);
	const stdout = await tmuxExec(args);
	return stdout.trim();
}

/**
 * Kill a pane by ID. Does not affect the process running in other sessions.
 */
export async function killPane(target: string): Promise<void> {
	await tmuxExec(["kill-pane", "-t", target]);
}

/**
 * Resize a pane to absolute dimensions.
 */
export async function resizePane(
	target: string,
	opts: { width?: number; height?: number },
): Promise<void> {
	const args = ["resize-pane", "-t", target];
	if (opts.width != null) args.push("-x", String(opts.width));
	if (opts.height != null) args.push("-y", String(opts.height));
	await tmuxExec(args);
}

/**
 * Apply a layout to the window containing the target pane.
 * Layouts: even-horizontal, even-vertical, main-horizontal, main-vertical, tiled.
 */
export async function selectLayout(
	target: string,
	layout:
		| "even-horizontal"
		| "even-vertical"
		| "main-horizontal"
		| "main-vertical"
		| "tiled",
): Promise<void> {
	await tmuxExec(["select-layout", "-t", target, layout]);
}

/**
 * Get the current pane ID (the pane we're running in).
 */
export async function currentPaneId(): Promise<string> {
	const stdout = await tmuxExec(["display-message", "-p", "#{pane_id}"]);
	return stdout.trim();
}
