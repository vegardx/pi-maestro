// The seat: everything a running plan needs, assembled once.
//
// The last case here is the whole system in one test — a stored plan, a real
// socket, real worktrees, and real detached processes that speak the wire with
// nothing but `node:net`. It is the first thing in this rebuild that runs a
// plan end to end, and the only thing missing from a live drive is a model.

import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { plansRoot } from "../packages/maestro/src/paths.js";
import { BUILT_IN_PERSONAS } from "../packages/maestro/src/personas.js";
import type { Deliverable, Plan } from "../packages/maestro/src/plan.js";
import { PROTOCOL_VERSION } from "../packages/maestro/src/protocol.js";
import { createSeat, type Seat } from "../packages/maestro/src/seat.js";
import {
	AGENT_ID_ENV,
	DEPTH_ENV,
	SOCK_ENV,
	TOKEN_ENV,
} from "../packages/maestro/src/spawn.js";
import { createPlanStore } from "../packages/maestro/src/store.js";

const dirs: string[] = [];
const seats: Seat[] = [];
afterEach(async () => {
	for (const seat of seats.splice(0)) await seat.close();
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "T",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "T",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "maestro-seat-"));
	dirs.push(root);
	const path = join(root, "project");
	execFileSync("mkdir", ["-p", path]);
	git(path, "init", "-q", "-b", "main");
	// A repository a person actually uses has an identity. Without one the seat
	// refuses to run a plan, which is the point — a worker with no identity
	// reaches for `git config`, and in a linked worktree that rewrites the
	// identity for the whole repository.
	git(path, "config", "user.name", "T");
	git(path, "config", "user.email", "t@example.com");
	writeFileSync(join(path, "README.md"), "# project\n");
	git(path, "add", "README.md");
	git(path, "commit", "-q", "-m", "first");
	return path;
}

const deliverable = (
	id: string,
	over: Partial<Deliverable> = {},
): Deliverable => ({
	id,
	title: `Deliverable ${id}`,
	after: [],
	reads: [],
	tasks: [{ id: `${id}-1`, title: `do ${id}` }],
	...over,
});

const plan = (repoPath: string, over: Partial<Plan> = {}): Plan => ({
	slug: "arc",
	title: "Arc",
	preflight: [],
	deliverables: [deliverable("api")],
	postflight: [],
	repos: [{ key: "main", path: repoPath }],
	...over,
});

function seat(over: Partial<Parameters<typeof createSeat>[0]> = {}) {
	const said: string[] = [];
	const asked: string[] = [];
	const agentDir = mkdtempSync(join(tmpdir(), "maestro-agentdir-"));
	dirs.push(agentDir);
	const made = createSeat({
		narrator: { say: (l) => said.push(l), ask: (p) => asked.push(p) },
		extensions: [],
		base: "main",
		agentDir,
		...over,
	});
	seats.push(made);
	return { seat: made, said, asked, agentDir };
}

describe("the seat assembles one coherent set of parts", () => {
	it("declares every built-in persona against the tools that exist", () => {
		// `PersonaCatalogue.declare` rejects prose naming a declared tool. If a
		// persona ever starts teaching `finish` or `delegate` by name, this is
		// where it stops — before a live agent is told to call something.
		const { seat: s } = seat();
		expect([...s.personas.ids()].sort()).toEqual(
			BUILT_IN_PERSONAS.map((p) => p.id).sort(),
		);
	});

	it("gives each posture only what it holds", () => {
		const { seat: s } = seat();
		expect(s.tools.grantsFor("worker")).toContain("finish");
		expect(s.tools.grantsFor("maestro")).toContain("flight");
		expect(s.tools.grantsFor("maestro")).not.toContain("finish");
		expect(s.tools.grantsFor("read-only")).toEqual(["delegate"]);
	});

	it("says what plans exist when asked for one that does not", async () => {
		const { seat: s } = seat();
		await expect(s.run("nope")).rejects.toThrow(/no plan `nope`/);
	});
});

// A worker that speaks the wire with nothing but node:net: commits a file,
// reports, and waits to be released.
const FAKE_WORKER = `
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const env = { ...process.env, GIT_AUTHOR_NAME: 'W', GIT_AUTHOR_EMAIL: 'w@e.com',
  GIT_COMMITTER_NAME: 'W', GIT_COMMITTER_EMAIL: 'w@e.com' };
require('node:fs').writeFileSync('built.txt', 'the work\\n');
execFileSync('git', ['add', 'built.txt'], { cwd: process.cwd(), env });
execFileSync('git', ['commit', '-q', '-m', 'build it'], { cwd: process.cwd(), env });
const s = net.connect(process.env.${SOCK_ENV});
let buf = '';
s.on('connect', () => s.write(JSON.stringify({
  type: 'hello', v: ${PROTOCOL_VERSION},
  agentId: process.env.${AGENT_ID_ENV},
  token: process.env.${TOKEN_ENV}, pid: process.pid,
}) + '\\n'));
s.on('data', (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, at); buf = buf.slice(at + 1);
    const m = JSON.parse(line);
    if (m.type === 'welcome') s.write(JSON.stringify({
      type: 'done', outcome: 'succeeded',
      handoff: 'built at depth ' + process.env.${DEPTH_ENV},
    }) + '\\n');
    if (m.type === 'release') { s.end(); process.exit(0); }
  }
});
`;

describe("a plan runs, end to end", () => {
	it("takes a stored plan through worktree, worker, hand-off, ship and record", async () => {
		const repoPath = repo();
		const shipped: { branch: string; handoff?: string }[] = [];
		const {
			seat: s,
			said,
			agentDir,
		} = seat({
			// The only two substitutions: node instead of pi, and no network.
			// The launcher, the socket, the worktrees, the commits, the release
			// and the run record are all real.
			spawn: (_command, _args, options) =>
				nodeSpawn(process.execPath, ["-e", FAKE_WORKER], options),
			shippingOps: {
				push: async (_worktree, branch) => {
					shipped.push({ branch });
					return { ok: true };
				},
				findPr: async () => null,
				openPr: async () => 42,
			},
		});
		s.setMode("auto");

		createPlanStore(plansRoot(agentDir)).savePlan(
			plan(repoPath, {
				deliverables: [
					deliverable("api"),
					deliverable("ui", { after: ["api"], reads: ["api"] }),
				],
			}),
		);

		const executor = await s.run("arc");
		const settled = new Promise<void>((resolve) =>
			executor.on((event) => {
				if (event.type === "settled") resolve();
			}),
		);
		await settled;

		const run = executor.state();
		expect(run.preflight?.state).toBe("done");

		// `api` ran first, in its own worktree on its own branch, committed, and
		// reported a hand-off carrying the depth it read out of its environment.
		const api = run.deliverables.api;
		expect(api?.state).toBe("done");
		expect(api?.branch).toBe("deliverable/api");
		expect(api?.pr).toBe(42);
		expect(api?.handoff).toBe("built at depth 1");
		expect(git(api?.worktree as string, "log", "--oneline")).toContain(
			"build it",
		);

		// `ui` waited for it, then ran — and the DAG released it only after
		// `api` succeeded, which is the ordering the whole plan model exists for.
		expect(run.deliverables.ui?.state).toBe("done");
		expect(shipped.map((s) => s.branch)).toEqual([
			"deliverable/api",
			"deliverable/ui",
		]);

		expect(said).toContain("Started api — Deliverable api");
		expect(said).toContain("api shipped as #42");
		expect(said[said.length - 1]).toContain("shipped: api, ui");
	});
});
