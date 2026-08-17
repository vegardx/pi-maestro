import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	headSha,
	isGitRepo,
	resolveGitIdentity,
	workingTreeClean,
} from "@vegardx/pi-git";
import { afterEach, describe, expect, it } from "vitest";
import {
	continueWorkflowRepositories,
	type PrepareWorkflowRepositoriesInput,
	prepareWorkflowRepositories,
	previewWorkflowRepositories,
	resumeWorkflowRepositories,
} from "../../../packages/maestro/src/workflow/repository-preparation.js";

interface RepositoryFixture {
	readonly key: string;
	readonly source: string;
	readonly base: string;
	readonly baseSha: string;
	readonly identity: { readonly name: string; readonly email: string };
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
	umbrella: string,
	key: string,
	base: string,
	identity: RepositoryFixture["identity"],
): RepositoryFixture {
	const source = join(umbrella, key);
	mkdirSync(source, { recursive: true });
	git(source, "init", "-q", "-b", base);
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
		`seed ${key}`,
	);
	return {
		key,
		source: realpathSync(source),
		base,
		baseSha: headSha(source) as string,
		identity,
	};
}

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

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "maestro-repository-preparation-"));
	roots.push(root);
	const umbrella = join(root, "kindling");
	mkdirSync(umbrella);
	const repositories = [
		seedRepository(umbrella, "contracts", "main", {
			name: "Contracts Developer",
			email: "contracts@example.test",
		}),
		seedRepository(umbrella, "api", "develop", {
			name: "API Developer",
			email: "api@example.test",
		}),
	];
	installPathScopedIdentities(root, repositories);
	return { root, umbrella, repositories };
}

function input(
	root: string,
	repositories: readonly RepositoryFixture[],
	runId = "run_001",
): PrepareWorkflowRepositoriesInput {
	const coordinatedRunRoot = join(root, "runs", runId);
	mkdirSync(coordinatedRunRoot, { recursive: true });
	return {
		runId,
		planSlug: "cross_repo",
		coordinatedRunRoot,
		repositories: [...repositories]
			.reverse()
			.map((repository) => ({ key: repository.key, path: repository.source })),
	};
}

function registryPath(value: PrepareWorkflowRepositoriesInput): string {
	return join(
		realpathSync(value.coordinatedRunRoot),
		"runtime",
		"maestro-repositories",
		"registry.json",
	);
}

