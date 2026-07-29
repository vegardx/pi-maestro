// Starting agents. Two mechanisms, kept apart on purpose.
//
// A WORKER is a detached child process that dials home. Maestro launches it and
// walks away; the worker outlives the launching call and reports over the
// socket. That is what `autonomous` means, and it is why a worker needs a run
// token and a socket path in its environment.
//
// A READ-ONLY AGENT is a call. It runs over pi's own stdio RPC, and the caller
// awaits the answer. There is no socket, no token, and nothing to dial: the
// process that asked is the process that is waiting. That is what `blocking`
// means.
//
// Forcing these together would mean giving one of them machinery it does not
// need — a socket for something nobody dials, or a detached lifetime for
// something whose caller is blocked on it anyway. The relationship on the agent
// kind already says which is which, so nothing has to choose twice.

import {
	type ChildProcess,
	spawn as nodeSpawn,
	type SpawnOptions,
} from "node:child_process";
import { type AgentKind, isWriter, relationshipOf } from "./agent.js";

/**
 * Hard ceiling on nesting. Not a policy knob: every level multiplies the
 * running processes, and three is already a maestro, a worker, and the readers
 * that worker consults.
 */
export const MAX_DEPTH = 3;

/** Carries the child's nesting depth. Read by the child to know its own. */
export const DEPTH_ENV = "PI_MAESTRO_DEPTH";

/** How a child finds and authenticates to its maestro. */
export const SOCK_ENV = "PI_MAESTRO_SOCK";
export const TOKEN_ENV = "PI_MAESTRO_TOKEN";
export const AGENT_ID_ENV = "PI_MAESTRO_AGENT_ID";

/** This process's own depth. 0 when nothing set it: we are the maestro. */
export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[DEPTH_ENV];
	const depth = raw ? Number.parseInt(raw, 10) : 0;
	return Number.isFinite(depth) && depth >= 0 ? depth : 0;
}

/**
 * Why this spawn is refused, or `null` if it is allowed.
 *
 * Only the maestro produces writers. A worker that could spawn a worker would
 * be a second thing writing to a repo with no plan entry, no worktree of its
 * own and nobody collecting its result — and because a worker's own tools are
 * enough to launch one, the refusal has to be a rule rather than an omission.
 */
export function checkSpawn(child: AgentKind, depth: number): string | null {
	if (child === "maestro")
		return "a maestro is never spawned — it is the session that spawns";

	if (depth >= MAX_DEPTH)
		return `nesting limit reached (${MAX_DEPTH}): nothing may be spawned at depth ${depth}`;

	if (isWriter(child) && depth > 0)
		return `only the maestro spawns writers — a ${child} at depth ${depth} would write with no plan entry, no worktree of its own, and nobody collecting its result`;

	return null;
}

// ─── Workers: detached, dialling home ────────────────────────────────────────

export interface WorkerSpawn {
	readonly agentId: string;
	/** The worktree it works in. */
	readonly cwd: string;
	/** Where pi keeps the conversation, so a restarted maestro can re-attach. */
	readonly sessionFile: string;
	/** The brief, passed as pi's opening message. */
	readonly kickoff: string;
	readonly socketPath: string;
	readonly token: string;
	/** Extension paths the child loads. Its whole tool namespace. */
	readonly extensions: readonly string[];
	readonly model?: string;
	/** Where pi reads its model catalogue and auth from. */
	readonly agentDir?: string;
	readonly sessionDir?: string;
	/** Author identity for commits, passed explicitly rather than configured. */
	readonly gitIdentity?: { readonly name: string; readonly email: string };
	/** The spawner's depth; the child gets one more. */
	readonly parentDepth?: number;
}

export interface WorkerCommand {
	readonly argv: readonly string[];
	readonly env: Record<string, string>;
	readonly cwd: string;
}

/**
 * The exact process to start. Pure, so the argv and env are assertable without
 * launching anything — the shape is the contract with pi, and a typo in it used
 * to be discoverable only by watching a live agent do nothing.
 */
