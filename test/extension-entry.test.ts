// The entry: which surface a process gets, and what the commands do with it.
//
// The guard worth noticing is the one that is no longer written down. `/mode`
// used to need an operator-only check so a spawned agent could not widen its
// own posture. An agent process now never registers the command, so there is
// nothing to remember and nothing to forget.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	extensionPath,
	type SeatHost,
	startSeat,
	startWorker,
} from "../packages/maestro/src/extension.js";
import { BUILT_IN_PERSONAS } from "../packages/maestro/src/personas.js";
import {
	AGENT_ID_ENV,
	SOCK_ENV,
	TOKEN_ENV,
} from "../packages/maestro/src/spawn.js";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "maestro-entry-"));
	dirs.push(root);
	const path = join(root, "project");
	execFileSync("mkdir", ["-p", path]);
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "T",
		GIT_AUTHOR_EMAIL: "t@e.com",
		GIT_COMMITTER_NAME: "T",
		GIT_COMMITTER_EMAIL: "t@e.com",
	};
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path, env });
	writeFileSync(join(path, "README.md"), "# project\n");
	execFileSync("git", ["add", "README.md"], { cwd: path, env });
	execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: path, env });
	return path;
}

function host() {
	const tools: { name: string }[] = [];
	const commands = new Map<
		string,
		{
			description: string;
			handler: (args: string, ctx: unknown) => Promise<void>;
		}
	>();
	const messages: string[] = [];
	const notices: [string, string][] = [];

	const pi: SeatHost = {
		registerTool: (tool) => tools.push(tool as { name: string }),
		registerCommand: (name, spec) =>
			commands.set(name, spec as ReturnType<typeof commands.get> & object),
		sendUserMessage: (text) => messages.push(text),
	};

	const ctx = {
		ui: { notify: (m: string, level: string) => notices.push([level, m]) },
	};

	return {
		pi,
		tools,
		messages,
		notices,
		run: (name: string, args = "") => {
			const command = commands.get(name);
			if (!command) throw new Error(`no /${name} registered`);
			return command.handler(args, ctx);
		},
		names: () => [...commands.keys()].sort(),
	};
}

describe("a process gets one surface, never both", () => {
	it("gives a seat its commands", () => {
		const h = host();
		startSeat(h.pi, { cwd: repo() });
		expect(h.names()).toEqual(["mode", "run"]);
	});

	it("gives a worker no commands at all", async () => {
		// The operator-only guard, made structural. There is no `/mode` to
		// refuse, so nothing has to remember to refuse it.
		const h = host();
		const started = startWorker(
			h.pi as unknown as { registerTool(tool: unknown): void },
			{
				agentId: "worker-api",
				socketPath: join(tmpdir(), "nothing-listening.sock"),
				token: "t",
				depth: 1,
			},
			{ extensions: [] },
		);
		// Nothing is listening, so the handshake fails — which is the point:
		// registration happened first, synchronously.
		await expect(started).rejects.toThrow();
		// `bash` is in the list because the SHELL is the thing safeguards guard.
		// A worker that got its shell any other way would have none.
		expect(h.tools.map((t) => t.name).sort()).toEqual([
			// No `ask` tool of our own: `ask` belongs to `packages/ask`, and what a
			// worker registers is a TRANSPORT that routes it to the maestro.
			"bash",
			"delegate",
			"finish",
		]);
		expect(h.names()).toEqual([]);
	});

	it("points a spawned agent at the file its maestro is running", () => {
		expect(extensionPath()).toMatch(/packages\/maestro\/src\/extension\.ts$/);
	});
});

describe("the seat is built on first use, not at load", () => {
	it("registers without touching the repository", () => {
		// An extension that reads a repo at load time is one that fails to load
		// outside a repo.
		const h = host();
		expect(() =>
			startSeat(h.pi, { cwd: join(tmpdir(), "definitely-not-a-repo") }),
		).not.toThrow();
		expect(h.tools).toEqual([]);
	});

	it("reports the problem to the human when there is no base branch", async () => {
		const outside = mkdtempSync(join(tmpdir(), "maestro-bare-"));
		dirs.push(outside);
		const h = host();
		startSeat(h.pi, { cwd: outside });
		await h.run("run", "arc");
		expect(h.notices[0]?.[0]).toBe("warning");
		expect(h.notices[0]?.[1]).toMatch(/cannot tell what to branch from/);
	});
});

