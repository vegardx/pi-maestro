// Live spawn wiring (v2): createLiveSpawnAgent is the production spawnAgent
// the runtime injects into the executor. A spawned agent's session file must
// fork the plan's frozen knowledge session (when present) and carry the
// persona seed head plus the executor's seed; resumes skip seeding entirely;
// the pi command omits --model only for cache-warm fresh spawns; stale tmux
// sessions are reaped before launch; and the PI_MAESTRO_* env is wired.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PersonaSummaryV1 } from "@vegardx/pi-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildKnowledgeSession,
	KNOWLEDGE_CUSTOM_TYPE,
	KNOWLEDGE_FRAME,
} from "../packages/modes/src/exec/knowledge.js";
import {
	createLiveSpawnAgent,
	type LiveSpawnTmux,
} from "../packages/modes/src/exec/live-spawn.js";
import { PlanEngineV2 } from "../packages/modes/src/plan/engine.js";
import type { SpawnNodeOpts } from "../packages/modes/src/plan/node-executor.js";
import { createPlanStoreV2 } from "../packages/modes/src/plan/storage.js";
import { EXECUTION_SEED_ENTRY } from "../packages/modes/src/session.js";

const TOKEN = "live-spawn-token";

const KNOWLEDGE_DOC = `${KNOWLEDGE_FRAME}

## Project Structure
packages/ holds the seams.

## Key Patterns
Injectable deps everywhere.

## Conventions
Tabs, biome.

## Key Interfaces
ExecutorDeps, ExecutionHandle.
`;

const PERSONA: PersonaSummaryV1 = {
	name: "coder",
	agents: ["worker"],
	contract: "summary-and-diff",
	skills: ["persona-skill"],
	prompt: "You are the coder persona. Build exactly what the seed asks.",
};

/** personas.v1 capability stub (the boundary live-spawn consumes). */
function stubPersonas(): { get(name: string): PersonaSummaryV1 | undefined } {
	return { get: (name) => (name === PERSONA.name ? PERSONA : undefined) };
}

interface TmuxCall {
	op: "spawn" | "hasSession" | "kill";
	name: string;
	cwd?: string;
	command?: string | string[];
	env?: Record<string, string>;
}

/** Ordered fake tmux; `alive` names report hasSession true until killed. */
function fakeTmux(alive: Set<string> = new Set()): {
	tmux: LiveSpawnTmux;
	calls: TmuxCall[];
} {
	const calls: TmuxCall[] = [];
	const tmux: LiveSpawnTmux = {
		async spawn(name, cwd, command, opts) {
			calls.push({ op: "spawn", name, cwd, command, env: opts?.env });
		},
		async hasSession(name) {
			calls.push({ op: "hasSession", name });
			return alive.has(name);
		},
		async kill(name) {
			calls.push({ op: "kill", name });
			alive.delete(name);
		},
	};
	return { tmux, calls };
}

type SessionLine = Record<string, unknown>;

function readSessionLines(path: string): SessionLine[] {
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as SessionLine);
}

function seedContent(lines: SessionLine[]): string {
	const seedEntry = lines.find((l) => l.customType === EXECUTION_SEED_ENTRY) as
		| { content?: string }
		| undefined;
	expect(seedEntry).toBeDefined();
	return seedEntry?.content ?? "";
}

const EXECUTOR_SEED =
	"## Deliverable: Implement Auth\n\n- [ ] **Create login endpoint**";