export function buildWorkerCommand(spawn: WorkerSpawn): WorkerCommand {
	const argv = [
		"pi",
		// Globally configured extensions are suppressed: an agent loads ONLY
		// what maestro names, or an unrelated installed extension can shadow a
		// tool name and the agent calls something nobody here wrote.
		"-ne",
		...spawn.extensions.flatMap((path) => ["-e", path]),
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		...(spawn.model ? ["--model", spawn.model] : []),
		"--session",
		spawn.sessionFile,
		spawn.kickoff,
	];

	// Built explicitly, never spread from process.env: a maestro running under
	// its own PI_MAESTRO_* variables must not leak them into a child that is
	// supposed to receive its own.
	const env: Record<string, string> = {
		[SOCK_ENV]: spawn.socketPath,
		[TOKEN_ENV]: spawn.token,
		[AGENT_ID_ENV]: spawn.agentId,
		[DEPTH_ENV]: String((spawn.parentDepth ?? 0) + 1),
	};
	// Deliberate propagation: a child must resolve the SAME config directory as
	// its maestro, or a sandboxed maestro spawns children that read the host's
	// catalogue and cannot see its models. pi has no flag for it.
	if (spawn.agentDir) env.PI_CODING_AGENT_DIR = spawn.agentDir;
	if (spawn.sessionDir) env.PI_CODING_AGENT_SESSION_DIR = spawn.sessionDir;
	if (spawn.gitIdentity) {
		// Env, not `git config`: a linked worktree SHARES the repo's config
		// file, so configuring identity inside one rewrites it for every
		// worktree and for the user. That has already happened here twice.
		env.GIT_AUTHOR_NAME = spawn.gitIdentity.name;
		env.GIT_AUTHOR_EMAIL = spawn.gitIdentity.email;
		env.GIT_COMMITTER_NAME = spawn.gitIdentity.name;
		env.GIT_COMMITTER_EMAIL = spawn.gitIdentity.email;
	}
	if (process.env.PATH) env.PATH = process.env.PATH;
	if (process.env.HOME) env.HOME = process.env.HOME;

	return { argv, env, cwd: spawn.cwd };
}

/** Per-agent captured output cap — enough for a crash screen, not unbounded. */
const CAPTURE_CAP_BYTES = 64 * 1024;

interface Launched {
	readonly child: ChildProcess;
	output: string;
	exited: boolean;
}

/**
 * The one call shape the launcher makes. Narrower than `typeof spawn` on
 * purpose — the overloaded original cannot be satisfied by a plain function,
 * and nothing here needs the other nine ways to call it.
 */
export type SpawnProcess = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

export interface WorkerLauncherOptions {
	/** Swapped in tests for something that is not pi. */
	readonly spawn?: SpawnProcess;
}

/**
 * Launches workers and keeps enough of a handle to kill one and to show what it
 * said on the way down.
 *
 * The output ring is the only reason this holds state at all. A worker that
 * dies before it can dial home leaves nothing on the socket and nothing in a
 * session file — its stderr is the entire evidence, and without capturing it
 * the failure reads as "the agent did nothing".
 */
export class WorkerLauncher {
	private readonly launched = new Map<string, Launched>();
	private readonly spawnProcess: SpawnProcess;

	constructor(options: WorkerLauncherOptions = {}) {
		this.spawnProcess = options.spawn ?? nodeSpawn;
	}