describe("the commands", () => {
	it("reports and switches the posture", async () => {
		const h = host();
		startSeat(h.pi, { cwd: repo() });

		await h.run("mode");
		expect(h.notices[0]?.[1]).toBe("Mode is plan.");

		await h.run("mode", "hack");
		expect(h.notices[1]?.[1]).toContain("can write");
		expect(h.notices[1]?.[1]).toContain("safeguards off");
	});

	it("says which modes exist rather than accepting a wrong one", async () => {
		const h = host();
		startSeat(h.pi, { cwd: repo() });
		await h.run("mode", "yolo");
		expect(h.notices[0]?.[0]).toBe("warning");
		expect(h.notices[0]?.[1]).toContain("plan, auto, hack");
	});

	it("lists nothing when nothing is stored", async () => {
		const h = host();
		startSeat(h.pi, { cwd: repo() });
		await h.run("run");
		expect(h.notices[0]?.[1]).toBe("No plans stored yet.");
	});

	it("puts a refusal in front of the human, not in a stack trace", async () => {
		// Plan mode is the default, and it cannot run a plan — every deliverable
		// produces a worker.
		const h = host();
		startSeat(h.pi, { cwd: repo() });
		await h.run("run", "arc");
		expect(h.notices[0]?.[0]).toBe("warning");
	});

	it("registers the maestro's own tools once the seat exists", async () => {
		const h = host();
		startSeat(h.pi, { cwd: repo() });
		await h.run("mode");
		// No `ask` and no `finish`: the seat has nobody to report to and asks its
		// human directly. `respond` is the other half of a worker's `ask`.
		expect(h.tools.map((t) => t.name).sort()).toEqual([
			"bash",
			"delegate",
			"flight",
			"plan",
			"respond",
		]);
	});
});

describe("a worker delegates with the real personas", () => {
	it("resolves personas against the declared catalogue, not a made-up one", async () => {
		// The stub this replaced read `You are a ${agent}. Persona: ${persona}.`
		// — a brief that looks plausible and teaches a reviewer nothing about
		// what to look for. Asserted through an UNKNOWN persona, because the
		// error names what IS declared: if the worker were still inventing
		// briefs, every persona would resolve and nothing would be listed.
		const h = host();
		const started = startWorker(
			h.pi as unknown as { registerTool(tool: unknown): void },
			{
				agentId: "w",
				socketPath: join(tmpdir(), "nothing-listening.sock"),
				token: "t",
				depth: 1,
			},
			{ extensions: [] },
		);
		await expect(started).rejects.toThrow();

		const delegate = h.tools.find((t) => t.name === "delegate") as unknown as {
			execute: (id: string, p: unknown) => Promise<unknown>;
		};
		// Rejected while building the brief, before anything is spawned.
		await expect(
			delegate.execute("call-1", {
				agent: "reviewer",
				persona: "not-a-persona",
				question: "anything",
			}),
		).rejects.toThrow(
			new RegExp(BUILT_IN_PERSONAS.map((p) => p.id).join(".*")),
		);
	});

	it("refuses a persona belonging to another kind", async () => {
		const h = host();
		const started = startWorker(
			h.pi as unknown as { registerTool(tool: unknown): void },
			{
				agentId: "w",
				socketPath: join(tmpdir(), "nothing-listening.sock"),
				token: "t",
				depth: 1,
			},
			{ extensions: [] },
		);
		await expect(started).rejects.toThrow();

		const delegate = h.tools.find((t) => t.name === "delegate") as unknown as {
			execute: (id: string, p: unknown) => Promise<unknown>;
		};
		await expect(
			delegate.execute("call-1", {
				agent: "explorer",
				persona: "code-review",
				question: "anything",
			}),
		).rejects.toThrow(/is for a reviewer, not a explorer/);
	});
});

describe("the wiring a worker reads", () => {
	it("is the three variables the launcher sets", () => {
		// Named here so the entry and the launcher cannot drift on what a worker
		// needs to exist.
		expect([AGENT_ID_ENV, SOCK_ENV, TOKEN_ENV]).toEqual([
			"PI_MAESTRO_AGENT_ID",
			"PI_MAESTRO_SOCK",
			"PI_MAESTRO_TOKEN",
		]);
	});
});
