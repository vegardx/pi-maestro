import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunId } from "@vegardx/pi-contracts";
import {
	addWorktree,
	agentWorktreePath,
	checkoutOrCreateBranch,
	commit,
	createBranch,
	currentBranch,
	findCheckoutOf,
	gitToplevel,
	hasChanges,
	headSha,
	isGitRepo,
	listWorktrees,
	parseWorktreeList,
	removeWorktree,
	runCommand,
	stageFiles,
	UnsafeStageError,
	workingTreeClean,
	worktreeBaseSha,
	worktreesRoot,
} from "@vegardx/pi-git";

let dir: string;
let repo: string;

function git(args: string[], cwd = repo): void {
	const r = runCommand("git", args, { cwd });
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "maestro-git-"));
	repo = join(dir, "repo");
	mkdirSync(repo, { recursive: true });
	git(["init", "-b", "main"]);
	git(["config", "user.name", "Test"]);
	git(["config", "user.email", "test@example.com"]);
	writeFileSync(join(repo, "README.md"), "# repo\n");
	stageFiles(repo, ["README.md"]);
	commit(repo, "chore: init");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pure helpers", () => {
	it("computes the reserved agent worktree path", () => {
		const p = agentWorktreePath("/a/b/myrepo", "run-123" as RunId);
		expect(p).toBe(resolve("/a/b/worktrees/myrepo/_agents/run-123"));
		expect(worktreesRoot("/a/b/myrepo")).toBe(resolve("/a/b/worktrees/myrepo"));
	});

	it("parses git worktree list --porcelain", () => {
		const out = [
			"worktree /repo",
			"HEAD abc123",
			"branch refs/heads/main",
			"",
			"worktree /wt/feature",
			"HEAD def456",
			"branch refs/heads/feature",
			"",
			"worktree /wt/bare",
			"HEAD 000",
			"detached",
			"",
		].join("\n");
		const entries = parseWorktreeList(out);
		expect(entries).toHaveLength(3);
		expect(entries[0]).toMatchObject({ path: "/repo", branch: "main" });
		expect(entries[1].branch).toBe("feature");
		expect(entries[2].detached).toBe(true);
	});
});

describe("staging safety", () => {
	it("rejects broad pathspecs", () => {
		for (const spec of [".", "-A", "--all", "-u", "*", ""]) {
			expect(() => stageFiles(repo, [spec])).toThrow(UnsafeStageError);
		}
		expect(() => stageFiles(repo, [])).toThrow(UnsafeStageError);
	});

	it("stages and commits explicit paths only", () => {
		writeFileSync(join(repo, "a.txt"), "a\n");
		writeFileSync(join(repo, "b.txt"), "b\n");
		const r = stageFiles(repo, ["a.txt"]);
		expect(r.ok).toBe(true);
		// b.txt stays untracked
		const staged = runCommand("git", ["diff", "--cached", "--name-only"], {
			cwd: repo,
		});
		expect(staged.stdout.trim()).toBe("a.txt");
		expect(hasChanges(repo)).toBe(true);
	});

	it("commits messages with apostrophes via stdin", () => {
		writeFileSync(join(repo, "c.txt"), "c\n");
		stageFiles(repo, ["c.txt"]);
		const r = commit(repo, "fix: don't break on Vegard's quote");
		expect(r.ok).toBe(true);
		const log = runCommand("git", ["log", "-1", "--pretty=%s"], { cwd: repo });
		expect(log.stdout.trim()).toBe("fix: don't break on Vegard's quote");
	});
});

describe("repo + branch ops", () => {
	it("reports repo state", () => {
		expect(isGitRepo(repo)).toBe(true);
		expect(isGitRepo(dir)).toBe(false);
		expect(currentBranch(repo)).toBe("main");
		expect(workingTreeClean(repo)).toBe(true);
		expect(headSha(repo)).toMatch(/^[0-9a-f]{40}$/);
	});

	it("creates and switches branches", () => {
		expect(createBranch(repo, "feature").ok).toBe(true);
		expect(currentBranch(repo)).toBe("feature");
	});

	it("checkoutOrCreateBranch creates a missing branch off the base", () => {
		expect(checkoutOrCreateBranch(repo, "feat/new", "main").ok).toBe(true);
		expect(currentBranch(repo)).toBe("feat/new");
	});

	it("checkoutOrCreateBranch switches to an existing branch", () => {
		createBranch(repo, "feat/exists");
		git(["checkout", "main"]);
		expect(currentBranch(repo)).toBe("main");
		expect(checkoutOrCreateBranch(repo, "feat/exists", "main").ok).toBe(true);
		expect(currentBranch(repo)).toBe("feat/exists");
	});

	it("gitToplevel returns the repo root from a subdirectory", () => {
		const sub = join(repo, "packages", "x");
		mkdirSync(sub, { recursive: true });
		expect(gitToplevel(sub)).toBe(realpathSync(repo));
		expect(gitToplevel(dir)).toBeNull();
	});
});

