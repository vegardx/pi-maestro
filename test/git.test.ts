import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkoutOrCreateBranch,
	commit,
	createBranch,
	currentBranch,
	gitToplevel,
	hasChanges,
	headSha,
	isGitRepo,
	runCommand,
	stageFiles,
	UnsafeStageError,
	workingTreeClean,
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
