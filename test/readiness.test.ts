// Readiness: the questions asked of the machine, not of the document.
//
// The probe tests use REAL repositories. A faked "is this a working-tree root"
// would only assert that the fake was written correctly, and the whole value
// of this step is that it is the one place a plan meets the actual host. Only
// `gh` and the audited Bash runner are faked: one is a binary a CI machine may
// or may not have, and the other is the seat's own gate, which has its own
// tests and must not run `gh repo create` from this suite.

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanPolicy, PlanRepo } from "../packages/maestro/src/plan.js";
import {
	type AuditedBash,
	createRepository,
	type Problem,
	probeReadiness,
} from "../packages/maestro/src/readiness.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const temp = (label: string): string => {
	const dir = realpathSync(
		mkdtempSync(join(tmpdir(), `maestro-ready-${label}-`)),
	);
	dirs.push(dir);
	return dir;
};

const git = (cwd: string, ...args: string[]): void => {
	execFileSync("git", args, { cwd, stdio: "ignore" });
};

/** A repository with one commit on `main`, which is what a run branches from. */
const repo = (label: string): string => {
	const dir = temp(label);
	git(dir, "init", "--quiet", "-b", "main");
	git(dir, "config", "user.email", "readiness@example.invalid");
	git(dir, "config", "user.name", "Readiness Test");
	git(dir, "commit", "--allow-empty", "--quiet", "-m", "root");
	return dir;
};

const repos = (...paths: string[]): PlanRepo[] =>
	paths.map((path, index) => ({ key: `r${index + 1}`, path }));

const publish = (
	mode: "none" | "branch" | "pr",
	base?: string,
): PlanPolicy => ({ publish: { mode, ...(base ? { base } : {}) } });

/** `gh` is not on PATH unless a test says it is. */
const noGh = { ghPresent: () => false };
const withGh = { ghPresent: () => true };

const kinds = (problems: readonly Problem[]): string[] =>
	problems.map((problem) => problem.kind);

describe("what readiness finds at a repository path", () => {
	it("reports a path nothing exists at", () => {
		const missing = join(temp("gone"), "not-here");
		const found = probeReadiness(repos(missing), publish("none"), noGh);
		expect(found.ok).toBe(false);
		expect(kinds(found.problems)).toEqual(["missing-path"]);
		expect(found.problems[0]?.message).toContain(missing);
	});

	it("reports a path inside a repository but below its root", () => {
		const root = repo("below");
		const inside = join(root, "packages", "thing");
		mkdirSync(inside, { recursive: true });
		const found = probeReadiness(repos(inside), publish("none"), noGh);
		expect(kinds(found.problems)).toEqual(["not-a-root"]);
		const problem = found.problems[0];
		if (problem?.kind !== "not-a-root") throw new Error("expected not-a-root");
		// The real root is named, because "this is not a root" without it is a
		// message that tells an author nothing about what to write instead.
		expect(problem.root).toBe(root);
	});

	it("reports a directory that is no Git working tree at all", () => {
		const plain = temp("plain");
		const found = probeReadiness(repos(plain), publish("none"), noGh);
		expect(kinds(found.problems)).toEqual(["not-a-root"]);
		const problem = found.problems[0];
		if (problem?.kind !== "not-a-root") throw new Error("expected not-a-root");
		expect(problem.root).toBeNull();
	});

	it("reports an uncommitted change, and only reports it", () => {
		// Never a refusal here either: the caller decides whether to continue,
		// because every worktree branches from HEAD and only a human knows
		// whether the edits in the tree were meant to be in the run.
		const dirty = repo("dirty");
		writeFileSync(join(dirty, "scratch.txt"), "work in progress\n");
		const found = probeReadiness(repos(dirty), publish("none"), noGh);
		expect(kinds(found.problems)).toEqual(["dirty"]);
		expect(found.ok).toBe(false);
	});

	it("reports a base branch that does not resolve", () => {
		const clean = repo("nobase");
		const found = probeReadiness(
			repos(clean),
			publish("branch", "release"),
			noGh,
		);
		expect(kinds(found.problems)).toEqual(["missing-base"]);
		const problem = found.problems[0];
		if (problem?.kind !== "missing-base")
			throw new Error("expected missing-base");
		expect(problem.base).toBe("release");
	});

	it("is ok for a clean repository whose base exists", () => {
		const clean = repo("ready");
		const found = probeReadiness(repos(clean), publish("branch", "main"), noGh);
		expect(found.problems).toEqual([]);
		expect(found.ok).toBe(true);
	});

	it("asks nothing about a base that no publication will use", () => {
		// `mode: "none"` publishes nothing, so a recorded base describes a step
		// that will not happen. Refusing a run over an unused field is refusing
		// over nothing.
		const clean = repo("unused-base");
		const found = probeReadiness(
			repos(clean),
			publish("none", "release"),
			noGh,
		);
		expect(found.ok).toBe(true);
	});
});

