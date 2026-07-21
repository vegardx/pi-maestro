// Boot the system under test: a real `pi --mode rpc` process with the maestro
// extension stack loaded, running in a target repo, under an isolated pi home.
// Returns a connected `RpcClient` (the driver side of the wire).
//
// The extension list is read from the pi-maestro `package.json` `pi.extensions`
// so the driver always loads exactly what production loads — no drift.

import {
	type ChildProcessWithoutNullStreams,
	execFileSync,
	spawn,
} from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Answerer } from "./answerer.js";
import { RpcClient } from "./rpc-client.js";

export interface LaunchOptions {
	/** Absolute path to the pi-maestro checkout (where package.json + pi live). */
	readonly maestroRoot: string;
	/** Working directory for the maestro (the repo under test). */
	readonly repoDir: string;
	/** Isolated pi home (becomes HOME): holds auth.json/models.json/.pi/agent. */
	readonly piHome: string;
	/** Session storage dir passed via --session-dir (defaults to <piHome>/sessions). */
	readonly sessionDir?: string;
	/** Answers the maestro's dialogs. */
	readonly answerer: Answerer;
	/** Extra environment overlaid on the isolated base (e.g. API keys, PATH shims). */
	readonly env?: Record<string, string>;
	/** Optional model pattern (--model); omit to use the home's configured default. */
	readonly model?: string;
	/** Extra `-e` extensions beyond the maestro stack (e.g. a mock provider). */
	readonly extraExtensions?: string[];
	/** Append every inbound RPC line here for debugging. */
	readonly transcriptPath?: string;
	/** Notified for each streamed event. */
	readonly onEvent?: (event: { type: string }) => void;
}

export interface SutDeath {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly at: string;
	/** Tail of the SUT's stderr, when it wrote any. */
	readonly stderr?: string;
}

export interface LaunchedSut {
	readonly client: RpcClient;
	readonly child: ChildProcessWithoutNullStreams;
	/**
	 * Set once the SUT process exits. Nothing watched for this before, so a
	 * dead maestro was indistinguishable from a busy one: the driver kept
	 * answering `get_state` from cached state and reported `isStreaming: true`
	 * for forty minutes after the process was gone. A drive that dies must not
	 * look like a drive that is working.
	 */
	died(): SutDeath | undefined;
}

/** Absolute paths of the maestro extensions, from package.json `pi.extensions`. */
export function maestroExtensionPaths(maestroRoot: string): string[] {
	const pkg = JSON.parse(
		readFileSync(join(maestroRoot, "package.json"), "utf8"),
	) as { pi?: { extensions?: string[] } };
	const extensions = pkg.pi?.extensions ?? [];
	return extensions.map((rel) => resolve(maestroRoot, rel));
}

/**
 * The developer's committer identity, read in the REAL environment and handed
 * to the sandboxed SUT as env. Empty when none resolves — the maestro's own
 * preflight then reports it, which is the correct outcome rather than a
 * fabricated identity.
 */
function developerGitIdentityEnv(repoDir: string): Record<string, string> {
	const read = (key: string): string | undefined => {
		try {
			const value = execFileSync("git", ["config", "--get", key], {
				cwd: repoDir,
				encoding: "utf8",
			}).trim();
			return value || undefined;
		} catch {
			return undefined;
		}
	};
	const name = read("user.name");
	const email = read("user.email");
	if (!name || !email) return {};
	return {
		GIT_AUTHOR_NAME: name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: name,
		GIT_COMMITTER_EMAIL: email,
	};
}

export function launchSut(opts: LaunchOptions): LaunchedSut {
	const sessionDir = opts.sessionDir ?? join(opts.piHome, "sessions");
	const piBin = join(opts.maestroRoot, "node_modules", ".bin", "pi");
	// `--no-extensions` disables auto-discovery of the developer's *global*
	// extensions (explicit `-e` paths still load), so the SUT loads exactly the
	// maestro stack and nothing from the host's `~/.pi` — a hermetic boot.
	const args = [
		"--mode",
		"rpc",
		"--no-extensions",
		"--session-dir",
		sessionDir,
	];
	for (const ext of maestroExtensionPaths(opts.maestroRoot)) {
		args.push("-e", ext);
	}
	for (const ext of opts.extraExtensions ?? []) {
		args.push("-e", ext);
	}
	if (opts.model) args.push("--model", opts.model);

	const child = spawn(piBin, args, {
		cwd: opts.repoDir,
		env: {
			...process.env,
			HOME: opts.piHome,
			// pi resolves its config dir from PI_CODING_AGENT_DIR (or homedir/.pi).
			// The host may already set it to a real profile — pin it at the sandbox
			// so the SUT is truly isolated, and pin the session dir too.
			PI_CODING_AGENT_DIR: join(opts.piHome, ".pi", "agent"),
			PI_CODING_AGENT_SESSION_DIR: sessionDir,
			// Isolating HOME also isolates GIT config: git looks for
			// `$HOME/.gitconfig`, and an `includeIf "gitdir:~/…"` expands `~`
			// via HOME too. So the developer's identity vanishes inside the
			// sandbox and every worker refuses to spawn. Resolve it out here,
			// where HOME is still real, and pass it in the way the harness
			// passes identity to agents anyway.
			...developerGitIdentityEnv(opts.repoDir),
			...opts.env,
		},
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;

	// pi's own diagnostics (extension load failures, crashes) go to stderr —
	// capture them next to the RPC transcript so a dead SUT is debuggable.
	if (opts.transcriptPath) {
		const stderrPath = `${opts.transcriptPath}.stderr`;
		child.stderr.on("data", (chunk: Buffer) => {
			try {
				appendFileSync(stderrPath, chunk);
			} catch {
				// best-effort
			}
		});
	}

	let death: SutDeath | undefined;
	const recordDeath = (
		code: number | null,
		signal: NodeJS.Signals | null,
	): void => {
		if (death) return;
		let stderr: string | undefined;
		if (opts.transcriptPath) {
			try {
				stderr = readFileSync(`${opts.transcriptPath}.stderr`, "utf8")
					.trim()
					.slice(-2000);
			} catch {
				// none written
			}
		}
		death = {
			code,
			signal,
			at: new Date().toISOString(),
			...(stderr ? { stderr } : {}),
		};
	};
	child.on("exit", recordDeath);
	child.on("error", () => recordDeath(null, null));

	const client = new RpcClient(child, {
		answerer: opts.answerer,
		transcriptPath: opts.transcriptPath,
		onEvent: opts.onEvent,
	});
	return { client, child, died: () => death };
}
