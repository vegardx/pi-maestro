// Workflow-cutover acceptance below the not-yet-connected command UX. The
// production runner owns approval, preparation, three package phases, seat
// checkpoints, private review state, the decision gate, and shipping.

import { execFileSync } from "node:child_process";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { afterEach, describe, expect, test } from "vitest";
import type { Plan } from "../../../packages/maestro/src/plan.js";
import { UsageLedger } from "../../../packages/maestro/src/usage-ledger.js";
import {
	createProductionWorkflowPlanRunner,
	type ProductionWorkflowPlanRunnerComponents,
} from "../../../packages/maestro/src/workflow/production-plan-runner.js";
import {
	digestWorkflowRuntimePackage,
	materializeWorkflowSupervisorRuntime,
} from "../../../packages/maestro/src/workflow/supervisor-runtime.js";
import {
	WorkflowShipper,
	type WorkflowShippingOps,
} from "../../../packages/maestro/src/workflow/workflow-shipping.js";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const RUN_ID = "workflow_cutover_e2e";
const REVIEW_STAGES = [
	"review-security-opus",
	"review-security-fable",
	"review-security-grok",
	"review-correctness",
	"review-simplification",
] as const;
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) =>
			rm(root, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 20,
			}),
		),
	);
});

describe("the workflow-cutover drive", () => {
	test("enters once-approved work through the production runner and ships two repositories", {
		timeout: 120_000,
	}, async () => {
		const drive = await prepareDrive();
		const composition = productionRunner(drive);
		const result = await composition.runner.run(runnerInput(drive, true));

		expect(result.status).toBe("launched");
		if (result.status !== "launched") throw new Error("workflow was refused");
		expect(result.approval).toBe("new");
		expect(drive.approvalQuestions).toHaveLength(1);
		expect(drive.approvalQuestions[0]).toHaveLength(1);
		expect(drive.approvedBeforeMutation).toBe(true);
		expect(
			result.launchResult.implementationCheckpoint.commitRefs,
		).toHaveLength(2);
		expect(result.launchResult.decisionCheckpoint.commitRefs).toHaveLength(1);
		expect(result.launchResult.joinedReview.findings).toHaveLength(2);
		expect(
			result.launchResult.joinedReview.findings.some(
				(row) => row.provenance.contributors.length === 3,
			),
		).toBe(true);

		const repositories = Object.fromEntries(
			result.launchResult.repositories.map((repository) => [
				repository.key,
				repository,
			]),
		);
		const contracts = repositories.contracts!;
		const api = repositories.api!;
		expect(git(contracts.worktree, "log", "--format=%s")).toContain(
			"Implement Workflow cutover E2E",
		);
		const apiLog = git(api.worktree, "log", "--format=%s");
		expect(apiLog.match(/Implement Workflow cutover E2E/g)).toHaveLength(1);
		expect(apiLog).toContain(
			"Address review decisions for Workflow cutover E2E",
		);
		expect(
			await readFile(join(api.worktree, "src", "client.ts"), "utf8"),
		).toContain("encodeURIComponent");

		const implementationRun = await readRun(drive, `${RUN_ID}_implementation`);
		const reviewRun = await readRun(drive, `${RUN_ID}_review`);
		const decisionRun = await readRun(drive, `${RUN_ID}_decision`);
		expect(implementationRun.usage).toMatchObject({
			taskCount: 2,
			tasksReporting: 2,
			totalTokens: 280,
			cacheReadInputTokens: 40,
		});
		expect(reviewRun.usage).toMatchObject({
			taskCount: 5,
			tasksReporting: 5,
			totalTokens: 700,
			cacheReadInputTokens: 100,
		});
		expect(decisionRun.usage).toMatchObject({
			taskCount: 1,
			tasksReporting: 1,
			totalTokens: 140,
			cacheReadInputTokens: 20,
		});
		expect(drive.usage.snapshot().totals).toMatchObject({
			input: 800,
			output: 320,
			cacheRead: 160,
		});
		expect(
			drive.runtimeResolutions.map(({ runId, providers }) => ({
				runId,
				providers,
			})),
		).toEqual([
			{
				runId: `${RUN_ID}_implementation`,
				providers: ["test"],
			},
			{
				runId: `${RUN_ID}_review`,
				providers: ["anthropic", "test", "xai"],
			},
			{
				runId: `${RUN_ID}_decision`,
				providers: ["test"],
			},
		]);
		expect(
			new Set(drive.runtimeResolutions.map(({ runtimeRoot }) => runtimeRoot))
				.size,
		).toBe(3);

		const authorities = await readPhaseAuthorities(drive);
		expect(authorities.map(({ worktreeAccess }) => worktreeAccess)).toEqual([
			"write",
			"read",
			"write",
		]);
		expect(
			authorities.every(({ gitAuthority }) => gitAuthority === "none"),
		).toBe(true);
		expect(authorities[2]?.deniedReadRoots).toHaveLength(10);
		expect(
			authorities[2]?.deniedReadRoots.every((path) =>
				/(?:control\.json|raw\.md)$/.test(path),
			),
		).toBe(true);

		const trace = await readTrace(drive);
		const contractStart = trace.find(
			(row) => row.stage === "contracts-implement",
		)?.startedAt;
		const apiStart = trace.find(
			(row) => row.stage === "api-implement",
		)?.startedAt;
		expect(apiStart).toBeGreaterThan(contractStart ?? Number.MAX_SAFE_INTEGER);
		const security = trace.filter((row) =>
			row.stage.startsWith("review-security-"),
		);
		expect(security.map((row) => row.model).sort()).toEqual([
			"anthropic/fable-5",
			"anthropic/opus-5",
			"xai/grok-4.5",
		]);
		const decisionPrompt =
			trace.find((row) => row.stage === "decision")?.prompt ?? "";
		expect(
			trace.find((row) => row.stage === "decision-private-read-probe"),
		).toMatchObject({ denied: true, deniedCount: 10 });
		for (const { finding } of result.launchResult.joinedReview.findings)
			expect(decisionPrompt).toContain(finding.id);
		expect(decisionPrompt).not.toMatch(/review-security-|anthropic\/|xai\//);

		expect(drive.prePushRemoteHeads).toEqual([null, null]);
		expect(remoteHead(drive.contracts.remote, contracts.branch)).toBe(
			git(contracts.worktree, "rev-parse", "HEAD").trim(),
		);
		expect(remoteHead(drive.api.remote, api.branch)).toBe(
			git(api.worktree, "rev-parse", "HEAD").trim(),
		);
		expect(drive.pullRequests).toHaveLength(2);
		expect(JSON.stringify(drive.pullRequests)).not.toMatch(
			/reviewer|finding|opus|fable|grok|taskId|provenance/i,
		);
	});

	test("refusal asks once and creates no branch, worktree, commit, or publication", async () => {
		const drive = await prepareDrive();
		const result = await productionRunner(drive).runner.run(
			runnerInput(drive, false),
		);

		expect(result).toEqual({ status: "refused", reason: "not-approved" });
		expect(drive.approvalQuestions).toHaveLength(1);
		expect(
			git(drive.contracts.source, "branch", "--list", "maestro/*").trim(),
		).toBe("");
		expect(git(drive.api.source, "branch", "--list", "maestro/*").trim()).toBe(
			"",
		);
		expect(await pathExists(drive.contracts.worktree)).toBe(false);
		expect(await pathExists(drive.api.worktree)).toBe(false);
		expect(
			git(drive.contracts.source, "rev-list", "--count", "HEAD").trim(),
		).toBe("1");
		expect(git(drive.api.source, "rev-list", "--count", "HEAD").trim()).toBe(
			"1",
		);
		expect(
			remoteHead(drive.contracts.remote, expectedBranch("contracts")),
		).toBeNull();
		expect(remoteHead(drive.api.remote, expectedBranch("api"))).toBeNull();
		expect(drive.runtimeResolutions).toEqual([]);
		expect(drive.prePushRemoteHeads).toEqual([]);
		expect(drive.pullRequests).toEqual([]);
	});

	test("continues the failed decision phase without replaying completed phases", {
		timeout: 120_000,
	}, async () => {
		const drive = await prepareDrive(true);
		await expect(
			productionRunner(drive).runner.run(runnerInput(drive, true)),
		).rejects.toThrow(/workflow supervisor/i);
		await writeFile(drive.recoveryMarker, "resume\n");
		const result = await productionRunner(drive).runner.run(
			runnerInput(drive, true),
		);

		expect(result.status).toBe("launched");
		if (result.status !== "launched") throw new Error("resume was refused");
		expect(result.approval).toBe("resumed");
		expect(drive.approvalQuestions).toHaveLength(1);
		const launches = await readTrace(drive);
		expect(
			launches.filter((row) => row.stage === "contracts-implement"),
		).toHaveLength(1);
		expect(
			launches.filter((row) => row.stage === "api-implement"),
		).toHaveLength(1);
		for (const stage of REVIEW_STAGES)
			expect(launches.filter((row) => row.stage === stage)).toHaveLength(1);
		expect(
			launches.filter((row) => row.stage === "decision").length,
		).toBeGreaterThanOrEqual(3);
		expect(
			git(
				result.launchResult.repositories.find(({ key }) => key === "api")!
					.worktree,
				"log",
				"--format=%s",
			).match(/Implement Workflow cutover E2E/g),
		).toHaveLength(1);
		expect(drive.prePushRemoteHeads).toEqual([null, null]);
	});
});

interface SourceRepoFixture {
	source: string;
	worktree: string;
	remote: string;
}

interface RunRecord {
	status: string;
	usage?: {
		taskCount: number;
		tasksReporting: number;
		totalTokens?: number;
		cacheReadInputTokens?: number;
	};
}

interface TraceRow {
	stage: string;
	model: string;
	startedAt: number;
	prompt: string;
	denied?: boolean;
	deniedCount?: number;
}

async function prepareDrive(failDecisionOnce = false) {
	const temp = await mkdtemp(join(tmpdir(), "pi-maestro-workflow-drive-"));
	temporaryRoots.push(temp);
	const pendingRunRoot = join(temp, "run");
	const maestroStateRoot = join(temp, "maestro-state");
	await mkdir(pendingRunRoot, { recursive: true });
	await mkdir(maestroStateRoot, { recursive: true });
	const runRoot = await realpath(pendingRunRoot);
	const contracts = await makeSourceRepo(temp, runRoot, "contracts");
	const api = await makeSourceRepo(temp, runRoot, "api");
	const fakePi = join(temp, "driver-bin", "pi");
	await mkdir(dirname(fakePi), { recursive: true });
	await cp(join(fixtureRoot, "workflow-fake-pi.mjs"), fakePi);
	await chmod(fakePi, 0o700);
	const tracePath = join(temp, "trace.ndjson");
	await writeFile(tracePath, "");
	const toolkitRoot = await makeToolkit(temp);
	const recoveryMarker = join(temp, "decision-recovery");
	const reviewBarrier = join(temp, "review-barrier");
	const sourceEnvironment = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		WORKFLOW_E2E_TRACE: tracePath,
		WORKFLOW_E2E_CONTRACTS: contracts.worktree,
		WORKFLOW_E2E_API: api.worktree,
		WORKFLOW_E2E_REVIEW_BARRIER: reviewBarrier,
		...(failDecisionOnce
			? { WORKFLOW_E2E_FAIL_DECISION_ONCE: recoveryMarker }
			: {}),
	};
	const usage = new UsageLedger({ pollIntervalMs: 10 });
	const approvalQuestions: Questionnaire[] = [];
	const runtimeResolutions: Array<{
		runId: string;
		providers: readonly string[];
		runtimeRoot: string;
	}> = [];
	const prePushRemoteHeads: Array<string | null> = [];
	const pullRequests: Array<{ title: string; body: string; base: string }> = [];
	return {
		temp,
		runRoot,
		maestroStateRoot,
		contracts,
		api,
		tracePath,
		recoveryMarker,
		toolkitRoot,
		fakePi,
		sourceEnvironment,
		usage,
		approvalQuestions,
		runtimeResolutions,
		prePushRemoteHeads,
		pullRequests,
		approvedBeforeMutation: false,
	};
}

