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
	/** The spawner's depth; the child gets one more. */
	readonly parentDepth?: number;
	/**
	 * How to start pi. Defaults to the pi THIS process is running.
	 *
	 * Not the bare name `pi`: that resolves through PATH to a shim symlinked at
	 * `../dist/cli.js`, and a child started from a worktree resolves it relative
	 * to the wrong directory and dies with MODULE_NOT_FOUND before it can dial
	 * home. Running the same interpreter and the same entry script the maestro
	 * is running removes the question entirely — a worker cannot be a different
	 * pi from its maestro.
	 */
	readonly piCommand?: readonly string[];
}

/** The pi this process is running: its interpreter and its entry script. */
export function currentPiCommand(): readonly string[] {
	const entry = process.argv[1];
	if (!entry)
		throw new Error(
			"cannot tell which pi to start a worker with: this process has no entry script",
		);
	return [process.execPath, entry];
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
		...(spawn.piCommand ?? currentPiCommand()),
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
	if (process.env.PATH) env.PATH = process.env.PATH;
	// HOME carries the developer's git configuration, and with it their identity.
	// Nothing here resolves that identity or hands it over: `git config` already
	// walks system, global, repo-local and `includeIf`, and `includeIf gitdir:`
	// is PATH-SCOPED — resolving it once in the maestro and broadcasting it as
	// GIT_AUTHOR_* would flatten that scoping and commit in one repository under
	// the identity configured for another. Git resolves its own identity, per
	// worktree, and the guard against a worker writing `git config` is the
	// sandbox's write-deny on `.git/config`, not a value carried in front of it.
	if (process.env.HOME) env.HOME = process.env.HOME;

	return { argv, env, cwd: spawn.cwd };
}

/** Per-agent captured output cap — enough for a crash screen, not unbounded. */
const CAPTURE_CAP_BYTES = 64 * 1024;

interface Launched {
	readonly child: ChildProcess;
	output: string;
	exited: boolean;
	/** Resolves when the process is reaped, so its last words are in hand. */
	readonly settled: Promise<void>;
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

	/**
	 * Start a worker, and answer with the pid.
	 *
	 * The pid is returned so it can be WRITTEN DOWN. This map dies with the
	 * maestro, and a maestro that restarts onto a run it did not start has no
	 * other way to tell an in-flight worker from one that died in the crash —
	 * which is the difference between relaunching a deliverable and running two
	 * workers on one branch.
	 */
	launch(spawn: WorkerSpawn): number | undefined {
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

		let reaped: () => void = () => {};
		const record: Launched = {
			child,
			output: "",
			exited: false,
			settled: new Promise<void>((resolve) => {
				reaped = resolve;
			}),
		};
		const append = (text: string): void => {
			record.output = (record.output + text).slice(-CAPTURE_CAP_BYTES);
		};
		child.stdout?.on("data", (b: Buffer) => append(b.toString("utf8")));
		child.stderr?.on("data", (b: Buffer) => append(b.toString("utf8")));
		child.on("exit", (code, signal) => {
			record.exited = true;
			append(`\n[pi exited code=${code ?? "?"} signal=${signal ?? "none"}]`);
			reaped();
		});
		child.on("error", (error) => {
			record.exited = true;
			append(`\n[spawn failed: ${error.message}]`);
			reaped();
		});
		// The worker outlives this call — that is the whole point of autonomous.
		child.unref();
		this.launched.set(spawn.agentId, record);
		return child.pid;
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

	/**
	 * Resolve once the process has been reaped.
	 *
	 * A socket closes the instant a process starts dying, but its exit status and
	 * last output arrive with the exit that follows. Anyone reporting a death
	 * has to wait for this or report one with no cause.
	 */
	async settled(agentId: string, timeoutMs = 2000): Promise<void> {
		const record = this.launched.get(agentId);
		if (!record || record.exited) return;
		await Promise.race([
			record.settled,
			new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
		]);
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
	killPidGroup(child.pid, signal);
}

/**
 * Signal a worker's whole process group by pid.
 *
 * Separate from {@link killGroup} because a RESTARTED maestro has no
 * `ChildProcess` for a worker its predecessor started — only the pid it wrote
 * down. That worker is holding a socket that no longer exists, so it can never
 * report and never be released; it is unreachable, not merely unsupervised.
 */
export function killPidGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		// Detached children lead their own process group (pgid = pid), so a
		// negative pid signals the whole group — pi plus anything it spawned.
		process.kill(-pid, signal);
	} catch {
		// Already gone, or never ours. Reaping is best-effort.
	}
}

/** Whether a pid is a live process. Signal 0 tests for existence, never kills. */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ─── Read-only agents: a call that returns ───────────────────────────────────

