// Starting agents: the two mechanisms, and the rules about who may start whom.
//
// The integration case at the bottom launches a REAL detached process that
// speaks the wire protocol with nothing but `node:net` and the three
// environment variables it was given. Nothing in it imports our types, so it
// proves the contract rather than restating it — and it is the first thing in
// this rebuild where spawn, env, socket, handshake, result and release all run
// together.

import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentKind } from "../packages/maestro/src/agent.js";
import { MaestroLink } from "../packages/maestro/src/link.js";
import { PROTOCOL_VERSION } from "../packages/maestro/src/protocol.js";
import {
	AGENT_ID_ENV,
	askReadOnly,
	buildWorkerCommand,
	checkSpawn,
	currentDepth,
	DEPTH_ENV,
	EmptyAnswer,
	MAX_DEPTH,
	type ReadOnlySession,
	SOCK_ENV,
	TOKEN_ENV,
	WorkerLauncher,
	type WorkerSpawn,
} from "../packages/maestro/src/spawn.js";

const dirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "maestro-spawn-"));
	dirs.push(dir);
	return dir;
}

const links: MaestroLink[] = [];
const launchers: WorkerLauncher[] = [];

afterEach(async () => {
	for (const launcher of launchers.splice(0)) launcher.killAll();
	for (const link of links.splice(0)) await link.close();
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const worker = (over: Partial<WorkerSpawn> = {}): WorkerSpawn => ({
	agentId: "worker-1",
	cwd: "/worktrees/api",
	sessionFile: "/sessions/worker-1.jsonl",
	kickoff: "Build the API deliverable.",
	socketPath: "/tmp/maestro.sock",
	token: "run-token-1",
	extensions: ["/repo/packages/maestro"],
	...over,
});

describe("the worker command is the contract with pi", () => {
	it("loads only what maestro names", () => {
		const { argv } = buildWorkerCommand(
			worker({ extensions: ["/a", "/b"], model: "claude-opus-5" }),
		);
		// The pi THIS process runs, not the bare name `pi`: that resolves through
		// PATH to a shim symlinked at `../dist/cli.js`, which a child started
		// from a worktree resolves relative to the wrong directory — it dies with
		// MODULE_NOT_FOUND before it can dial home. A live drive found this.
		expect(argv.slice(0, 2)).toEqual([process.execPath, process.argv[1]]);
		// `-ne` next: a globally installed extension can shadow a tool name, and
		// then the agent calls something nobody here wrote.
		expect(argv.slice(2, 7)).toEqual(["-ne", "-e", "/a", "-e", "/b"]);
		expect(argv).toContain("--no-skills");
		expect(argv).toContain("--no-context-files");
		// Model and session sit immediately before the brief.
		expect(argv.slice(-5, -1)).toEqual([
			"--model",
			"claude-opus-5",
			"--session",
			"/sessions/worker-1.jsonl",
		]);
	});

	it("puts the brief last, where pi takes it as the opening message", () => {
		const { argv } = buildWorkerCommand(worker({ kickoff: "Do the thing." }));
		expect(argv[argv.length - 1]).toBe("Do the thing.");
	});

	it("omits the model when there is none, rather than passing an empty flag", () => {
		expect(buildWorkerCommand(worker()).argv).not.toContain("--model");
	});

	it("takes an explicit pi when given one", () => {
		expect(
			buildWorkerCommand(
				worker({ piCommand: ["/usr/bin/node", "/opt/pi.js"] }),
			).argv.slice(0, 2),
		).toEqual(["/usr/bin/node", "/opt/pi.js"]);
	});
});

describe("the child's environment is built, never inherited", () => {
	it("hands over exactly what dialling home needs", () => {
		const { env } = buildWorkerCommand(worker());
		expect(env[SOCK_ENV]).toBe("/tmp/maestro.sock");
		expect(env[TOKEN_ENV]).toBe("run-token-1");
		expect(env[AGENT_ID_ENV]).toBe("worker-1");
		expect(env[DEPTH_ENV]).toBe("1");
	});

	it("does not leak the maestro's own wiring into the child", () => {
		// A maestro that is itself running under PI_MAESTRO_* — as it is inside
		// its own e2e harness — must not pass its socket to a worker that is
		// supposed to receive its own.
		const before = process.env[SOCK_ENV];
		process.env[SOCK_ENV] = "/tmp/SOMEONE-ELSES.sock";
		try {
			const { env } = buildWorkerCommand(worker());
			expect(env[SOCK_ENV]).toBe("/tmp/maestro.sock");
		} finally {
			if (before === undefined) delete process.env[SOCK_ENV];
			else process.env[SOCK_ENV] = before;
		}
	});

	it("carries no variable that nothing reads", () => {
		// Pinned deliberately. The old spawn passed PI_MAESTRO_PLAN_DIR,
		// _GENERATION and _PLAN_FINGERPRINT as well; the first is unnecessary
		// because a worker is briefed rather than sent to read the plan, and the
		// other two belong to a respawn model this protocol replaced with
		// `resumed`.
		const { env } = buildWorkerCommand(
			worker({ agentDir: "/cfg", sessionDir: "/sessions" }),
		);
		expect(
			Object.keys(env)
				.filter((k) => k.startsWith("PI_"))
				.sort(),
		).toEqual(
			[
				AGENT_ID_ENV,
				DEPTH_ENV,
				SOCK_ENV,
				TOKEN_ENV,
				"PI_CODING_AGENT_DIR",
				"PI_CODING_AGENT_SESSION_DIR",
			].sort(),
		);
	});

	it("passes git identity as environment, never as config", () => {
		// A linked worktree SHARES the repo's config file, so `git config` inside
		// one rewrites it for every worktree and for the user. That has happened
		// here twice.
		const { env } = buildWorkerCommand(
			worker({ gitIdentity: { name: "Maestro", email: "m@example.com" } }),
		);
		expect(env.GIT_AUTHOR_EMAIL).toBe("m@example.com");
		expect(env.GIT_COMMITTER_NAME).toBe("Maestro");
	});

	it("counts depth from the spawner, not from zero", () => {
		expect(buildWorkerCommand(worker({ parentDepth: 1 })).env[DEPTH_ENV]).toBe(
			"2",
		);
		expect(currentDepth({ [DEPTH_ENV]: "2" })).toBe(2);
		expect(currentDepth({})).toBe(0);
		expect(currentDepth({ [DEPTH_ENV]: "nonsense" })).toBe(0);
	});
});

describe("who may start whom", () => {
	it("lets the maestro start anything", () => {
		for (const kind of ["worker", "explorer", "reviewer", "advisor"] as const)
			expect(checkSpawn(kind, 0)).toBeNull();
	});

	it("refuses a worker below the maestro", () => {
		// A worker's own tools are enough to launch one, so this has to be a rule
		// rather than an omission.
		expect(checkSpawn("worker", 1)).toMatch(/only the maestro spawns writers/);
	});

	it("lets a worker consult readers", () => {
		expect(checkSpawn("reviewer", 1)).toBeNull();
		expect(checkSpawn("explorer", MAX_DEPTH - 1)).toBeNull();
	});

	it("stops at the nesting limit whatever the kind", () => {
		expect(checkSpawn("explorer", MAX_DEPTH)).toMatch(/nesting limit/);
	});

	it("never spawns a maestro", () => {
		expect(checkSpawn("maestro", 0)).toMatch(/never spawned/);
	});

	it("refuses at the launcher too, not only in the check", () => {
		const launcher = new WorkerLauncher();
		launchers.push(launcher);
		expect(() => launcher.launch(worker({ parentDepth: 1 }))).toThrow(
			/only the maestro spawns writers/,
		);
	});
});

describe("a read-only agent is a call that returns", () => {
	const session = (text: string | null) => {
		const calls: string[] = [];
		const impl: ReadOnlySession = {
			async start() {
				calls.push("start");
			},
			async prompt(p) {
				calls.push(`prompt:${p}`);
			},
			async getLastAssistantText() {
				return text;
			},
			async stop() {
				calls.push("stop");
			},
		};
		return { impl, calls };
	};

	const ask = (kind: AgentKind, text: string | null, depth = 1) => {
		const s = session(text);
		return {
			calls: s.calls,
			result: askReadOnly(
				{
					kind,
					cwd: "/repo",
					brief: "Look for X.",
					prompt: "Review the diff.",
					parentDepth: depth,
				},
				async () => s.impl,
			),
		};
	};

	it("starts, prompts, and returns what was said", async () => {
		const { calls, result } = ask("reviewer", "  Two findings.  ");
		expect(await result).toBe("Two findings.");
		expect(calls).toEqual(["start", "prompt:Review the diff.", "stop"]);
	});

	it("treats an empty answer as a failure, not as 'nothing found'", async () => {
		// Silence and "I looked and found nothing" are different claims. A system
		// that reads them alike is how six real findings became "(agent produced
		// no summary)".
		await expect(ask("reviewer", "   ").result).rejects.toThrow(EmptyAnswer);
		await expect(ask("explorer", null).result).rejects.toThrow(EmptyAnswer);
	});

	it("stops the session even when the answer was no good", async () => {
		const { calls, result } = ask("reviewer", null);
		await expect(result).rejects.toThrow(EmptyAnswer);
		expect(calls).toContain("stop");
	});

	it("refuses to await something nobody waits on", async () => {
		await expect(ask("worker", "anything").result).rejects.toThrow(
			/is not asked and awaited/,
		);
	});

	it("obeys the nesting limit", async () => {
		await expect(ask("reviewer", "x", MAX_DEPTH).result).rejects.toThrow(
			/nesting limit/,
		);
	});
});

// A worker that speaks the protocol using nothing but node:net and the three
// environment variables it was handed. It shares no code with us on purpose.
const FAKE_WORKER = `
const net = require('node:net');
const sock = process.env.${SOCK_ENV};
const s = net.connect(sock);
let buf = '';
s.on('connect', () => {
  process.stdout.write('dialled home\\n');
  s.write(JSON.stringify({
    type: 'hello', v: ${PROTOCOL_VERSION},
    agentId: process.env.${AGENT_ID_ENV},
    token: process.env.${TOKEN_ENV},
    pid: process.pid,
  }) + '\\n');
});
s.on('data', (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, at); buf = buf.slice(at + 1);
    const m = JSON.parse(line);
    if (m.type === 'welcome') {
      s.write(JSON.stringify({
        type: 'done', outcome: 'succeeded',
        handoff: 'depth was ' + process.env.${DEPTH_ENV},
      }) + '\\n');
    }
    if (m.type === 'release') { s.end(); process.exit(0); }
  }
});
`;

describe("a launched worker dials home, reports, and waits", () => {
	it("runs the whole path on real processes and a real socket", async () => {
		const dir = scratch();
		const socketPath = join(dir, "m.sock");
		const link = new MaestroLink({ token: "run-token-1" });
		links.push(link);
		await link.listen(socketPath);

		// Everything except the binary is the real launcher: detached, its own
		// process group, env built by buildWorkerCommand.
		const launcher = new WorkerLauncher({
			spawn: (_command, _args, options) =>
				nodeSpawn(process.execPath, ["-e", FAKE_WORKER], options),
		});
		launchers.push(launcher);

		const reported = new Promise<{ handoff?: string }>((resolve) =>
			link.once("done", (_id, done) => resolve(done)),
		);
		const gone = new Promise<boolean>((resolve) =>
			link.once("disconnected", (_id, awaiting) => resolve(awaiting)),
		);

		launcher.launch(
			worker({ cwd: dir, socketPath, sessionFile: join(dir, "s.jsonl") }),
		);

		const done = await reported;
		// The env reached the child and it read its own depth out of it.
		expect(done.handoff).toBe("depth was 1");
		expect(link.awaitingRelease()).toEqual(["worker-1"]);

		// Still alive: it reported, and it is waiting to be let go.
		await new Promise((r) => setTimeout(r, 50));
		expect(launcher.alive("worker-1")).toBe(true);

		link.release("worker-1");
		expect(await gone).toBe(true);
		expect(launcher.capture("worker-1")).toContain("dialled home");
	});

	it("keeps what a worker printed on its way down", async () => {
		const launcher = new WorkerLauncher({
			spawn: (_command, _args, options) =>
				nodeSpawn(
					process.execPath,
					["-e", "process.stderr.write('provider exploded'); process.exit(3)"],
					options,
				),
		});
		launchers.push(launcher);
		launcher.launch(worker({ cwd: scratch() }));

		await new Promise((r) => setTimeout(r, 150));
		// Without this, a worker that dies before dialling home leaves nothing on
		// the socket and nothing in a session file, and the failure reads as "the
		// agent did nothing".
		expect(launcher.capture("worker-1")).toContain("provider exploded");
		expect(launcher.capture("worker-1")).toContain("code=3");
		expect(launcher.alive("worker-1")).toBe(false);
	});
});