function productionRunner(drive: Awaited<ReturnType<typeof prepareDrive>>) {
	const shippingOps = fakeShippingOps(drive);
	const components: Partial<ProductionWorkflowPlanRunnerComponents> = {
		createShipper: (options) =>
			new WorkflowShipper({ ...options, ops: shippingOps }),
	};
	return createProductionWorkflowPlanRunner({
		coordinatedRunRoot: drive.runRoot,
		maestroStateRoot: drive.maestroStateRoot,
		coordinatedRepositoryRoots: [drive.contracts.source, drive.api.source],
		runtimeResolver: {
			resolve: async ({ runId, approvedProviderIds }) => {
				const options = {
					coordinatedRunRoot: drive.runRoot,
					runtimeNamespace: runId,
					sourceEnvironment: drive.sourceEnvironment,
					allowedEnvironmentKeys: Object.keys(drive.sourceEnvironment),
					approvedProviderIds,
					sourceAuth: {},
					models: {
						providers: { test: {}, anthropic: {}, xai: {} },
					},
					agentToolkit: {
						sourceRoot: drive.toolkitRoot,
						expectedDigest: digestWorkflowRuntimePackage(drive.toolkitRoot),
						expectedVersion: "0.0.0-e2e",
						sourceRevision: "3".repeat(40),
					},
					piExecutable: drive.fakePi,
				} as const;
				const runtime = materializeWorkflowSupervisorRuntime(options);
				drive.runtimeResolutions.push({
					runId,
					providers: [...approvedProviderIds],
					runtimeRoot: runtime.runtimeRoot,
				});
				return { options, runtime };
			},
		},
		pullRequestCopyProducer: {
			produce: ({ repository }) => ({
				title: `Ship greeting contract v2 in ${repository.key}`,
				intent: "Ship the approved greeting contract and API behavior.",
				rationale:
					"Keep the API implementation aligned with its versioned contract.",
				changes: [
					repository.key === "contracts"
						? "Define greeting contract v2"
						: "Implement and safely encode greeting paths",
				],
			}),
		},
		usage: drive.usage,
		phaseWaitTimeoutMs: 30_000,
		components,
		depth: () => 0,
	});
}

