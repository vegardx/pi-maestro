// Commit identity is resolved once by the harness and carried to agents as
// environment — never written as config by an agent.
//
// The incident this pins (2026-07-20): the bash ruleset told denied agents to
// "set it REPO-LOCALLY (`git config user.name ...` inside your worktree)". A
// linked worktree has no config of its own, so that write lands in the shared
// <repo>/.git/config — and this repository spent a day authoring every commit
// as `Test <test@example.com>` because an agent followed our own advice.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	gitIdentityEnv,
	missingIdentityMessage,
	resolveGitIdentity,
} from "@vegardx/pi-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSpawnSpec } from "../packages/modes/src/exec/provisioner.js";

let dir: string;
let repo: string;

function git(args: string[], cwd = repo): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "maestro-identity-"));
	repo = join(dir, "repo");
	mkdirSync(repo, { recursive: true });
	git(["init", "-q", "-b", "main"]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveGitIdentity", () => {
	it("is null when the developer configured none — never invented", () => {
		// vitest.setup.ts pins GIT_CONFIG_GLOBAL/SYSTEM to a sandbox, so this
		// is a true no-identity host regardless of who runs the suite.
		expect(resolveGitIdentity(repo)).toBeNull();
	});

	it("reads through git's own precedence chain", () => {
		git(["config", "user.name", "Real Developer"]);
		git(["config", "user.email", "dev@example.com"]);
		expect(resolveGitIdentity(repo)).toEqual({
			name: "Real Developer",
			email: "dev@example.com",
		});
	});

	it("treats a half-configured identity as none", () => {
		git(["config", "user.name", "Only A Name"]);
		expect(resolveGitIdentity(repo)).toBeNull();
	});

	it("names the operator fix without offering to make it", () => {
		const message = missingIdentityMessage(repo);
		expect(message).toContain("git config --global user.name");
		expect(message).toContain("The harness never writes git config");
	});
});

describe("the worktree config-sharing hazard this guards", () => {
	it("a worktree-local identity write lands in the SHARED repo config", () => {
		git(["config", "user.name", "Real Developer"]);
		git(["config", "user.email", "dev@example.com"]);
		git(["commit", "-q", "--allow-empty", "-m", "init"]);
		const worktree = join(dir, "wt");
		git(["worktree", "add", "-q", worktree, "-b", "feat/x"]);

		// What an agent "setting it locally, in its own worktree" actually does:
		git(["config", "user.email", "agent@invented"], worktree);

		expect(readFileSync(join(repo, ".git", "config"), "utf8")).toContain(
			"agent@invented",
		);
		// …and it re-authors the developer's own checkout, not just the worktree.
		expect(git(["config", "--get", "user.email"]).trim()).toBe(
			"agent@invented",
		);
	});
});

describe("identity reaches agents as environment", () => {
	const identity = { name: "Real Developer", email: "dev@example.com" };

	it("sets both AUTHOR and COMMITTER", () => {
		// git falls back to config — and then to a hostname guess — for
		// whichever half is missing, which is how a partial identity slips out.
		expect(gitIdentityEnv(identity)).toEqual({
			GIT_AUTHOR_NAME: "Real Developer",
			GIT_AUTHOR_EMAIL: "dev@example.com",
			GIT_COMMITTER_NAME: "Real Developer",
			GIT_COMMITTER_EMAIL: "dev@example.com",
		});
	});

	it("the spawn spec carries it, and omits it when absent", () => {
		const base = {
			sessionName: "s",
			worktreePath: repo,
			sessionFile: join(repo, "s.jsonl"),
			extensionPaths: [],
			kickoffMessage: "go",
			env: {
				sock: "/tmp/sock",
				agentId: "node-1",
				agentMode: "full",
				sessionDir: repo,
				token: "t",
				planDir: repo,
			},
		};
		expect(
			buildSpawnSpec({ ...base, env: { ...base.env, gitIdentity: identity } })
				.env,
		).toMatchObject({ GIT_AUTHOR_EMAIL: "dev@example.com" });
		expect(buildSpawnSpec(base).env.GIT_AUTHOR_EMAIL).toBeUndefined();
	});

	it("env beats config, so the developer's identity wins in the worktree", () => {
		git(["config", "user.name", "Stale Repo Identity"]);
		git(["config", "user.email", "stale@example.com"]);
		git(["commit", "-q", "--allow-empty", "-m", "init"]);
		execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "agent work"], {
			cwd: repo,
			env: { ...process.env, ...gitIdentityEnv(identity) },
		});
		expect(git(["log", "-1", "--pretty=%an <%ae>"]).trim()).toBe(
			"Real Developer <dev@example.com>",
		);
	});
});
