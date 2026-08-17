import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Plan } from "../packages/maestro/src/plan.js";
import { compileStoredPlan } from "../packages/maestro/src/workflow/runner.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "maestro-runner-"));
	roots.push(root);
	const remote = join(root, "remote.git");
	const repo = join(root, "repo");
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" });
	execFileSync("git", ["init", "--bare", remote]);
	execFileSync("git", ["init", "-b", "main", repo]);
	writeFileSync(join(repo, "README.md"), "# fixture\n");
	git(repo, "add", "README.md");
	git(
		repo,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-m",
		"init",
	);
	git(repo, "remote", "add", "origin", remote);
	git(repo, "push", "-u", "origin", "main");
	git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
	git(repo, "remote", "set-head", "origin", "main");
	git(repo, "checkout", "-b", "feat/change");
	const plan: Plan = {
		slug: "change",
		title: "Change",
		repos: [{ key: "repo", path: repo }],
		deliverables: [
			{
				id: "change",
				title: "Change",
				repo: "repo",
				after: [],
				reads: [],
				tasks: [{ id: "implement", title: "Implement" }],
			},
		],
	};
	return { root, repo, plan };
}

describe("stored plan runner", () => {
	it("uses existing clean feature branches and local configuration", () => {
		const made = fixture();
		const compiled = compileStoredPlan({
			cwd: made.root,
			plan: made.plan,
			model: "openai/gpt-5",
		});
		expect(compiled.repositories).toEqual([
			{
				key: "repo",
				path: realpathSync(made.repo),
				branch: "feat/change",
				baseBranch: "main",
			},
		]);
	});

	it("refuses dirty repositories before model work starts", () => {
		const made = fixture();
		writeFileSync(join(made.repo, "dirty.txt"), "dirty\n");
		expect(() =>
			compileStoredPlan({
				cwd: made.root,
				plan: made.plan,
				model: "openai/gpt-5",
			}),
		).toThrow(/must be clean/);
	});
});
