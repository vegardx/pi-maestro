// Provisioner: worktree creation, environment setup, and fork-and-append
// session assembly for execution agents. Self-contained seam — the supervisor
// (Wave 3) composes these; nothing here spawns processes or touches tmux.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { addWorktree, worktreePathFor } from "@vegardx/pi-git";
import { deliverableBranch } from "../agent-lifecycle.js";
import {
	EXECUTION_SEED_ENTRY,
	MODES_STATE_ENTRY,
	type PersistedModesState,
} from "../session.js";
import { createSessionFileAt, parseSessionFile } from "../session-fork.js";

// ─── Worktree provisioning ───────────────────────────────────────────────────

export interface ProvisionWorktreeOpts {
	/** Main checkout of the repo. */
	repoPath: string;
	/** Deliverable id — determines the branch (`feat/<deliverableId>`) and path segment. */
	deliverableId: string;
	/** Branch to create `feat/<deliverableId>` from when it doesn't exist yet. */
	baseBranch: string;
	/** Parent directory for worktrees. Defaults to the repo's sibling root. */
	worktreesRoot?: string;
}

/**
 * Create (or reuse) the worktree for a deliverable on branch `feat/<deliverableId>`.
 * Idempotent — delegates reuse semantics to `addWorktree`. Returns the
 * worktree path; throws with a clear message on failure so no agent is
 * spawned into a broken tree.
 */
export function provisionWorktree(opts: ProvisionWorktreeOpts): string {
	const branch = deliverableBranch(opts.deliverableId);
	const target = opts.worktreesRoot
		? join(opts.worktreesRoot, opts.deliverableId)
		: worktreePathFor(opts.repoPath, opts.deliverableId);
	const result = addWorktree(opts.repoPath, target, branch, opts.baseBranch);
	if (!result.ok) {
		throw new Error(
			`worktree provisioning for deliverable ${opts.deliverableId} (branch ${branch}) failed: ${result.error}`,
		);
	}
	return result.path;
}

// ─── Environment setup ───────────────────────────────────────────────────────

export interface ProvisionEnvironmentOpts {
	/** Gitignored files to copy from the main checkout (relative paths, e.g.
	 * `.env`). Sources missing in the main checkout are skipped. */
	copy?: string[];
	/** Setup command run once in the worktree (e.g. `npm ci`). Split into an
	 * argv array and run without a shell. Skipped when a node_modules
	 * fast-path (clone or link) already applied. */
	setupCommand?: string;
	/** Paths symlinked from the main checkout — explicit opt-in only. */
	linkPaths?: string[];
}

export interface ProvisionEnvironmentResult {
	copied: string[];
	linked: string[];
	/** True when the macOS/APFS `cp -c` node_modules clone succeeded. */
	nodeModulesCloned: boolean;
	setupRan: boolean;
}

const execFileAsync = promisify(execFile);

/**
 * Prepare a fresh worktree's environment: copy gitignored files, symlink
 * explicitly listed paths, clone node_modules copy-on-write where the
 * filesystem supports it, then run the setup command when no dependency
 * fast-path applied. Failures throw — provisioning must not hand agents a
 * half-built tree.
 *
 * Async because the clone and the setup command can take seconds to minutes;
 * their old execFileSync forms blocked the maestro's event loop (RPC, tmux
 * polling) for the whole install.
 */