describe("live spawn wiring (createLiveSpawnAgent)", () => {
	let tmpDir: string;
	let planDir: string;
	let worktree: string;
	let engine: PlanEngineV2;
	let prevSessionDir: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "live-spawn-"));
		planDir = join(tmpDir, "plan");
		worktree = join(tmpDir, "wt");
		mkdirSync(worktree, { recursive: true });
		// A configured developer: writing agents refuse to spawn without an
		// identity to commit as, rather than inventing one (see git-identity).
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmpDir });
		execFileSync("git", ["config", "user.name", "Fixture Dev"], {
			cwd: tmpDir,
		});
		execFileSync("git", ["config", "user.email", "dev@fixture.test"], {
			cwd: tmpDir,
		});
		prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpDir, "sessions");

		engine = PlanEngineV2.create(createPlanStoreV2(join(tmpDir, "plans")), {
			slug: "live-spawn",
			title: "Live Spawn Plan",
			repoPath: tmpDir,
		});
		engine.addNode(null, {
			agent: "worker",
			persona: "coder",
			title: "Implement Auth",
			branch: "feat/implement-auth",
			tasks: ["Create login endpoint"],
		});
	});

	afterEach(() => {
		if (prevSessionDir === undefined) {
			delete process.env.PI_CODING_AGENT_SESSION_DIR;
		} else {
			process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDir;
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeSpawnAgent(opts?: {
		tmux?: LiveSpawnTmux;
		model?: { provider: string; id: string };
	}) {
		return createLiveSpawnAgent({
			engine,
			ctx: {
				cwd: tmpDir,
				model: opts?.model ?? { provider: "test", id: "worker" },
			} as unknown as ExtensionContext,
			tmux: opts?.tmux ?? fakeTmux().tmux,
			planDir,
			extensionPaths: ["/ext/maestro"],
			socketPath: join(tmpDir, "maestro.sock"),
			token: TOKEN,
			personas: stubPersonas(),
		});
	}

	function spawnOpts(overrides: Partial<SpawnNodeOpts> = {}): SpawnNodeOpts {
		return {
			nodeId: "implement-auth",
			agent: "worker",
			persona: "coder",
			displayName: "auth-worker",
			mode: "full",
			skills: ["node-skill"],
			worktreePath: worktree,
			seed: EXECUTOR_SEED,
			model: "test/worker",
			...overrides,
		};
	}

	it("forks the knowledge session and seeds the persona head + executor seed", async () => {
		const knowledge = buildKnowledgeSession({
			content: KNOWLEDGE_DOC,
			repoPath: tmpDir,
			outPath: join(planDir, "base-knowledge.jsonl"),
		});
		const { tmux, calls } = fakeTmux();
		const spawnAgent = makeSpawnAgent({ tmux });

		const spawned = await spawnAgent(spawnOpts());
		expect(spawned.sessionId).toBe("auth-worker");

		const lines = readSessionLines(spawned.sessionFile);

		// Header: fresh id, agent cwd, lineage back to the knowledge session
		// (pi convention: parentSession is the source file's path).
		const header = lines[0];
		expect(header.parentSession).toBe(knowledge.path);
		expect(header.id).not.toBe(knowledge.id);
		expect(header.cwd).toBe(worktree);

		// Knowledge entry precedes the seed entry (shared cache prefix first).
		const knowledgeIdx = lines.findIndex(
			(l) => l.customType === KNOWLEDGE_CUSTOM_TYPE,
		);
		const seedIdx = lines.findIndex(
			(l) => l.customType === EXECUTION_SEED_ENTRY,
		);
		expect(knowledgeIdx).toBeGreaterThan(0);
		expect(seedIdx).toBeGreaterThan(knowledgeIdx);

		// Persona head first (prompt + unioned skills + separator), then the
		// executor's seed.
		const seed = seedContent(lines);
		expect(seed.startsWith(PERSONA.prompt)).toBe(true);
		expect(seed).toContain("## Loaded skills");
		expect(seed).toContain("- persona-skill");
		expect(seed).toContain("- node-skill");
		expect(seed).toContain("---");
		expect(seed).toContain(EXECUTOR_SEED);
		expect(seed.indexOf(PERSONA.prompt)).toBeLessThan(
			seed.indexOf(EXECUTOR_SEED),
		);

		// The tmux launch: crash-capture wrapper (a shell string capturing the
		// pane into <planDir>/crashes/<session>.log), the -e extension list, the
		// assembled session file, and the fresh-worker kickoff.
		const spawn = calls.find((c) => c.op === "spawn");
		expect(spawn).toBeDefined();
		expect(spawn?.name).toBe("auth-worker");
		expect(spawn?.cwd).toBe(worktree);
		const command = spawn?.command;
		expect(typeof command).toBe("string");
		const cmd = command as string;
		expect(cmd).toContain("capture-pane");
		expect(cmd).toContain(join(planDir, "crashes", "auth-worker.log"));
		expect(cmd).toContain("/ext/maestro");
		expect(cmd).toContain(spawned.sessionFile);
		expect(cmd).toContain("Implement the tasks described in your seed.");
		// Cache-warm omission: the resolved model equals the maestro session's
		// (test/worker), so a FRESH spawn passes no --model and inherits it.
		expect(cmd).not.toContain("--model");

		// PI_MAESTRO_* env: socket, agent identity (the NODE id), mode, run
		// token, and the plan dir.
		expect(spawn?.env).toMatchObject({
			PI_MAESTRO_SOCK: join(tmpDir, "maestro.sock"),
			PI_MAESTRO_AGENT_ID: "implement-auth",
			PI_MAESTRO_AGENT_MODE: "full",
			PI_MAESTRO_TOKEN: TOKEN,
			PI_MAESTRO_PLAN_DIR: planDir,
		});
	});

	it("seeds without a knowledge fork when no base file exists", async () => {
		const spawnAgent = makeSpawnAgent();
		const spawned = await spawnAgent(spawnOpts());

		const lines = readSessionLines(spawned.sessionFile);
		const header = lines[0];
		expect(header.parentSession).toBeUndefined();
		expect(lines.some((l) => l.customType === KNOWLEDGE_CUSTOM_TYPE)).toBe(
			false,
		);

		const seed = seedContent(lines);
		expect(seed.startsWith(PERSONA.prompt)).toBe(true);
		expect(seed).toContain(EXECUTOR_SEED);
	});

	it("passes --model on a fresh spawn when it differs from the session model", async () => {
		const { tmux, calls } = fakeTmux();
		const spawnAgent = makeSpawnAgent({ tmux });

		await spawnAgent(spawnOpts({ model: "sit-openai/gpt-5.6-sol" }));

		const cmd = calls.find((c) => c.op === "spawn")?.command as string;
		expect(cmd).toContain("--model");
		expect(cmd).toContain("sit-openai/gpt-5.6-sol");
	});

	it("resume: reuses the session file, skips seeding, and ALWAYS passes the model", async () => {
		const resumeFile = join(tmpDir, "prior-session.jsonl");
		writeFileSync(resumeFile, "{}\n");
		const { tmux, calls } = fakeTmux();
		const spawnAgent = makeSpawnAgent({ tmux });

		// The resolved model EQUALS the maestro session model — a fresh spawn
		// would omit it, but a resume must pass it: pi otherwise restores a
		// possibly-stale model from the session file (the v1 #250 fix).
		const spawned = await spawnAgent(
			spawnOpts({ resumeSessionFile: resumeFile, model: "test/worker" }),
		);

		expect(spawned.sessionFile).toBe(resumeFile);
		// No fresh session assembly: the deterministic agent-key file was never
		// written.
		const assembled = join(
			tmpDir,
			"sessions",
			"agents",
			"auth-worker",
			"implement-auth.jsonl",
		);
		expect(existsSync(assembled)).toBe(false);

		const cmd = calls.find((c) => c.op === "spawn")?.command as string;
		expect(cmd).toContain("--model");
		expect(cmd).toContain("test/worker");
		expect(cmd).toContain(resumeFile);
		expect(cmd).toContain("Your session was resumed.");
	});

	it("kills stale tmux sessions (persisted + current name) before spawning", async () => {
		// A prior maestro epoch persisted a different session name on the
		// ledger; a crash orphan may also hold the CURRENT name.
		engine.setNodeRuntime("implement-auth", { sessionName: "stale-old" });
		const { tmux, calls } = fakeTmux(new Set(["stale-old", "auth-worker"]));
		const spawnAgent = makeSpawnAgent({ tmux });

		await spawnAgent(spawnOpts());

		const killed = calls
			.filter((c) => c.op === "kill")
			.map((c) => c.name)
			.sort();
		expect(killed).toEqual(["auth-worker", "stale-old"]);
		// Every kill happened BEFORE the spawn — the replacement never races a
		// zombie writer.
		const spawnIdx = calls.findIndex((c) => c.op === "spawn");
		const lastKillIdx = calls.map((c) => c.op).lastIndexOf("kill");
		expect(spawnIdx).toBeGreaterThan(lastKillIdx);
	});
});
