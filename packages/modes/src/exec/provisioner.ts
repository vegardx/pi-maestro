// Provisioner: worktree creation, environment setup, and fork-and-append
// session assembly for execution agents. Self-contained seam — the supervisor
// (Wave 3) composes these; nothing here spawns processes or touches tmux.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
	CURRENT_SESSION_VERSION,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { addWorktree, worktreePathFor } from "@vegardx/pi-git";
import { deliverableBranch } from "../agent-lifecycle.js";
import {
	EXECUTION_SEED_ENTRY,
	MODES_STATE_ENTRY,
	type PersistedModesState,
} from "../session.js";
import {
	buildCustomEntry,
	buildCustomMessageEntry,
	parseSessionFile,
} from "../session-fork.js";

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
 * Assemble an agent's session file. With a knowledge session: copy its
 * entries under a fresh header (new id, agent cwd, parentSession lineage) and
 * append the modes-state + seed entries — the fork-and-append design, since
 * `pi --fork` can't append. Without one: header + the same two entries.
 * Entry order is deterministic: knowledge entries, modes state, seed.
 */
export function buildAgentSessionFile(
	opts: BuildAgentSessionOpts,
): AgentSessionFile {
	const sessionId = randomUUID();
	const timestamp = new Date().toISOString();

	let header: SessionHeader;
	let baseLines: string[] = [];
	let lastEntryId: string | null = null;
	let forkedFrom: string | undefined;

	if (opts.knowledgeSessionPath) {
		const knowledge = parseSessionFile(opts.knowledgeSessionPath);
		forkedFrom = knowledge.header.id;
		header = {
			...knowledge.header,
			id: sessionId,
			timestamp,
			cwd: opts.cwd,
			parentSession: knowledge.header.id,
		};
		baseLines = knowledge.entries.map((entry) => JSON.stringify(entry));
		lastEntryId = knowledge.entries.at(-1)?.id ?? null;
	} else {
		header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			timestamp,
			cwd: opts.cwd,
		};
	}

	const modesState: PersistedModesState = {
		version: 2,
		mode: "agent",
		execution: { stage: "executing" },
		updatedAt: timestamp,
	};
	const stateEntry = buildCustomEntry(
		MODES_STATE_ENTRY,
		modesState,
		lastEntryId,
	);
	const seedEntry = buildCustomMessageEntry(
		EXECUTION_SEED_ENTRY,
		opts.seed,
		stateEntry.id,
		{ display: true },
	);

	mkdirSync(opts.outDir, { recursive: true });
	const fileName = `${opts.agentKey.replace(/[^A-Za-z0-9._-]+/g, "-")}.jsonl`;
	const path = join(opts.outDir, fileName);
	const lines = [
		JSON.stringify(header),
		...baseLines,
		JSON.stringify(stateEntry),
		JSON.stringify(seedEntry),
	];
	writeFileSync(path, `${lines.join("\n")}\n`);

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
}

export interface SpawnSpec {
	sessionName: string;
	cwd: string;
	/** argv array — never joined into a shell string. */
	command: string[];
	env: Record<string, string>;
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
		"--session",
		opts.sessionFile,
		opts.kickoffMessage,
	];

	const env: Record<string, string> = {
		PI_MAESTRO_SOCK: opts.env.sock,
		PI_MAESTRO_AGENT_ID: opts.env.agentId,
		PI_MAESTRO_AGENT_MODE: opts.env.agentMode,
		PI_MAESTRO_TOKEN: opts.env.token,
		PI_CODING_AGENT_DIR: opts.env.agentDir ?? defaultAgentDir(),
		PI_CODING_AGENT_SESSION_DIR: opts.env.sessionDir,
	};
	if (process.env.PATH) env.PATH = process.env.PATH;
	if (process.env.HOME) env.HOME = process.env.HOME;

	return {
		sessionName: opts.sessionName,
		cwd: opts.worktreePath,
		command,
		env,
	};
}
