import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBranch, runCommand } from "@vegardx/pi-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAgentSessionFile,
	buildSpawnSpec,
	defaultAgentDir,
	provisionEnvironment,
	provisionWorktree,
} from "../packages/modes/src/exec/provisioner.js";
import { parseSessionFile } from "../packages/modes/src/session-fork.js";

let dir: string;
let repo: string;

function git(args: string[], cwd = repo): void {
	const r = runCommand("git", args, { cwd });
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

beforeEach(() => {
	// realpath: git reports canonical paths (macOS /var → /private/var).
	dir = realpathSync(mkdtempSync(join(tmpdir(), "maestro-provisioner-")));
	repo = join(dir, "repo");
	mkdirSync(repo, { recursive: true });
	git(["init", "-b", "main"]);
	git(["config", "user.name", "Test"]);
	git(["config", "user.email", "test@example.com"]);
	writeFileSync(join(repo, "README.md"), "# repo\n");
	git(["add", "README.md"]);
	git(["commit", "-m", "chore: init"]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("provisionWorktree", () => {
	it("creates a worktree on feat/<groupId> from the base branch", () => {
		const path = provisionWorktree({
			repoPath: repo,
			groupId: "g1",
			baseBranch: "main",
			worktreesRoot: join(dir, "wt"),
		});
		expect(path).toBe(join(dir, "wt", "g1"));
		expect(existsSync(join(path, "README.md"))).toBe(true);
		expect(currentBranch(path)).toBe("feat/g1");
	});

	it("is idempotent — a second call reuses the existing worktree", () => {
		const opts = {
			repoPath: repo,
			groupId: "g1",
			baseBranch: "main",
			worktreesRoot: join(dir, "wt"),
		};
		const first = provisionWorktree(opts);
		const second = provisionWorktree(opts);
		expect(second).toBe(first);
	});

	it("reuses an existing feat branch checked out elsewhere", () => {
		git(["branch", "feat/g2"]);
		git(["checkout", "feat/g2"]);
		const path = provisionWorktree({
			repoPath: repo,
			groupId: "g2",
			baseBranch: "main",
			worktreesRoot: join(dir, "wt"),
		});
		// Branch already checked out in the main repo — reuse that checkout.
		expect(path).toBe(repo);
	});

	it("throws a clear error when the base branch does not exist", () => {
		expect(() =>
			provisionWorktree({
				repoPath: repo,
				groupId: "g3",
				baseBranch: "no-such-branch",
				worktreesRoot: join(dir, "wt"),
			}),
		).toThrow(/worktree provisioning for group g3 .*failed/);
	});
});

describe("provisionEnvironment", () => {
	let worktree: string;

	beforeEach(() => {
		worktree = provisionWorktree({
			repoPath: repo,
			groupId: "env",
			baseBranch: "main",
			worktreesRoot: join(dir, "wt"),
		});
	});

	it("copies listed gitignored files and skips missing sources", async () => {
		writeFileSync(join(repo, ".env"), "SECRET=1\n");
		const result = await provisionEnvironment(worktree, repo, {
			copy: [".env", ".env.local"],
		});
		expect(result.copied).toEqual([".env"]);
		expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
		expect(existsSync(join(worktree, ".env.local"))).toBe(false);
	});

	it("copies nested paths, creating parent directories", async () => {
		mkdirSync(join(repo, "config", "local"), { recursive: true });
		writeFileSync(join(repo, "config", "local", "dev.json"), "{}\n");
		const result = await provisionEnvironment(worktree, repo, {
			copy: ["config/local/dev.json"],
		});
		expect(result.copied).toEqual(["config/local/dev.json"]);
		expect(existsSync(join(worktree, "config", "local", "dev.json"))).toBe(
			true,
		);
	});

	it("symlinks only explicitly listed paths", async () => {
		mkdirSync(join(repo, "vendor-cache"));
		writeFileSync(join(repo, "vendor-cache", "blob.bin"), "data");
		const result = await provisionEnvironment(worktree, repo, {
			linkPaths: ["vendor-cache"],
		});
		expect(result.linked).toEqual(["vendor-cache"]);
		const dest = join(worktree, "vendor-cache");
		expect(lstatSync(dest).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(dest, "blob.bin"), "utf8")).toBe("data");
	});

	it("throws when a linkPaths source is missing", async () => {
		await expect(
			provisionEnvironment(worktree, repo, { linkPaths: ["nope"] }),
		).rejects.toThrow(/linkPaths source nope does not exist/);
	});

	it("clones node_modules on macOS and skips setup when it applied", async () => {
		mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "x");
		const result = await provisionEnvironment(worktree, repo, {
			setupCommand: "touch setup.marker",
		});
		if (process.platform === "darwin") {
			expect(result.nodeModulesCloned).toBe(true);
			expect(
				existsSync(join(worktree, "node_modules", "pkg", "index.js")),
			).toBe(true);
			expect(result.setupRan).toBe(false);
			expect(existsSync(join(worktree, "setup.marker"))).toBe(false);
		} else {
			expect(result.nodeModulesCloned).toBe(false);
			expect(result.setupRan).toBe(true);
		}
	});

	it("skips setup when node_modules already exists in the worktree", async () => {
		// Re-activation: a previously provisioned worktree already has its
		// dependencies — setupCommand must not run again.
		mkdirSync(join(worktree, "node_modules", "pkg"), { recursive: true });
		const result = await provisionEnvironment(worktree, repo, {
			setupCommand: "touch setup.marker",
		});
		expect(result.nodeModulesCloned).toBe(false);
		expect(result.setupRan).toBe(false);
		expect(existsSync(join(worktree, "setup.marker"))).toBe(false);
	});

	it("runs the setup command without a shell when no fast-path applied", async () => {
		const result = await provisionEnvironment(worktree, repo, {
			setupCommand: "touch setup.marker",
		});
		expect(result.setupRan).toBe(true);
		expect(existsSync(join(worktree, "setup.marker"))).toBe(true);
	});

	it("does not interpret shell metacharacters in the setup command", async () => {
		// Under a shell `>redir.marker` would be a redirection creating
		// `redir.marker`; without one it is a literal filename argument.
		await provisionEnvironment(worktree, repo, {
			setupCommand: "touch a.marker >redir.marker",
		});
		expect(existsSync(join(worktree, "a.marker"))).toBe(true);
		expect(existsSync(join(worktree, ">redir.marker"))).toBe(true);
		expect(existsSync(join(worktree, "redir.marker"))).toBe(false);
	});

	it("throws with a clear message when the setup command fails", async () => {
		await expect(
			provisionEnvironment(worktree, repo, {
				setupCommand: "git rev-parse --verify no-such-ref",
			}),
		).rejects.toThrow(
			/setup command "git rev-parse --verify no-such-ref" failed/,
		);
	});
});

describe("buildAgentSessionFile", () => {
	it("builds header + modes-state + seed when no knowledge session given", () => {
		const outDir = join(dir, "sessions");
		const result = buildAgentSessionFile({
			agentKey: "g1/worker",
			seed: "# Your Tasks\ndo the thing",
			cwd: "/work/tree",
			outDir,
		});
		expect(result.path).toBe(join(outDir, "g1-worker.jsonl"));
		expect(result.forkedFrom).toBeUndefined();

		const { header, entries } = parseSessionFile(result.path);
		expect(header.type).toBe("session");
		expect(header.id).toBe(result.sessionId);
		expect(header.cwd).toBe("/work/tree");
		expect(header.parentSession).toBeUndefined();

		expect(entries).toHaveLength(2);
		const [state, seed] = entries as any[];
		expect(state.type).toBe("custom");
		expect(state.customType).toBe("maestro.modes.state");
		expect(state.data.mode).toBe("agent");
		expect(state.data.execution.stage).toBe("executing");
		expect(state.parentId).toBeNull();
		expect(seed.type).toBe("custom_message");
		expect(seed.customType).toBe("maestro.execution.seed");
		expect(seed.content).toBe("# Your Tasks\ndo the thing");
		expect(seed.display).toBe(true);
		expect(seed.parentId).toBe(state.id);
	});

	it("forks a knowledge session: fresh header, entries preserved, seed appended", () => {
		const knowledgeFile = join(dir, "base-knowledge.jsonl");
		const lines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "base-abc",
				timestamp: "2026-07-01T00:00:00.000Z",
				cwd: "/main/repo",
			}),
			JSON.stringify({
				type: "custom_message",
				customType: "maestro.base-knowledge",
				content: "# Codebase Reference\n> CONTEXT ONLY",
				display: true,
				id: "know-1",
				parentId: null,
				timestamp: "2026-07-01T00:00:01.000Z",
			}),
		];
		writeFileSync(knowledgeFile, `${lines.join("\n")}\n`);

		const outDir = join(dir, "sessions");
		const result = buildAgentSessionFile({
			agentKey: "g1/reviewer",
			seed: "# Your Tasks\nreview it",
			cwd: "/work/tree",
			outDir,
			knowledgeSessionPath: knowledgeFile,
		});
		expect(result.forkedFrom).toBe("base-abc");

		const { header, entries } = parseSessionFile(result.path);
		expect(header.id).toBe(result.sessionId);
		expect(header.id).not.toBe("base-abc");
		expect(header.parentSession).toBe("base-abc");
		expect(header.cwd).toBe("/work/tree");

		// Deterministic order: knowledge entries, modes state, seed.
		expect(entries).toHaveLength(3);
		const [knowledge, state, seed] = entries as any[];
		expect(knowledge.customType).toBe("maestro.base-knowledge");
		expect(knowledge.content).toContain("# Codebase Reference");
		expect(state.customType).toBe("maestro.modes.state");
		expect(state.parentId).toBe("know-1");
		expect(seed.customType).toBe("maestro.execution.seed");
		expect(seed.parentId).toBe(state.id);

		// The knowledge session itself is untouched (frozen).
		expect(readFileSync(knowledgeFile, "utf8")).toBe(`${lines.join("\n")}\n`);
	});

	it("gives each fork a distinct session id and file per agent key", () => {
		const outDir = join(dir, "sessions");
		const a = buildAgentSessionFile({
			agentKey: "g1/worker",
			seed: "s",
			cwd: "/w",
			outDir,
		});
		const b = buildAgentSessionFile({
			agentKey: "g1/reviewer",
			seed: "s",
			cwd: "/w",
			outDir,
		});
		expect(a.path).not.toBe(b.path);
		expect(a.sessionId).not.toBe(b.sessionId);
	});
});