describe("workflow multi-repository preparation", () => {
	it("previews exact bases and targets without creating branches or worktrees", async () => {
		const value = fixture();
		const request = input(value.root, value.repositories, "run_preview");
		const preview = await previewWorkflowRepositories(request);

		expect(
			preview.map(({ key, baseBranch, baseSha }) => ({
				key,
				baseBranch,
				baseSha,
			})),
		).toEqual(
			[...value.repositories]
				.sort((left, right) => left.key.localeCompare(right.key))
				.map(({ key, base, baseSha }) => ({
					key,
					baseBranch: base,
					baseSha,
				})),
		);
		expect(existsSync(join(request.coordinatedRunRoot, "repos"))).toBe(false);
		for (const repository of preview) {
			expect(existsSync(repository.worktree)).toBe(false);
			expect(
				git(
					repository.sourceRoot,
					"branch",
					"--list",
					repository.branch,
				).trim(),
			).toBe("");
		}
	});

	it("refuses a changed approved base before creating a branch or worktree", async () => {
		const value = fixture();
		const request = input(value.root, value.repositories, "run_stale_preview");
		const preview = await previewWorkflowRepositories(request);
		const api = value.repositories.find(({ key }) => key === "api")!;
		writeFileSync(join(api.source, "advanced.txt"), "advanced\n");
		git(api.source, "add", "--", "advanced.txt");
		git(
			api.source,
			"-c",
			"user.name=Fixture Seed",
			"-c",
			"user.email=seed@example.test",
			"commit",
			"-q",
			"-m",
			"advance approved base",
		);

		await expect(
			prepareWorkflowRepositories({
				...request,
				expectedRepositories: preview,
			}),
		).rejects.toThrow(/approved preview/);
		expect(existsSync(join(request.coordinatedRunRoot, "repos"))).toBe(false);
		for (const repository of preview)
			expect(
				git(
					repository.sourceRoot,
					"branch",
					"--list",
					repository.branch,
				).trim(),
			).toBe("");
	});

	it("creates one deterministic linked worktree per independent repository", async () => {
		const value = fixture();
		expect(isGitRepo(value.umbrella)).toBe(false);
		const request = input(value.root, value.repositories);

		const prepared = await prepareWorkflowRepositories(request);

		expect(prepared.map(({ key }) => key)).toEqual(["api", "contracts"]);
		for (const repository of value.repositories) {
			const checkout = prepared.find(({ key }) => key === repository.key);
			expect(checkout).toEqual({
				key: repository.key,
				sourceRoot: repository.source,
				worktree: join(
					realpathSync(request.coordinatedRunRoot),
					"repos",
					repository.key,
				),
				branch: `maestro/cross_repo/run_001/${repository.key}`,
				baseBranch: repository.base,
				baseSha: repository.baseSha,
			});
			expect(headSha(checkout?.worktree as string)).toBe(repository.baseSha);
			expect(workingTreeClean(checkout?.worktree as string)).toBe(true);
			expect(resolveGitIdentity(checkout?.worktree as string)).toEqual(
				repository.identity,
			);
		}
		const registry = registryPath(request);
		expect(lstatSync(registry).mode & 0o777).toBe(0o600);
		expect(registry).not.toContain(`${join("runtime", ".pi")}`);
		expect(JSON.parse(readFileSync(registry, "utf8"))).toMatchObject({
			version: 1,
			runId: "run_001",
			planSlug: "cross_repo",
			repositories: prepared,
		});
	});

	it("resumes by validating exact Git identity and gives a different run distinct state", async () => {
		const value = fixture();
		const firstInput = input(value.root, value.repositories, "run_first");
		const first = await prepareWorkflowRepositories(firstInput);

		await expect(resumeWorkflowRepositories(firstInput)).resolves.toEqual(
			first,
		);
		await expect(prepareWorkflowRepositories(firstInput)).rejects.toThrow(
			/resume it explicitly/,
		);

		const secondInput = input(value.root, value.repositories, "run_second");
		const second = await prepareWorkflowRepositories(secondInput);
		for (const checkout of second) {
			const prior = first.find(({ key }) => key === checkout.key);
			expect(checkout.worktree).not.toBe(prior?.worktree);
			expect(checkout.branch).not.toBe(prior?.branch);
		}
	});

	it("honors an explicit base independently for each repository", async () => {
		const value = fixture();
		const contracts = value.repositories.find(
			({ key }) => key === "contracts",
		)!;
		git(contracts.source, "switch", "-q", "-c", "approved-base");
		writeFileSync(join(contracts.source, "approved.txt"), "approved\n");
		git(contracts.source, "add", "--", "approved.txt");
		git(
			contracts.source,
			"-c",
			"user.name=Fixture Seed",
			"-c",
			"user.email=seed@example.test",
			"commit",
			"-q",
			"-m",
			"approved base",
		);
		const approvedSha = headSha(contracts.source) as string;
		git(contracts.source, "switch", "-q", contracts.base);
		const request = input(value.root, value.repositories, "run_explicit");
		const prepared = await prepareWorkflowRepositories({
			...request,
			repositories: request.repositories.map((repository) =>
				repository.key === "contracts"
					? { ...repository, base: "approved-base" }
					: repository,
			),
		});

		expect(prepared.find(({ key }) => key === "contracts")?.baseSha).toBe(
			approvedSha,
		);
		expect(prepared.find(({ key }) => key === "api")?.baseSha).toBe(
			value.repositories.find(({ key }) => key === "api")?.baseSha,
		);
	});

	it("fails closed for concurrent creation and filesystem or branch collisions", async () => {
		const value = fixture();
		const concurrent = input(value.root, value.repositories, "run_concurrent");
		const results = await Promise.allSettled([
			prepareWorkflowRepositories(concurrent),
			prepareWorkflowRepositories(concurrent),
		]);
		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
			1,
		);
		expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
			1,
		);

		const targetCollision = input(value.root, value.repositories, "run_target");
		mkdirSync(join(targetCollision.coordinatedRunRoot, "repos", "api"), {
			recursive: true,
		});
		await expect(prepareWorkflowRepositories(targetCollision)).rejects.toThrow(
			/target already exists/,
		);

		const branchCollision = input(value.root, value.repositories, "run_branch");
		git(
			value.repositories[0]!.source,
			"branch",
			"maestro/cross_repo/run_branch/contracts",
		);
		await expect(prepareWorkflowRepositories(branchCollision)).rejects.toThrow(
			/branch already exists/,
		);
	});

	it("recovers a durable journal after a crash and takes over a stale owner", async () => {
		const value = fixture();
		const request = input(value.root, value.repositories, "run_recovery");
		let preparedCount = 0;
		await expect(
			prepareWorkflowRepositories(request, {
				onRepositoryPrepared: () => {
					preparedCount += 1;
					if (preparedCount === 1) throw new Error("simulated seat crash");
				},
			}),
		).rejects.toThrow(/simulated seat crash/);
		const repositoryDirectory = join(
			realpathSync(request.coordinatedRunRoot),
			"repos",
		);
		expect(lstatSync(join(repositoryDirectory, "api")).isDirectory()).toBe(
			true,
		);
		expect(() => lstatSync(join(repositoryDirectory, "contracts"))).toThrow();

		const stateDirectory = join(
			realpathSync(request.coordinatedRunRoot),
			"runtime",
			"maestro-repositories",
		);
		const claim = join(stateDirectory, "create.lock");
		writeFileSync(
			claim,
			`${JSON.stringify({ version: 1, ownerPid: 101, token: "dead-seat" })}\n`,
			{ mode: 0o600 },
		);
		const recoveryOptions = {
			ownerPid: 202,
			isProcessAlive: (pid: number) => pid !== 101,
		};
		const attempts = await Promise.allSettled([
			prepareWorkflowRepositories(request, recoveryOptions),
			prepareWorkflowRepositories(request, recoveryOptions),
		]);
		expect(
			attempts.filter(({ status }) => status === "fulfilled"),
		).toHaveLength(1);
		expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(
			1,
		);
		const recovered = attempts.find(
			(
				attempt,
			): attempt is PromiseFulfilledResult<
				Awaited<ReturnType<typeof prepareWorkflowRepositories>>
			> => attempt.status === "fulfilled",
		)!.value;
		expect(recovered.map(({ key }) => key)).toEqual(["api", "contracts"]);
		expect(headSha(recovered[0]!.worktree)).toBe(recovered[0]!.baseSha);
		expect(() => lstatSync(join(stateDirectory, "preparation.json"))).toThrow();
		expect(() => lstatSync(claim)).toThrow();
	});

	it("continues through either a partial journal or a completed registry", async () => {
		const value = fixture();
		const request = input(value.root, value.repositories, "run_continue");
		let preparedCount = 0;
		await expect(
			prepareWorkflowRepositories(request, {
				onRepositoryPrepared: () => {
					preparedCount += 1;
					if (preparedCount === 1) throw new Error("interrupt preparation");
				},
			}),
		).rejects.toThrow(/interrupt preparation/);

		const recovered = await continueWorkflowRepositories(request);
		expect(recovered).toHaveLength(2);
		await expect(continueWorkflowRepositories(request)).resolves.toEqual(
			recovered,
		);
	});

	it("rejects non-repositories, overlapping roots, invalid ids, and symlink escapes", async () => {
		const value = fixture();
		const ordinary = input(value.root, value.repositories, "run_invalid");
		await expect(
			prepareWorkflowRepositories({
				...ordinary,
				repositories: [{ key: "umbrella", path: value.umbrella }],
			}),
		).rejects.toThrow(/exact non-bare Git root/);

		const nested = seedRepository(
			value.repositories[0]!.source,
			"nested",
			"main",
			{ name: "Nested", email: "nested@example.test" },
		);
		await expect(
			prepareWorkflowRepositories({
				...input(value.root, value.repositories, "run_nested"),
				repositories: [
					{ key: "contracts", path: value.repositories[0]!.source },
					{ key: "nested", path: nested.source },
				],
			}),
		).rejects.toThrow(/must not overlap/);

		const linked = join(value.root, "linked-api");
		symlinkSync(value.repositories[1]!.source, linked, "dir");
		await expect(
			prepareWorkflowRepositories({
				...input(value.root, value.repositories, "run_symlink"),
				repositories: [{ key: "api", path: linked }],
			}),
		).rejects.toThrow(/symlink/);

		await expect(
			prepareWorkflowRepositories({ ...ordinary, runId: "../escape" }),
		).rejects.toThrow(/run id is invalid/);
		await expect(
			prepareWorkflowRepositories({
				...ordinary,
				repositories: [
					{ key: "same", path: value.repositories[0]!.source },
					{ key: "same", path: value.repositories[1]!.source },
				],
			}),
		).rejects.toThrow(/duplicate workflow repository key/);

		const escapedRun = join(value.root, "runs", "run_escape");
		const outside = join(value.root, "outside-repos");
		mkdirSync(escapedRun, { recursive: true });
		mkdirSync(outside);
		symlinkSync(outside, join(escapedRun, "repos"), "dir");
		await expect(
			prepareWorkflowRepositories({
				...ordinary,
				runId: "run_escape",
				coordinatedRunRoot: escapedRun,
			}),
		).rejects.toThrow(/contains a symlink/);
	});

	it("detects registry, checkout, source, and base tampering on resume", async () => {
		const value = fixture();
		const request = input(value.root, value.repositories, "run_tamper");
		const prepared = await prepareWorkflowRepositories(request);
		const registry = registryPath(request);
		const original = readFileSync(registry, "utf8");
		const parsed = JSON.parse(original) as {
			repositories: Array<Record<string, string>>;
		};
		parsed.repositories[0]!.baseSha = "0".repeat(40);
		writeFileSync(registry, `${JSON.stringify(parsed)}\n`);
		chmodSync(registry, 0o600);
		await expect(resumeWorkflowRepositories(request)).rejects.toThrow(
			/base SHA/,
		);

		writeFileSync(registry, original);
		chmodSync(registry, 0o600);
		const api = prepared.find(({ key }) => key === "api")!;
		git(api.worktree, "switch", "-q", "-c", "unexpected");
		await expect(resumeWorkflowRepositories(request)).rejects.toThrow(
			/branch checkout changed/,
		);

		git(api.worktree, "switch", "-q", api.branch);
		const sourceTamper = JSON.parse(original) as {
			repositories: Array<Record<string, string>>;
		};
		sourceTamper.repositories[0]!.sourceRoot = value.repositories[0]!.source;
		writeFileSync(registry, `${JSON.stringify(sourceTamper)}\n`);
		chmodSync(registry, 0o600);
		await expect(resumeWorkflowRepositories(request)).rejects.toThrow(
			/differs/,
		);
	});
});