/**
 * Every tool pi itself defines. Pinned, because this list is passed to pi as a
 * `--tools` ALLOWLIST and pi silently ignores a name it does not recognise —
 * so a typo or a wish narrows an agent's tools with no error anywhere.
 *
 * Re-derive with:
 *   grep -rhoE 'name:\s*"[a-z_]+"' \
 *     node_modules/@earendil-works/pi-coding-agent/dist/core/tools/*.js | sort -u
 */
export const PI_BUILTINS = [
	"bash",
	"edit",
	"find",
	"grep",
	"ls",
	"read",
	"write",
] as const;

/**
 * The tools a read-only agent is launched with. A subset of {@link PI_BUILTINS}
 * — the ones that cannot change the tree.
 *
 * This list used to include `websearch` and `webfetch`. **Neither exists in
 * pi.** Both were inert in the allowlist, and worse, a guard test unioned this
 * list into its definition of "tools that exist" — so a refusal reading "Use
 * the webfetch tool" passed the very test written to catch refusals naming
 * tools nobody holds. A hand-written list serving as both the configuration
 * AND the test's notion of truth cannot catch its own errors.
 *
 * It also does NOT contain any tool of ours. A read-only agent registers
 * nothing: `extension.ts` returns early for a child with no wiring, so what it
 * is launched with is the whole of what it has.
 */
export const READ_ONLY_BUILTINS = ["read", "grep", "find", "ls"] as const;

/**
 * Tools from OUR extensions that a read-only agent may also call.
 *
 * The `--tools` allowlist filters extension tools too, not just pi's builtins —
 * so a name absent here is absent from the agent no matter which extension
 * defines it. `websearch` and `webfetch` come from `packages/research-tools`,
 * which every agent loads; they read the web and change nothing, which is
 * exactly what a read-only posture allows.
 */
export const READ_ONLY_EXTENSION_TOOLS = ["websearch", "webfetch"] as const;

/** Everything a read-only agent is launched with. */
export const READ_ONLY_TOOLS = [
	...READ_ONLY_BUILTINS,
	...READ_ONLY_EXTENSION_TOOLS,
] as const;

/**
 * The tool list a read-only agent's brief carries.
 *
 * Generated from what it is actually LAUNCHED with, not from the registry.
 * `describeFor("read-only")` used to supply this, and it named the subagent
 * tool — one the reader could not call, because it never registers our tools
 * and because it was not in its allowlist either. That is the phantom
 * grant this whole registry exists to prevent, reproduced inside it.
 */
export function describeReadOnlyTools(): string {
	return `## Your tools\n\n${READ_ONLY_TOOLS.map((name) => `- ${name}`).join(
		"\n",
	)}\n\nRead and search only. You cannot change anything, and you have no shell.`;
}

export interface ReadOnlyInvocation {
	readonly cwd: string;
	readonly args: readonly string[];
	readonly env: Record<string, string>;
	readonly model?: string;
}

export interface ReadOnlyInvocationOptions {
	/** Extension paths the child loads. Its whole non-builtin tool namespace. */
	readonly extensions: readonly string[];
	readonly model?: string;
	readonly agentDir?: string;
}

/**
 * The child pi invocation for a read-only agent. Pure, like the worker's.
 *
 * The env is built rather than inherited, and the important part is what it
 * LEAVES OUT: a read-only agent gets no socket path and no run token, so it
 * cannot dial the maestro and present itself as a worker. Its only channel is
 * the answer it returns to whoever asked.
 */
export function buildReadOnlyInvocation(
	spawn: ReadOnlySpawn,
	options: ReadOnlyInvocationOptions,
): ReadOnlyInvocation {
	const args = [
		"-ne",
		...options.extensions.flatMap((path) => ["-e", path]),
		"--no-session",
		"--tools",
		READ_ONLY_TOOLS.join(","),
		"--append-system-prompt",
		spawn.brief,
	];

	const env: Record<string, string> = {
		[DEPTH_ENV]: String((spawn.parentDepth ?? 0) + 1),
		// BLANKED, not omitted. Omitting only keeps a variable out if nothing
		// merges the parent's environment underneath — and pi's own RpcClient
		// spawns with `{...process.env, ...options.env}`, so an omitted variable
		// is an inherited one.
		//
		// What that cost: a reviewer inherited its worker's socket, token AND
		// agent id, dialled the maestro as that worker, and the maestro destroyed
		// the real worker's connection as a reconnect. The worker then sat alive
		// with nothing to report to, and the run recorded it as having stopped
		// without reporting. Nothing in the logs pointed at the reviewer.
		[SOCK_ENV]: "",
		[TOKEN_ENV]: "",
		[AGENT_ID_ENV]: "",
	};
	if (options.agentDir) env.PI_CODING_AGENT_DIR = options.agentDir;
	if (process.env.PATH) env.PATH = process.env.PATH;
	if (process.env.HOME) env.HOME = process.env.HOME;

	return {
		cwd: spawn.cwd,
		args,
		env,
		...((spawn.model ?? options.model)
			? { model: spawn.model ?? options.model }
			: {}),
	};
}

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