describe("worktree mechanics", () => {
	it("resolves a base that exists only as a remote-tracking ref", () => {
		// origin's default branch changed (e.g. to dev) and was fetched, but no
		// local branch tracks it — the reference that crashed provisioning.
		git(["update-ref", "refs/remotes/origin/dev", "HEAD"]);
		const target = agentWorktreePath(repo, "run-remote" as RunId);
		const res = addWorktree(repo, target, "agent/run-remote", "dev");
		expect(res).toMatchObject({ ok: true, created: true });
	});

	it("fails with a clear message when the base branch exists nowhere", () => {
		const target = agentWorktreePath(repo, "run-nobase" as RunId);
		const res = addWorktree(repo, target, "agent/run-nobase", "dev");
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toContain('base branch "dev" not found');
			expect(res.error).toContain("origin/dev");
		}
	});

	it("adds a worktree on a new branch and lists it", () => {
		const target = agentWorktreePath(repo, "run-abc" as RunId);
		const res = addWorktree(repo, target, "agent/run-abc", "main");
		expect(res).toMatchObject({ ok: true, created: true });
		expect(findCheckoutOf(repo, "agent/run-abc")).toBe(realpathSync(target));
		expect(listWorktrees(repo).some((w) => w.branch === "agent/run-abc")).toBe(
			true,
		);
	});

	it("reuses an existing checkout instead of failing", () => {
		createBranch(repo, "already"); // now checked out in the main repo
		const target = agentWorktreePath(repo, "run-x" as RunId);
		const res = addWorktree(repo, target, "already", "main");
		expect(res).toMatchObject({ ok: true, created: false });
		if (res.ok) expect(res.path).toBe(realpathSync(repo));
	});

	it("removes a clean worktree and refuses the main one", () => {
		const target = agentWorktreePath(repo, "run-rm" as RunId);
		addWorktree(repo, target, "agent/rm", "main");
		expect(removeWorktree(repo, target).ok).toBe(true);
		const main = removeWorktree(repo, repo);
		expect(main.ok).toBe(false);
		if (!main.ok) expect(main.reason).toBe("main");
	});

	it("refuses a dirty worktree unless forced", () => {
		const target = agentWorktreePath(repo, "run-dirty" as RunId);
		addWorktree(repo, target, "agent/dirty", "main");
		writeFileSync(join(target, "scratch.txt"), "wip\n");
		const dirty = removeWorktree(repo, target);
		expect(dirty.ok).toBe(false);
		if (!dirty.ok) expect(dirty.reason).toBe("dirty");
		expect(removeWorktree(repo, target, { force: true }).ok).toBe(true);
	});
});

describe("worktreeBaseSha", () => {
	/** Commit on the current branch and return its SHA. */
	function commitOn(file: string, message: string): string {
		writeFileSync(join(repo, file), `${message}\n`);
		stageFiles(repo, [file]);
		commit(repo, message);
		const sha = headSha(repo);
		if (!sha) throw new Error("no HEAD after commit");
		return sha;
	}

	it("resolves a stacked base to the base branch tip, not the checkout HEAD", () => {
		const mainSha = headSha(repo);
		git(["checkout", "-b", "feat/d1"]);
		const d1Sha = commitOn("d1.txt", "feat: d1 work");
		git(["checkout", "main"]); // the user's checkout sits on main again
		expect(d1Sha).not.toBe(mainSha);
		// A stacked deliverable d2 based on d1's branch: its delivery base is
		// d1's tip — the old headSha(repo) capture would have recorded mainSha.
		expect(worktreeBaseSha(repo, "feat/d2", "feat/d1")).toBe(d1Sha);
		expect(headSha(repo)).toBe(mainSha);
	});

	it("resolves an existing branch to its fork point off the base", () => {
		git(["checkout", "-b", "feat/d1"]);
		const forkPoint = commitOn("d1.txt", "feat: d1 work");
		git(["checkout", "-b", "feat/d2"]);
		commitOn("d2.txt", "feat: d2 work");
		git(["checkout", "feat/d1"]);
		commitOn("d1b.txt", "feat: d1 advanced past the fork");
		git(["checkout", "main"]);
		// feat/d2 already exists; its base branch tip moved on. The recorded
		// base must be the fork point, not the advanced tip.
		expect(worktreeBaseSha(repo, "feat/d2", "feat/d1")).toBe(forkPoint);
	});

	it("resolves a remote-only base and returns null for a missing one", () => {
		git(["update-ref", "refs/remotes/origin/dev", "HEAD"]);
		expect(worktreeBaseSha(repo, "feat/dx", "dev")).toBe(headSha(repo));
		expect(worktreeBaseSha(repo, "feat/dy", "nope")).toBeNull();
	});
});