	launch(spawn: WorkerSpawn): void {
		const refusal = checkSpawn("worker", spawn.parentDepth ?? 0);
		if (refusal !== null) throw new Error(refusal);

		// Anything still holding this id is stale by definition — one agent id,
		// one process.
		const prior = this.launched.get(spawn.agentId);
		if (prior && !prior.exited) killGroup(prior.child, "SIGKILL");

		const { argv, env, cwd } = buildWorkerCommand(spawn);
		const child = this.spawnProcess(argv[0] as string, argv.slice(1), {
			cwd,
			env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const record: Launched = { child, output: "", exited: false };
		const append = (text: string): void => {
			record.output = (record.output + text).slice(-CAPTURE_CAP_BYTES);
		};
		child.stdout?.on("data", (b: Buffer) => append(b.toString("utf8")));
		child.stderr?.on("data", (b: Buffer) => append(b.toString("utf8")));
		child.on("exit", (code, signal) => {
			record.exited = true;
			append(`\n[pi exited code=${code ?? "?"} signal=${signal ?? ""}]`);
		});
		child.on("error", (error) => {
			record.exited = true;
			append(`\n[spawn failed: ${error.message}]`);
		});
		// The worker outlives this call — that is the whole point of autonomous.
		child.unref();
		this.launched.set(spawn.agentId, record);
	}

	alive(agentId: string): boolean {
		const record = this.launched.get(agentId);
		return !!record && !record.exited && record.child.exitCode === null;
	}

	kill(agentId: string): void {
		const record = this.launched.get(agentId);
		if (record && !record.exited) killGroup(record.child, "SIGTERM");
		// The record stays, so a post-mortem `capture` still works.
	}

	/** What the process printed. The only evidence when it died before dialling. */
	capture(agentId: string, lines?: number): string {
		const record = this.launched.get(agentId);
		if (!record) return "";
		if (!lines || lines <= 0) return record.output;
		return record.output.split("\n").slice(-lines).join("\n");
	}

	killAll(): void {
		for (const [, record] of this.launched)
			if (!record.exited) killGroup(record.child, "SIGKILL");
	}
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		// Detached children lead their own process group (pgid = pid), so a
		// negative pid signals the whole group — pi plus anything it spawned.
		process.kill(-child.pid, signal);
	} catch {
		// Already gone, or never ours. Reaping is best-effort.
	}
}

// ─── Read-only agents: a call that returns ───────────────────────────────────

/** The slice of pi's own RpcClient a read-only run needs. */
export interface ReadOnlySession {
	start(): Promise<unknown>;
	prompt(text: string): Promise<unknown>;
	getLastAssistantText(): Promise<string | null>;
	stop(): Promise<unknown>;
}

export interface ReadOnlySpawn {
	readonly kind: AgentKind;
	readonly cwd: string;
	/** The persona's brief plus its assignment. */
	readonly brief: string;
	readonly prompt: string;
	readonly model?: string;
	readonly parentDepth?: number;
}

export type ReadOnlySessionFactory = (
	spawn: ReadOnlySpawn,
) => Promise<ReadOnlySession>;

export class EmptyAnswer extends Error {
	constructor(kind: AgentKind) {
		super(
			`the ${kind} returned nothing — a reader that reports nothing has failed, it has not "found no issues"`,
		);
		this.name = "EmptyAnswer";
	}
}

/**
 * Run a read-only agent and return what it said.
 *
 * An empty answer THROWS. Silence and "I looked and found nothing" are
 * different claims, and a system that treats them alike is how six real
 * findings became "(agent produced no summary)" in a PR body. If a reader has
 * nothing to say it must say so.
 */
export async function askReadOnly(
	spawn: ReadOnlySpawn,
	open: ReadOnlySessionFactory,
): Promise<string> {
	if (relationshipOf(spawn.kind) === "autonomous")
		throw new Error(
			`a ${spawn.kind} is not asked and awaited — it is launched, and reports over the socket`,
		);
	const refusal = checkSpawn(spawn.kind, spawn.parentDepth ?? 0);
	if (refusal !== null) throw new Error(refusal);

	const session = await open(spawn);
	try {
		await session.start();
		await session.prompt(spawn.prompt);
		const answer = (await session.getLastAssistantText())?.trim();
		if (!answer) throw new EmptyAnswer(spawn.kind);
		return answer;
	} finally {
		// The caller is blocked on this; nothing else will clean it up.
		await session.stop().catch(() => {});
	}
}
