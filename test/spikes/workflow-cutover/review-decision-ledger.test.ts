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
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ReviewDecisionLedgerStore,
	type SealReviewDecisionLedgerInput,
} from "../../../packages/maestro/src/workflow/review-decision-ledger.js";

const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0)
		rmSync(roots.pop() as string, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Ledger Test",
			GIT_AUTHOR_EMAIL: "ledger@example.test",
			GIT_COMMITTER_NAME: "Ledger Test",
			GIT_COMMITTER_EMAIL: "ledger@example.test",
		},
	});
}

function commit(
	cwd: string,
	file: string,
	contents: string,
	message: string,
): string {
	writeFileSync(join(cwd, file), contents);
	git(cwd, "add", "--", file);
	git(cwd, "commit", "-q", "-m", message);
	return git(cwd, "rev-parse", "HEAD").trim();
}

function repository(root: string, name: string) {
	const path = join(root, "repos", name);
	mkdirSync(path, { recursive: true });
	git(path, "init", "-q", "-b", "main");
	commit(path, "README.md", `# ${name}\n`, "chore: seed");
	const implementationHead = commit(
		path,
		"implementation.txt",
		`${name} implementation\n`,
		`feat: implement ${name}`,
	);
	const followUp = commit(
		path,
		"implementation.txt",
		`${name} implementation with review adjustment\n`,
		`fix: adjust ${name} behavior`,
	);
	return {
		path: realpathSync(path),
		implementationHead,
		followUp,
		finalHead: followUp,
	};
}

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "maestro-ledger-")));
	roots.push(root);
	const api = repository(root, "api");
	const deploy = repository(root, "deploy");
	const state = join(root, "maestro-state");
	const workflowState = join(root, "workflow-state", ".pi", "workflows");
	mkdirSync(state, { recursive: true });
	mkdirSync(workflowState, { recursive: true });
	const store = new ReviewDecisionLedgerStore({
		maestroStateRoot: state,
		forbiddenRoots: [api.path, deploy.path, workflowState],
	});
	const findingsWithPrivateFields = [
		{ id: "finding-a", lens: "security" },
		{ id: "finding-b", lens: "correctness" },
	] as const;
	const decisionsWithPrivateFields = [
		{
			findingId: "finding-a",
			decision: "changed",
			reasoning: "The two repository changes share one cause.",
			changedPaths: [
				{ repository: "api", path: "implementation.txt" },
				{ repository: "deploy", path: "implementation.txt" },
			],
			commitRefs: [
				{ repository: "api", commit: api.followUp },
				{ repository: "deploy", commit: deploy.followUp },
			],
			resolvedModel: "private/model",
		},
		{
			findingId: "finding-b",
			decision: "no_change",
			reasoning: "The existing contract already covers the case.",
		},
	] as const;
	const input: SealReviewDecisionLedgerInput = {
		runId: "run_review_001",
		findings: findingsWithPrivateFields,
		decisions: decisionsWithPrivateFields,
		repositories: [
			{
				repository: "api",
				path: api.path,
				expectedBranch: "main",
				implementationHead: api.implementationHead,
				finalHead: api.finalHead,
			},
			{
				repository: "deploy",
				path: deploy.path,
				expectedBranch: "main",
				implementationHead: deploy.implementationHead,
				finalHead: deploy.finalHead,
			},
		],
	};
	return { root, api, deploy, state, workflowState, store, input };
}

