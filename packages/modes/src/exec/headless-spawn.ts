// Headless execution launcher: spawn deliverable workers as detached CHILD
// PROCESSES instead of tmux panes. It satisfies the same surface the executor
// and live-spawn use (spawn / hasSession / kill / capture), so nothing else in
// the execution path changes. Workers still dial home over the RPC socket
// (PI_MAESTRO_SOCK) exactly as under tmux — tmux was only ever the launcher +
// live-inspection surface, and this replaces both without a shared tmux server
// (no cross-session fencing, works in CI, honors PI_MAESTRO_TRANSPORT=headless).
//
// Inspection: tmux gave live panes; headless keeps a per-agent ring of the
// child's stdout+stderr, surfaced via capture() (crash screens land here too).

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";

/** Per-agent captured output cap — enough for a crash screen, not unbounded. */
const CAPTURE_CAP_BYTES = 64 * 1024;

interface Tracked {
	readonly child: ChildProcess;
	output: string;
	exited: boolean;
}

/** The launcher surface — a superset of LiveSpawnTmux plus `capture`. */
export interface HeadlessSpawner {
	spawn(
		name: string,
		cwd: string,
		command: string | readonly string[],
		opts?: { env?: Record<string, string> },
	): Promise<void>;
	hasSession(name: string): Promise<boolean>;
	kill(name: string): Promise<void>;
	capture(name: string, lines?: number): Promise<string>;
}

export function createHeadlessSpawner(): HeadlessSpawner {
	const procs = new Map<string, Tracked>();

	const killGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
		if (child.pid === undefined) return;
		try {
			// Detached children lead their own process group (pgid = pid), so a
			// negative pid signals the whole group — pi plus anything it spawned.
			process.kill(-child.pid, signal);
		} catch {
			// Already gone / not ours — reaping is best-effort.
		}
	};

	return {
		async spawn(name, cwd, command, opts) {
			// Replace any stale process still holding this name.
			const prior = procs.get(name);
			if (prior && !prior.exited) killGroup(prior.child, "SIGKILL");

			const argv = Array.isArray(command)
				? [...command]
				: ["sh", "-c", String(command)];
			const child = nodeSpawn(argv[0], argv.slice(1), {
				cwd,
				env: { ...process.env, ...(opts?.env ?? {}) },
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const tracked: Tracked = { child, output: "", exited: false };
			const append = (buf: Buffer): void => {
				tracked.output = (tracked.output + buf.toString("utf8")).slice(
					-CAPTURE_CAP_BYTES,
				);
			};
			child.stdout?.on("data", append);
			child.stderr?.on("data", append);
			child.on("exit", (code, signal) => {
				tracked.exited = true;
				append(
					Buffer.from(
						`\n[pi exited code=${code ?? "?"} signal=${signal ?? ""}]`,
					),
				);
			});
			child.on("error", (err) => {
				tracked.exited = true;
				append(Buffer.from(`\n[spawn error: ${err.message}]`));
			});
			// Don't keep the maestro alive on the worker — like tmux, the worker
			// outlives the launcher call and reports over the socket.
			child.unref();
			procs.set(name, tracked);
		},

		async hasSession(name) {
			const tracked = procs.get(name);
			return !!tracked && !tracked.exited && tracked.child.exitCode === null;
		},

		async kill(name) {
			const tracked = procs.get(name);
			if (tracked && !tracked.exited) killGroup(tracked.child, "SIGTERM");
			// Keep the record so a post-mortem capture() still works.
		},

		async capture(name, lines) {
			const tracked = procs.get(name);
			if (!tracked) return "";
			if (!lines || lines <= 0) return tracked.output;
			return tracked.output.split("\n").slice(-lines).join("\n");
		},
	};
}
