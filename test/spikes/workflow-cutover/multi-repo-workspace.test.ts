// W0 capability spike: one maestro run rooted above several independent Git
// repositories. This is intentionally a test-local coordinator. It proves the
// existing workspace and git primitives are sufficient before production
// multi-repository state is designed around them.

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	gitToplevel,
	headSha,
	resolveGitIdentity,
	stageAndCommit,
	workingTreeClean,
} from "@vegardx/pi-git";
import { afterEach, describe, expect, it } from "vitest";
import type { Deliverable } from "../../../packages/maestro/src/plan.js";
import { createWorkspace } from "../../../packages/maestro/src/workspace.js";

type RepositoryKey = "contracts" | "api" | "deploy";

interface RepositoryFixture {
	readonly key: RepositoryKey;
	readonly source: string;
	readonly remote: string;
	readonly identity: { readonly name: string; readonly email: string };
}

interface CoordinatedCheckout extends RepositoryFixture {
	readonly worktree: string;
	readonly branch: string;
}

interface DependencyArtifact {
	readonly repository: RepositoryKey;
	readonly commit: string;
	readonly path: string;
}

const roots: string[] = [];
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

afterEach(() => {
	if (originalGitConfigGlobal === undefined)
		delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
	while (roots.length > 0)
		rmSync(roots.pop() as string, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: process.env,
	});
}

function seedRepository(
	root: string,
	key: RepositoryKey,
	identity: RepositoryFixture["identity"],
): RepositoryFixture {
	const source = join(root, "kindling", "services", key);
	const remote = join(root, "remotes", `${key}.git`);
	mkdirSync(source, { recursive: true });
	mkdirSync(dirname(remote), { recursive: true });
	git(root, "init", "-q", "--bare", "-b", "main", remote);
	git(source, "init", "-q", "-b", "main");
	writeFileSync(join(source, "README.md"), `# ${key}\n`);
	git(source, "add", "--", "README.md");
	git(
		source,
		"-c",
		"user.name=Fixture Seed",
		"-c",
		"user.email=seed@example.test",
		"commit",
		"-q",
		"-m",
		"chore: seed repository",
	);
	git(source, "remote", "add", "origin", remote);
	git(source, "push", "-q", "-u", "origin", "main");
	return {
		key,
		source: realpathSync(source),
		remote: realpathSync(remote),
		identity,
	};
}

/**
 * Configure identities the same way a developer can configure separate
 * company/account trees: Git chooses the include by repository git-dir. The
 * prefix also covers `.git/worktrees/*`, so linked worktrees retain the
 * repository-specific identity without maestro copying it into process env.
 */
function installPathScopedIdentities(
	root: string,
	repositories: readonly RepositoryFixture[],
): void {
	const globalConfig = join(root, "gitconfig");
	const includes: string[] = [];
	for (const repository of repositories) {
		const identityConfig = join(root, `${repository.key}.identity.gitconfig`);
		writeFileSync(
			identityConfig,
			[
				"[user]",
				`\tname = ${repository.identity.name}`,
				`\temail = ${repository.identity.email}`,
				"[commit]",
				"\tgpgsign = false",
				"",
			].join("\n"),
		);
		includes.push(
			`[includeIf "gitdir:${repository.source}/.git/"]`,
			`\tpath = ${identityConfig}`,
		);
	}
	writeFileSync(globalConfig, `${includes.join("\n")}\n`);
	process.env.GIT_CONFIG_GLOBAL = globalConfig;
}

function deliverable(
	key: RepositoryKey,
	after: readonly RepositoryKey[],
	runId: string,
): Deliverable {
	return {
		id: `${runId}-${key}`,
		title: `Implement ${key}`,
		after: after.map((dependency) => `${runId}-${dependency}`),
		reads: after.map((dependency) => `${runId}-${dependency}`),
		repo: key,
		tasks: [{ id: `${key}-implementation`, title: `Implement ${key}` }],
	};
}

async function provision(
	repositories: readonly RepositoryFixture[],
	runId: string,
): Promise<Map<RepositoryKey, CoordinatedCheckout>> {
	const workspace = createWorkspace({
		baseBranch: "main",
		branchPrefix: "maestro/w0/",
	});
	const dependencies: Record<RepositoryKey, readonly RepositoryKey[]> = {
		contracts: [],
		api: ["contracts"],
		deploy: ["api"],
	};
	const checkouts = new Map<RepositoryKey, CoordinatedCheckout>();
	for (const repository of repositories) {
		const made = await workspace.create(
			deliverable(repository.key, dependencies[repository.key], runId),
			repository.source,
		);
		checkouts.set(repository.key, {
			...repository,
			worktree: made.path,
			branch: made.branch,
		});
	}
	return checkouts;
}

/** Write and commit only when the dependency material changed. */
function materialize(
	checkout: CoordinatedCheckout,
	relativePath: string,
	contents: string,
	message: string,
): DependencyArtifact {
	const absolutePath = join(checkout.worktree, relativePath);
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, contents);
	const committed = stageAndCommit(checkout.worktree, [relativePath], message);
	if (!committed.ok) {
		const status = git(
			checkout.worktree,
			"status",
			"--porcelain",
			"--",
			relativePath,
		);
		if (status.trim().length > 0)
			throw new Error(committed.stderr || `could not commit ${relativePath}`);
	}
	const commit = headSha(checkout.worktree);
	if (!commit) throw new Error(`no commit in ${checkout.key}`);
	return { repository: checkout.key, commit, path: absolutePath };
}