function runnerInput(
	drive: Awaited<ReturnType<typeof prepareDrive>>,
	approve: boolean,
) {
	return {
		runId: RUN_ID,
		coordinatedRunRoot: drive.runRoot,
		plan: workflowPlan(drive.contracts.source, drive.api.source),
		implementationModel: "test/implementer",
		decisionModel: "test/implementer",
		asker: {
			ask: async (questions: Questionnaire): Promise<Answers> => {
				drive.approvalQuestions.push(questions);
				return [
					{
						questionId: "workflow-plan-approval",
						value: approve ? "yes" : "no",
						source: "human",
					},
				];
			},
		},
		onApproved: async () => {
			drive.approvedBeforeMutation =
				!(await pathExists(drive.contracts.worktree)) &&
				!(await pathExists(drive.api.worktree)) &&
				git(drive.contracts.source, "branch", "--list", "maestro/*").trim() ===
					"" &&
				git(drive.api.source, "branch", "--list", "maestro/*").trim() === "";
		},
	};
}

function workflowPlan(contracts: string, api: string): Plan {
	return {
		slug: "workflow-cutover-e2e",
		title: "Workflow cutover E2E",
		repos: [
			{ key: "contracts", path: contracts },
			{ key: "api", path: api },
		],
		preflight: [],
		deliverables: [
			{
				id: "contracts",
				title: "E2E_STAGE=contracts-implement Define greeting contract v2",
				repo: "contracts",
				after: [],
				reads: [],
				tasks: [{ id: "implement", title: "Write the versioned contract" }],
			},
			{
				id: "api",
				title: "E2E_STAGE=api-implement Consume greeting contract v2",
				repo: "api",
				after: ["contracts"],
				reads: ["contracts"],
				tasks: [
					{ id: "implement", title: "Implement the greeting client" },
					...reviewTasks(),
				],
			},
		],
		postflight: [],
	};
}

