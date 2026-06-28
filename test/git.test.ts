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
});

describe("worktree mechanics", () => {
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