describe("buildSpawnSpec", () => {
	const baseOpts = {
		sessionName: "maestro-g1-worker",
		worktreePath: "/work/tree",
		sessionFile: "/plans/slug/sessions/g1-worker.jsonl",
		extensionPaths: ["/ext/modes.ts", "/ext/provider.ts"],
		env: {
			sock: "/tmp/maestro.sock",
			agentId: "g1/worker",
			agentMode: "full",
			sessionDir: "/agent/sessions/g1-worker",
			token: "run-token-1",
		},
		kickoffMessage: "Implement the tasks in your seed.",
	};

	it("returns a structured argv spec with pi flags and kickoff last", () => {
		const spec = buildSpawnSpec(baseOpts);
		expect(spec.sessionName).toBe("maestro-g1-worker");
		expect(spec.cwd).toBe("/work/tree");
		expect(spec.command).toEqual([
			"pi",
			"-e",
			"/ext/modes.ts",
			"-e",
			"/ext/provider.ts",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--session",
			"/plans/slug/sessions/g1-worker.jsonl",
			"Implement the tasks in your seed.",
		]);
	});

	it("passes hazardous strings through as single argv elements, unquoted", () => {
		const spec = buildSpawnSpec({
			...baseOpts,
			kickoffMessage: 'do "this" && rm -rf $HOME; `boom`',
			extensionPaths: ["/ext/path with spaces/x.ts"],
		});
		expect(spec.command).toContain('do "this" && rm -rf $HOME; `boom`');
		expect(spec.command).toContain("/ext/path with spaces/x.ts");
		expect(spec.command.at(-1)).toBe('do "this" && rm -rf $HOME; `boom`');
		// No element picked up shell quoting.
		expect(spec.command.some((arg) => arg.startsWith('"'))).toBe(false);
	});

	it("maps env fields to PI_* variables including the run token", () => {
		const spec = buildSpawnSpec(baseOpts);
		expect(spec.env.PI_MAESTRO_SOCK).toBe("/tmp/maestro.sock");
		expect(spec.env.PI_MAESTRO_AGENT_ID).toBe("g1/worker");
		expect(spec.env.PI_MAESTRO_AGENT_MODE).toBe("full");
		expect(spec.env.PI_MAESTRO_TOKEN).toBe("run-token-1");
		expect(spec.env.PI_CODING_AGENT_SESSION_DIR).toBe(
			"/agent/sessions/g1-worker",
		);
	});

	it("defaults the agent dir to ~/.config/pi/agent (not ~/.pi/agent)", () => {
		const prev = process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		try {
			expect(defaultAgentDir()).toMatch(/\.config\/pi\/agent$/);
			expect(defaultAgentDir()).not.toContain("/.pi/");
			const spec = buildSpawnSpec(baseOpts);
			expect(spec.env.PI_CODING_AGENT_DIR).toMatch(/\.config\/pi\/agent$/);
		} finally {
			if (prev !== undefined) process.env.PI_CODING_AGENT_DIR = prev;
		}
	});

	it("prefers an explicit agentDir over the default", () => {
		const spec = buildSpawnSpec({
			...baseOpts,
			env: { ...baseOpts.env, agentDir: "/custom/agent" },
		});
		expect(spec.env.PI_CODING_AGENT_DIR).toBe("/custom/agent");
	});
});