function reviewTasks(): Plan["deliverables"][number]["tasks"] {
	return [
		{
			id: "security-opus",
			title: "E2E_STAGE=review-security-opus Review input boundaries",
			by: {
				lens: "security",
				skill: "security-review",
				model: "anthropic/opus-5",
			},
		},
		{
			id: "security-fable",
			title: "E2E_STAGE=review-security-fable Review input boundaries",
			by: {
				lens: "security",
				skill: "security-review",
				model: "anthropic/fable-5",
			},
		},
		{
			id: "security-grok",
			title: "E2E_STAGE=review-security-grok Review input boundaries",
			by: { lens: "security", skill: "security-review", model: "xai/grok-4.5" },
		},
		{
			id: "correctness",
			title: "E2E_STAGE=review-correctness Review behavioral correctness",
			by: {
				lens: "correctness",
				skill: "correctness-review",
				model: "test/correctness",
			},
		},
		{
			id: "simplification",
			title: "E2E_STAGE=review-simplification Review needless complexity",
			by: {
				lens: "simplification",
				skill: "simplification-review",
				model: "test/simplification",
			},
		},
	];
}

function fakeShippingOps(
	drive: Awaited<ReturnType<typeof prepareDrive>>,
): WorkflowShippingOps {
	let nextPullRequest = 101;
	return {
		inspect: (worktree) => ({
			branch: git(worktree, "branch", "--show-current").trim() || null,
			head: git(worktree, "rev-parse", "HEAD").trim() || null,
			clean: git(worktree, "status", "--porcelain").trim() === "",
		}),
		pushNonForce: async (worktree, branch) => {
			const remote = worktree.includes("/contracts")
				? drive.contracts.remote
				: drive.api.remote;
			drive.prePushRemoteHeads.push(remoteHead(remote, branch));
			try {
				git(worktree, "push", "origin", `${branch}:${branch}`);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: String(error) };
			}
		},
		findOpenPullRequest: async () => null,
		createPullRequest: async (_worktree, request) => {
			drive.pullRequests.push(request);
			return { number: nextPullRequest++ };
		},
		updatePullRequest: async () => {
			throw new Error("workflow e2e unexpectedly updated a pull request");
		},
	};
}

