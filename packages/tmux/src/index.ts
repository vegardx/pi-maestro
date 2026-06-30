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

/**
 * Spawn a new detached tmux session.
 */
export async function spawn(
	name: string,
	cwd: string,
	command: string,
): Promise<void> {
	await tmuxExec(["new-session", "-d", "-s", name, "-c", cwd, command]);
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