describe("local review decision ledger", () => {
	it("durably maps exact decisions to existing ordinary commits without provenance", () => {
		const fixture = setup();
		const sealed = fixture.store.seal(fixture.input);
		const loaded = fixture.store.load(sealed.reference);

		expect(loaded).toEqual(sealed.ledger);
		expect(loaded.decisions[0]?.commitRefs).toEqual([
			{ repository: "api", commit: fixture.api.followUp },
			{ repository: "deploy", commit: fixture.deploy.followUp },
		]);
		const serialized = JSON.stringify(loaded);
		expect(serialized).not.toContain("lens");
		expect(serialized).not.toContain("model");
		expect(serialized).not.toContain(fixture.api.path);
		expect(serialized).not.toContain(fixture.deploy.path);

		// Mapping is local state, not a Git representation: no empty ledger commit,
		// finding trailer, Git note, or rewritten message is introduced.
		for (const repository of [fixture.api, fixture.deploy]) {
			expect(git(repository.path, "rev-list", "--count", "HEAD").trim()).toBe(
				"3",
			);
			expect(
				git(
					repository.path,
					"log",
					"-1",
					"--format=%s",
					repository.followUp,
				).trim(),
			).toMatch(/^fix: adjust /);
			expect(git(repository.path, "notes", "list").trim()).toBe("");
		}

		// An identical resume reuses the immutable seal. A different decision set
		// for the same run cannot overwrite it.
		expect(fixture.store.seal(fixture.input).reference).toEqual(
			sealed.reference,
		);
		expect(
			fixture.store.seal({
				...fixture.input,
				findings: [...fixture.input.findings].reverse(),
				decisions: [...fixture.input.decisions].reverse().map((decision) => ({
					...decision,
					changedPaths: decision.changedPaths
						? [...decision.changedPaths].reverse()
						: undefined,
					commitRefs: decision.commitRefs
						? [...decision.commitRefs].reverse()
						: undefined,
				})),
				repositories: [...fixture.input.repositories].reverse(),
			}).reference,
		).toEqual(sealed.reference);
		expect(() =>
			fixture.store.seal({
				...fixture.input,
				decisions: fixture.input.decisions.map((decision) => ({
					...decision,
					reasoning: `${decision.reasoning} changed`,
				})),
			}),
		).toThrow(/already sealed with different contents/);
	});

	it("requires exact finding coverage and commit referential integrity", () => {
		const fixture = setup();
		expect(() =>
			fixture.store.seal({
				...fixture.input,
				repositories: [],
			}),
		).toThrow(/requires at least one repository/);
		expect(() =>
			fixture.store.seal({
				...fixture.input,
				decisions: fixture.input.decisions.slice(0, 1),
			}),
		).toThrow(/do not exactly cover/);
		expect(() =>
			fixture.store.seal({
				...fixture.input,
				decisions: [
					...fixture.input.decisions,
					{
						findingId: "unknown-finding",
						decision: "no_change",
						reasoning: "Unknown.",
					},
				],
			}),
		).toThrow(/do not exactly cover/);
		expect(() =>
			fixture.store.seal({
				...fixture.input,
				decisions: fixture.input.decisions.map((decision) =>
					decision.findingId === "finding-a"
						? {
								...decision,
								commitRefs: [
									{
										repository: "api",
										commit: fixture.api.implementationHead,
									},
								],
							}
						: decision,
				),
			}),
		).toThrow(/outside the post-review range/);
		expect(() =>
			fixture.store.seal({
				...fixture.input,
				decisions: fixture.input.decisions.map((decision) =>
					decision.findingId === "finding-a"
						? {
								...decision,
								changedPaths: [
									{ repository: "api", path: "unrelated.txt" },
									{ repository: "deploy", path: "implementation.txt" },
								],
							}
						: decision,
				),
			}),
		).toThrow(/does not touch a declared changed path/);
		expect(() =>
			fixture.store.seal({
				...fixture.input,
				decisions: fixture.input.decisions.map((decision) =>
					decision.findingId === "finding-a"
						? {
								...decision,
								changedPaths: [
									...(decision.changedPaths ?? []),
									{ repository: "api", path: "never-touched.txt" },
								],
							}
						: decision,
				),
			}),
		).toThrow(/no referenced commit touches/);
		expect(() =>
			fixture.store.seal({
				...fixture.input,
				decisions: fixture.input.decisions.map((decision) =>
					decision.findingId === "finding-b"
						? {
								...decision,
								decision: "ignored" as "no_change",
							}
						: decision,
				),
			}),
		).toThrow(/invalid outcome/);
	});

	it("refuses undeclared paths bundled into an otherwise referenced commit", () => {
		const fixture = setup();
		writeFileSync(join(fixture.api.path, "undeclared.txt"), "extra\n");
		git(fixture.api.path, "add", "undeclared.txt");
		git(fixture.api.path, "commit", "-q", "--amend", "--no-edit");
		const amended = git(fixture.api.path, "rev-parse", "HEAD").trim();
		const input: SealReviewDecisionLedgerInput = {
			...fixture.input,
			decisions: fixture.input.decisions.map((decision) =>
				decision.findingId === "finding-a"
					? {
							...decision,
							commitRefs: (decision.commitRefs ?? []).map((ref) =>
								ref.repository === "api" ? { ...ref, commit: amended } : ref,
							),
						}
					: decision,
			),
			repositories: fixture.input.repositories.map((repository) =>
				repository.repository === "api"
					? { ...repository, finalHead: amended }
					: repository,
			),
		};

		expect(() => fixture.store.seal(input)).toThrow(
			/post-review changed paths for api do not exactly cover/,
		);
	});

	it("refuses unexplained follow-up commits and tampered local ledgers", () => {
		const fixture = setup();
		expect(() =>
			fixture.store.seal({
				...fixture.input,
				decisions: fixture.input.decisions.map((decision) =>
					decision.findingId === "finding-a"
						? {
								...decision,
								commitRefs: [
									{ repository: "api", commit: fixture.api.followUp },
								],
							}
						: decision,
				),
			}),
		).toThrow(
			/declares changed path deploy:implementation\.txt that no referenced commit touches/,
		);

		const sealed = fixture.store.seal(fixture.input);
		const path = join(
			fixture.state,
			"review-decisions",
			`${sealed.reference.runId}.json`,
		);
		writeFileSync(path, `${readFileSync(path, "utf8")} `);
		// Formatting-only changes alter the sealed bytes only after parsing; alter
		// the semantic payload to exercise the content digest itself.
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		parsed.ledger.decisions[0].reasoning = "tampered";
		writeFileSync(path, JSON.stringify(parsed));
		expect(() => fixture.store.load(sealed.reference)).toThrow(
			/integrity check failed/,
		);
	});

	it("will not seal a stale final head that omits a newer ordinary commit", () => {
		const fixture = setup();
		commit(
			fixture.api.path,
			"late.txt",
			"unmapped work\n",
			"fix: late unmapped work",
		);
		expect(() => fixture.store.seal(fixture.input)).toThrow(
			/api final head is not the current HEAD/,
		);
	});

	it("requires the approved branch and rejects empty follow-up commits", () => {
		const branchFixture = setup();
		git(branchFixture.api.path, "checkout", "-q", "-b", "other");
		expect(() => branchFixture.store.seal(branchFixture.input)).toThrow(
			/expected branch main is not checked out/,
		);

		const emptyFixture = setup();
		git(
			emptyFixture.api.path,
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"fix: empty",
		);
		const emptyCommit = git(emptyFixture.api.path, "rev-parse", "HEAD").trim();
		expect(() =>
			emptyFixture.store.seal({
				...emptyFixture.input,
				repositories: emptyFixture.input.repositories.map((repository) =>
					repository.repository === "api"
						? { ...repository, finalHead: emptyCommit }
						: repository,
				),
				decisions: emptyFixture.input.decisions.map((decision) =>
					decision.findingId === "finding-a"
						? {
								...decision,
								commitRefs: [
									...(decision.commitRefs ?? []),
									{ repository: "api", commit: emptyCommit },
								],
							}
						: decision,
				),
			}),
		).toThrow(/has an empty diff/);
	});
});