async function makeSourceRepo(
	temp: string,
	runRoot: string,
	name: string,
): Promise<SourceRepoFixture> {
	const source = join(temp, "sources", name);
	const remote = join(temp, "remotes", `${name}.git`);
	await mkdir(dirname(source), { recursive: true });
	await mkdir(dirname(remote), { recursive: true });
	git(temp, "init", "--bare", remote);
	git(temp, "init", "-b", "main", source);
	git(source, "config", "user.name", "Workflow E2E");
	git(source, "config", "user.email", "workflow-e2e@example.invalid");
	await writeFile(join(source, "README.md"), `# ${name}\n`);
	git(source, "add", "README.md");
	git(source, "commit", "-m", `Initialize ${name}`);
	git(source, "remote", "add", "origin", remote);
	return {
		source: await realpath(source),
		worktree: join(runRoot, "repos", name),
		remote: await realpath(remote),
	};
}

async function makeToolkit(temp: string): Promise<string> {
	const toolkitRoot = join(temp, "agent-toolkit");
	await mkdir(join(toolkitRoot, "skills"), { recursive: true });
	await writeFile(
		join(toolkitRoot, "package.json"),
		`${JSON.stringify({ name: "@vegardx/agent-toolkit", version: "0.0.0-e2e" })}\n`,
	);
	for (const [name, description] of [
		[
			"security-review",
			"Inspect code for security boundary and input-handling defects.",
		],
		[
			"correctness-review",
			"Inspect code for behavioral and contract correctness defects.",
		],
		[
			"simplification-review",
			"Inspect code for unnecessary complexity and simpler equivalent designs.",
		],
	] as const) {
		const skillRoot = join(toolkitRoot, "skills", name);
		await mkdir(skillRoot, { recursive: true });
		await writeFile(
			join(skillRoot, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${description}\n---\nApply only this review lens and report evidence-backed findings.\n`,
		);
	}
	return toolkitRoot;
}

async function readRun(
	drive: Awaited<ReturnType<typeof prepareDrive>>,
	runId: string,
): Promise<RunRecord> {
	return JSON.parse(
		await readFile(
			join(drive.runRoot, "runtime", ".pi", "workflows", runId, "run.json"),
			"utf8",
		),
	) as RunRecord;
}

async function readPhaseAuthorities(
	drive: Awaited<ReturnType<typeof prepareDrive>>,
) {
	return Promise.all(
		["implementation", "review", "decision"].map(async (phase) =>
			JSON.parse(
				await readFile(
					join(
						drive.runRoot,
						"runtime",
						"workflow-bundles",
						`${RUN_ID}_${phase}`,
						"authority-policy.json",
					),
					"utf8",
				),
			),
		),
	) as Promise<
		Array<{
			worktreeAccess: "read" | "write";
			gitAuthority: "none";
			deniedReadRoots: string[];
		}>
	>;
}

async function readTrace(
	drive: Awaited<ReturnType<typeof prepareDrive>>,
): Promise<TraceRow[]> {
	return (await readFile(drive.tracePath, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TraceRow);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await realpath(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function expectedBranch(repository: string): string {
	return `maestro/workflow-cutover-e2e/${RUN_ID}/${repository}`;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: process.env });
}

function remoteHead(remote: string, branch: string): string | null {
	try {
		return git(remote, "rev-parse", `refs/heads/${branch}`).trim();
	} catch {
		return null;
	}
}