export async function provisionEnvironment(
	worktreePath: string,
	mainCheckoutPath: string,
	opts: ProvisionEnvironmentOpts = {},
): Promise<ProvisionEnvironmentResult> {
	const copied: string[] = [];
	for (const rel of opts.copy ?? []) {
		const src = join(mainCheckoutPath, rel);
		if (!existsSync(src)) continue;
		const dest = join(worktreePath, rel);
		try {
			mkdirSync(dirname(dest), { recursive: true });
			cpSync(src, dest, { recursive: true });
		} catch (err) {
			throw new Error(
				`environment copy of ${rel} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		copied.push(rel);
	}

	const linked: string[] = [];
	for (const rel of opts.linkPaths ?? []) {
		const src = join(mainCheckoutPath, rel);
		if (!existsSync(src)) {
			throw new Error(
				`linkPaths source ${rel} does not exist in ${mainCheckoutPath}`,
			);
		}
		const dest = join(worktreePath, rel);
		if (existsSync(dest)) continue;
		try {
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(src, dest);
		} catch (err) {
			throw new Error(
				`symlinking ${rel} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		linked.push(rel);
	}

	const nodeModulesCloned = await cloneNodeModules(
		worktreePath,
		mainCheckoutPath,
	);

	// The fast-path also covers re-activation: a worktree whose node_modules
	// already exists (provisioned on an earlier run) must not re-run setup.
	const fastPathApplied =
		nodeModulesCloned ||
		existsSync(join(worktreePath, "node_modules")) ||
		linked.some((rel) => basename(rel) === "node_modules");
	let setupRan = false;
	if (opts.setupCommand && !fastPathApplied) {
		await runSetupCommand(worktreePath, opts.setupCommand);
		setupRan = true;
	}

	return { copied, linked, nodeModulesCloned, setupRan };
}

/** macOS/APFS copy-on-write clone of node_modules; silent no-op elsewhere. */
async function cloneNodeModules(
	worktreePath: string,
	mainCheckoutPath: string,
): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	const src = join(mainCheckoutPath, "node_modules");
	const dest = join(worktreePath, "node_modules");
	if (!existsSync(src) || existsSync(dest)) return false;
	try {
		await execFileAsync("cp", ["-c", "-R", src, dest]);
		return true;
	} catch {
		// Non-APFS or cp without clone support — fall back to setupCommand.
		rmSync(dest, { recursive: true, force: true });
		return false;
	}
}

async function runSetupCommand(
	worktreePath: string,
	setupCommand: string,
): Promise<void> {
	const argv = setupCommand.split(/\s+/).filter((s) => s.length > 0);
	if (argv.length === 0) return;
	try {
		await execFileAsync(argv[0], argv.slice(1), { cwd: worktreePath });
	} catch (err) {
		const stderr =
			err instanceof Error && "stderr" in err
				? String((err as { stderr?: unknown }).stderr ?? "").trim()
				: "";
		throw new Error(
			`setup command "${setupCommand}" failed in ${worktreePath}${stderr ? `: ${stderr}` : ""}`,
		);
	}
}

// ─── Session assembly (fork-and-append) ─────────────────────────────────────

export interface BuildAgentSessionOpts {
	/** `<deliverableId>/<agentName>` — becomes the session file name. */
	agentKey: string;
	/** Framed seed markdown, appended as the LLM-visible execution seed. */
	seed: string;
	/** Agent worktree — written into the session header. */
	cwd: string;
	/** Directory the session file is written to. */
	outDir: string;
	/** Knowledge session to fork from (shared cache prefix). */
	knowledgeSessionPath?: string;
}

export interface AgentSessionFile {
	path: string;
	sessionId: string;
	/** Knowledge session id this file was forked from, when forking. */
	forkedFrom?: string;
}

/**
 * Assemble an agent's session file via the pi SDK. With a knowledge session:
 * `SessionManager.forkFrom()` copies its entries under a fresh header (new
 * id, agent cwd, parentSession → the knowledge file's path), then the
 * modes-state + seed entries are appended — the fork-and-append design.
 * Without one: a header-only bootstrap plus the same two appends. Entry
 * order is deterministic: knowledge entries, modes state, seed. Either way
 * the file ends up at `<outDir>/<agentKey>.jsonl`.
 */
export function buildAgentSessionFile(
	opts: BuildAgentSessionOpts,
): AgentSessionFile {
	const sessionId = randomUUID();
	mkdirSync(opts.outDir, { recursive: true });
	const fileName = `${opts.agentKey.replace(/[^A-Za-z0-9._-]+/g, "-")}.jsonl`;
	const path = join(opts.outDir, fileName);

	let session: SessionManager;
	let forkedFrom: string | undefined;
	if (opts.knowledgeSessionPath) {
		forkedFrom = parseSessionFile(opts.knowledgeSessionPath).header.id;
		session = SessionManager.forkFrom(
			opts.knowledgeSessionPath,
			opts.cwd,
			opts.outDir,
			{ id: sessionId },
		);
	} else {
		session = createSessionFileAt(path, opts.cwd, { id: sessionId });
	}

	const modesState: PersistedModesState = {
		version: 2,
		mode: "agent",
		execution: { stage: "executing" },
		updatedAt: new Date().toISOString(),
	};
	session.appendCustomEntry(MODES_STATE_ENTRY, modesState);
	session.appendCustomMessageEntry(EXECUTION_SEED_ENTRY, opts.seed, true);

	// forkFrom names its file `<timestamp>_<id>.jsonl`; agents are addressed
	// by key, so move the finished session onto the deterministic path.
	const written = session.getSessionFile();
	if (!written) {
		throw new Error(`session assembly for ${opts.agentKey} produced no file`);
	}
	if (written !== path) renameSync(written, path);

	return { path, sessionId, forkedFrom };
}

// ─── Spawn spec ──────────────────────────────────────────────────────────────

export interface SpawnEnv {
	/** Maestro RPC socket path. */
	sock: string;
	/** Agent key (`<deliverableId>/<agentName>`). */
	agentId: string;
	/** Agent tool policy: `full` or `read-only`. */
	agentMode: string;
	/** pi agent dir (auth lives here). Defaults to {@link defaultAgentDir}. */
	agentDir?: string;
	/** Session dir for the agent's own pi session bookkeeping. */
	sessionDir: string;
	/** Run token — prevents wire-crossing between concurrent maestros. */
	token: string;
	/**
	 * The plan directory. Workers use it to reach `<planDir>/research/` —
	 * the `dig` tool's report source (they have no plan engine of their own).
	 */
	planDir: string;
}

export interface BuildSpawnSpecOpts {
	/** tmux session name for the agent. */
	sessionName: string;
	worktreePath: string;
	/** Session file assembled by {@link buildAgentSessionFile}. */
	sessionFile: string;
	/** Extension paths passed as repeated `-e` flags. */
	extensionPaths: string[];
	env: SpawnEnv;
	/** Kickoff message — the final positional argument to pi. */
	kickoffMessage: string;
	/**
	 * Explicit model override ("provider/id"). Omitted for session-pinned
	 * agents (the default) so they inherit the session model cache-warm; set
	 * only for the deliberate alternate-slot case.
	 */
	model?: string;
	/** Explicit thinking/effort level. Omitted inherits the session default. */
	thinking?: string;
	/**
	 * When set, pi runs inside a shell wrapper that — after pi exits for ANY
	 * reason — captures the final pane content plus exit code to this file
	 * before the tmux session dies. Without it a crashing worker takes its
	 * stack trace to the grave: the poll only ever sees "session gone".
	 */
	crashFile?: string;
}

export interface SpawnSpec {
	sessionName: string;
	cwd: string;
	/** argv array, or a shell string when the crash-capture wrapper is on. */
	command: string[] | string;
	env: Record<string, string>;
}

/** Single-quote a token for the crash-capture shell wrapper. */
function shellEscape(token: string): string {
	return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Default pi agent dir. auth.json lives under `~/.config/pi/agent` (NOT
 * `~/.pi/agent`); `PI_CODING_AGENT_DIR` overrides.
 */
export function defaultAgentDir(): string {
	return (
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".config", "pi", "agent")
	);
}

/**
 * Build the structured spawn spec for an agent's pi process. Pure argv + env
 * assembly — no shell-string quoting anywhere; the spawner passes `command`
 * straight to an exec-style API.
 */
export function buildSpawnSpec(opts: BuildSpawnSpecOpts): SpawnSpec {
	const command = [
		"pi",
		// Suppress globally-configured extensions: agents load ONLY the
		// maestro's explicit -e list (global ones collide on tool names).
		"-ne",
		...opts.extensionPaths.flatMap((p) => ["-e", p]),
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		...(opts.model ? ["--model", opts.model] : []),
		...(opts.thinking ? ["--thinking", opts.thinking] : []),
		"--session",
		opts.sessionFile,
		opts.kickoffMessage,
	];

	const env: Record<string, string> = {
		PI_MAESTRO_SOCK: opts.env.sock,
		PI_MAESTRO_AGENT_ID: opts.env.agentId,
		PI_MAESTRO_AGENT_MODE: opts.env.agentMode,
		PI_MAESTRO_TOKEN: opts.env.token,
		PI_MAESTRO_PLAN_DIR: opts.env.planDir,
		PI_CODING_AGENT_DIR: opts.env.agentDir ?? defaultAgentDir(),
		PI_CODING_AGENT_SESSION_DIR: opts.env.sessionDir,
	};
	if (process.env.PATH) env.PATH = process.env.PATH;
	if (process.env.HOME) env.HOME = process.env.HOME;

	// Crash capture: run pi under a wrapper so its dying screen (stack trace,
	// provider error, OOM message) survives the session. capture-pane runs
	// while the shell still owns the pane — the last window before tmux
	// reaps it.
	const wrapped = opts.crashFile
		? `${command.map(shellEscape).join(" ")}; ec=$?; ` +
			`tmux capture-pane -p -S -120 -t "$TMUX_PANE" > ${shellEscape(opts.crashFile)} 2>/dev/null; ` +
			`echo "[pi exited code=$ec]" >> ${shellEscape(opts.crashFile)}; exit $ec`
		: undefined;

	return {
		sessionName: opts.sessionName,
		cwd: opts.worktreePath,
		command: wrapped ?? command,
		env,
	};
}