function runDependencyChain(
	checkouts: ReadonlyMap<RepositoryKey, CoordinatedCheckout>,
): DependencyArtifact[] {
	const contracts = checkouts.get("contracts");
	const api = checkouts.get("api");
	const deploy = checkouts.get("deploy");
	if (!contracts || !api || !deploy) throw new Error("incomplete workspace");

	const contract = materialize(
		contracts,
		"artifacts/widget-contract.json",
		'{"widget":"v2"}\n',
		"feat: publish widget contract",
	);
	const contractContents = readFileSync(contract.path, "utf8");
	const apiArtifact = materialize(
		api,
		"artifacts/api-consumer.txt",
		`contracts:${contract.repository}@${contract.commit}\n${contractContents}`,
		"feat: consume widget contract",
	);
	const apiContents = readFileSync(apiArtifact.path, "utf8");
	const deployment = materialize(
		deploy,
		"artifacts/deployment.txt",
		`api:${apiArtifact.repository}@${apiArtifact.commit}\n${apiContents}`,
		"feat: deploy widget API",
	);
	return [contract, apiArtifact, deployment];
}

describe("W0 multi-repository workspace", () => {
	it("coordinates dependent repositories from a non-Git umbrella and resumes in place", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "maestro-multi-repo-")),
		);
		roots.push(root);
		const umbrella = join(root, "kindling");
		mkdirSync(umbrella, { recursive: true });

		const repositories = [
			seedRepository(root, "contracts", {
				name: "Contracts Developer",
				email: "contracts@example.test",
			}),
			seedRepository(root, "api", {
				name: "API Developer",
				email: "api@example.test",
			}),
			seedRepository(root, "deploy", {
				name: "Deploy Developer",
				email: "deploy@example.test",
			}),
		] as const;
		installPathScopedIdentities(root, repositories);

		// Starting Pi in the umbrella must not require the umbrella itself to be a
		// repository. Each selected child remains an independent Git boundary.
		expect(gitToplevel(umbrella)).toBeNull();
		for (const repository of repositories)
			expect(gitToplevel(repository.source)).toBe(repository.source);

		const first = await provision(repositories, "run-a");
		const artifacts = runDependencyChain(first);

		// Downstream tasks consumed committed upstream artifacts from other
		// repository worktrees, preserving the dependency chain in their content.
		expect(readFileSync(artifacts[1]?.path as string, "utf8")).toContain(
			`contracts@${artifacts[0]?.commit}`,
		);
		expect(readFileSync(artifacts[2]?.path as string, "utf8")).toContain(
			`api@${artifacts[1]?.commit}`,
		);

		for (const repository of repositories) {
			const checkout = first.get(repository.key);
			expect(checkout).toBeDefined();
			if (!checkout) continue;
			expect(checkout.branch).toBe(`maestro/w0/run-a-${repository.key}`);
			expect(resolveGitIdentity(checkout.worktree)).toEqual(
				repository.identity,
			);
			expect(
				git(checkout.worktree, "log", "-1", "--format=%an <%ae>").trim(),
			).toBe(`${repository.identity.name} <${repository.identity.email}>`);
			expect(workingTreeClean(checkout.worktree)).toBe(true);
		}

		const firstPaths = Object.fromEntries(
			[...first].map(([key, checkout]) => [key, checkout.worktree]),
		);
		const firstHeads = Object.fromEntries(
			[...first].map(([key, checkout]) => [key, headSha(checkout.worktree)]),
		);
		const firstCounts = Object.fromEntries(
			[...first].map(([key, checkout]) => [
				key,
				git(checkout.worktree, "rev-list", "--count", "main..HEAD").trim(),
			]),
		);

		// A restarted coordinator reconstructs the same repository registry from
		// durable branch/worktree state. Re-running idempotent tasks produces no
		// duplicate commits because their materialized dependency inputs match.
		const resumed = await provision(repositories, "run-a");
		runDependencyChain(resumed);
		for (const [key, checkout] of resumed) {
			expect(checkout.worktree).toBe(firstPaths[key]);
			expect(headSha(checkout.worktree)).toBe(firstHeads[key]);
			expect(
				git(checkout.worktree, "rev-list", "--count", "main..HEAD").trim(),
			).toBe(firstCounts[key]);
			expect(workingTreeClean(checkout.worktree)).toBe(true);
		}

		// A distinct approved run must not be mistaken for a resume merely because
		// it coordinates the same repository set.
		const independent = await provision(repositories, "run-b");
		for (const [key, checkout] of independent) {
			expect(checkout.branch).toBe(`maestro/w0/run-b-${key}`);
			expect(checkout.worktree).not.toBe(firstPaths[key]);
			expect(headSha(checkout.worktree)).not.toBe(firstHeads[key]);
			expect(
				git(checkout.worktree, "rev-list", "--count", "main..HEAD").trim(),
			).toBe("0");
			expect(workingTreeClean(checkout.worktree)).toBe(true);
		}
	});
});