describe("`gh` is a question the publication mode asks", () => {
	it("reports it missing when the plan publishes a pull request", () => {
		const clean = repo("pr");
		const found = probeReadiness(repos(clean), publish("pr", "main"), noGh);
		expect(kinds(found.problems)).toEqual(["missing-gh"]);
	});

	it("does not ask for it when the plan publishes a branch", () => {
		const clean = repo("branch");
		expect(
			probeReadiness(repos(clean), publish("branch", "main"), noGh).ok,
		).toBe(true);
	});

	it("does not ask for it when the plan publishes nothing", () => {
		const clean = repo("nopublish");
		expect(probeReadiness(repos(clean), publish("none"), noGh).ok).toBe(true);
	});

	it("is satisfied when it is on PATH", () => {
		const clean = repo("has-gh");
		expect(probeReadiness(repos(clean), publish("pr", "main"), withGh).ok).toBe(
			true,
		);
	});
});

describe("everything wrong with the machine, at once", () => {
	it("reports every repository's problem and the host's in one pass", () => {
		// One round trip per problem is how a caller learns to stop reading the
		// list — the same reason plan validation reports whole.
		const dirty = repo("multi-dirty");
		writeFileSync(join(dirty, "scratch.txt"), "edits\n");
		const missing = join(temp("multi-gone"), "absent");
		const found = probeReadiness(
			repos(dirty, missing),
			publish("pr", "release"),
			noGh,
		);
		expect(kinds(found.problems)).toEqual([
			"dirty",
			"missing-base",
			"missing-path",
			"missing-gh",
		]);
	});

	it("says nothing further about a repository that is not there", () => {
		// "is it clean" and "does its base exist" have no meaning for a path
		// that does not exist; answering them would bury the one problem that
		// does.
		const missing = join(temp("only-one"), "absent");
		const found = probeReadiness(repos(missing), publish("pr", "main"), withGh);
		expect(kinds(found.problems)).toEqual(["missing-path"]);
	});
});

describe("creating the repository a plan named", () => {
	const recorder = (): { commands: string[]; bash: AuditedBash } => {
		const commands: string[] = [];
		return {
			commands,
			bash: async (command) => {
				commands.push(command);
				return { ok: true, output: "" };
			},
		};
	};

	const missingAt = (path: string): Problem => ({
		kind: "missing-path",
		repo: { key: "wf", path },
		message: `repo \`wf\`: nothing exists at \`${path}\``,
	});

	it("refuses without the caller's confirmation, and runs nothing", async () => {
		const { commands, bash } = recorder();
		const creation = await createRepository(missingAt("/tmp/absent-repo"), {
			bash,
			confirmed: false,
			publish: { mode: "pr" },
		});
		expect(creation.ok).toBe(false);
		if (creation.ok) throw new Error("expected a refusal");
		expect(creation.reason).toContain("not confirmed");
		expect(commands).toEqual([]);
	});

	it("refuses a problem creation would not solve", async () => {
		const { commands, bash } = recorder();
		const creation = await createRepository(
			{
				kind: "dirty",
				repo: { key: "wf", path: "/tmp/dirty-repo" },
				message: "dirty",
			},
			{ bash, confirmed: true, publish: { mode: "none" } },
		);
		expect(creation.ok).toBe(false);
		expect(commands).toEqual([]);
	});

	it("issues exactly the expected commands, in order, for a pull-request plan", async () => {
		const { commands, bash } = recorder();
		const creation = await createRepository(missingAt("/src/pi-thing"), {
			bash,
			confirmed: true,
			publish: { mode: "pr" },
		});
		expect(creation.ok).toBe(true);
		expect(commands).toEqual([
			"git init /src/pi-thing",
			"git -C /src/pi-thing commit --allow-empty -m 'Initial commit'",
			"gh repo create pi-thing --private --source /src/pi-thing --remote origin",
		]);
	});

	it("does not touch `gh` when the plan publishes nothing", async () => {
		const { commands, bash } = recorder();
		await createRepository(missingAt("/src/pi-thing"), {
			bash,
			confirmed: true,
			publish: { mode: "none" },
		});
		expect(commands).toEqual([
			"git init /src/pi-thing",
			"git -C /src/pi-thing commit --allow-empty -m 'Initial commit'",
		]);
	});

	it("quotes a path the shell would otherwise split", async () => {
		const { commands, bash } = recorder();
		await createRepository(missingAt("/src/my repo"), {
			bash,
			confirmed: true,
			publish: { mode: "none" },
		});
		expect(commands[0]).toBe("git init '/src/my repo'");
	});

	it("stops at the first command the runner refuses", async () => {
		// A refusal from the gate and a failed command are the same thing here:
		// the tree is not what the next command assumes.
		const commands: string[] = [];
		const bash: AuditedBash = async (command) => {
			commands.push(command);
			return command.includes("git init")
				? { ok: true, output: "" }
				: { ok: false, output: "refused: you declined this command" };
		};
		const creation = await createRepository(missingAt("/src/pi-thing"), {
			bash,
			confirmed: true,
			publish: { mode: "pr" },
		});
		expect(creation.ok).toBe(false);
		if (creation.ok) throw new Error("expected a failure");
		expect(creation.reason).toContain("you declined this command");
		expect(commands).toHaveLength(2);
		expect(creation.commands).toHaveLength(2);
	});
});
