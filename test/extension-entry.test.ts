// The entry: which surface a process gets, and what the commands do with it.
//
// The guard worth noticing is the one that is no longer written down. `/mode`
// used to need an operator-only check so a spawned agent could not widen its
// own posture. An agent process now never registers the command, so there is
// nothing to remember and nothing to forget.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	extensionPath,
	type HumanAsker,
	type SeatHost,
	startReadOnlyAgent,
	startSeat,
	startWorker,
} from "../packages/maestro/src/extension.js";
import { MaestroLink } from "../packages/maestro/src/link.js";
import { BUILT_IN_PERSONAS } from "../packages/maestro/src/personas.js";
import {
	AGENT_ID_ENV,
	SOCK_ENV,
	TOKEN_ENV,
} from "../packages/maestro/src/spawn.js";
import {
	createProductionWorkflowPlanRunner,
	type ProductionWorkflowPlanRunnerComponents,
} from "../packages/maestro/src/workflow/production-plan-runner.js";
import type { PreparedWorkflowRepository } from "../packages/maestro/src/workflow/repository-preparation.js";
import type { ReviewDecisionLedger } from "../packages/maestro/src/workflow/review-decision-ledger.js";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "maestro-entry-"));
	dirs.push(root);
	const path = join(root, "project");
	execFileSync("mkdir", ["-p", path]);
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "T",
		GIT_AUTHOR_EMAIL: "t@e.com",
		GIT_COMMITTER_NAME: "T",
		GIT_COMMITTER_EMAIL: "t@e.com",
	};
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path, env });
	writeFileSync(join(path, "README.md"), "# project\n");
	execFileSync("git", ["add", "README.md"], { cwd: path, env });
	execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: path, env });
	return path;
}

function workflowPlan(slug: string, project: string) {
	return {
		slug,
		title: "Workflow command plan",
		preflight: [],
		postflight: [],
		repos: [{ key: "app", path: project }],
		deliverables: [
			{
				id: "app",
				title: "Update app",
				body: "Keep the change small and preserve the public contract.",
				after: [],
				reads: [],
				repo: "app",
				tasks: [{ id: "implement", title: "Implement the change" }],
			},
		],
	};
}

function host(model?: { readonly provider: string; readonly id: string }) {
	const tools: { name: string }[] = [];
	const commands = new Map<
		string,
		{
			description: string;
			handler: (args: string, ctx: unknown) => Promise<void>;
		}
	>();
	const messages: string[] = [];
	const notices: [string, string][] = [];

	const pi: SeatHost = {
		registerTool: (tool) => tools.push(tool as { name: string }),
		registerCommand: (name, spec) =>
			commands.set(name, spec as ReturnType<typeof commands.get> & object),
		sendUserMessage: (text) => messages.push(text),
	};

	const ctx = {
		ui: { notify: (m: string, level: string) => notices.push([level, m]) },
		model,
	};

	return {
		pi,
		tools,
		messages,
		notices,
		run: (name: string, args = "") => {
			const command = commands.get(name);
			if (!command) throw new Error(`no /${name} registered`);
			return command.handler(args, ctx);
		},
		names: () => [...commands.keys()].sort(),
	};
}

describe("a process gets one surface, never both", () => {
	it("gives a seat its commands", () => {
		const h = host();
		startSeat(h.pi, { cwd: repo() });
		expect(h.names()).toEqual(["mode", "run", "stop"]);
	});

	it("gives a worker no commands at all", async () => {
		// The operator-only guard, made structural. There is no `/mode` to
		// refuse, so nothing has to remember to refuse it.
		const h = host();
		const started = startWorker(
			h.pi as unknown as { registerTool(tool: unknown): void },
			{
				agentId: "worker-api",
				socketPath: join(tmpdir(), "nothing-listening.sock"),
				token: "t",
				depth: 1,
			},
			{ extensions: [] },
		);
		// Nothing is listening, so the handshake fails — which is the point:
		// registration happened first, synchronously.
		await expect(started).rejects.toThrow();
		// `bash` is in the list because the SHELL is the thing safeguards guard.
		// A worker that got its shell any other way would have none.
		expect(h.tools.map((t) => t.name).sort()).toEqual([
			// No `ask` tool of our own: `ask` belongs to `packages/ask`, and what a
			// worker registers is a TRANSPORT that routes it to the maestro.
			"bash",
			// `commit` is the other half of `bash`, not an extra. The classifier
			// refuses `git commit` through the shell and names this tool instead —
			// and while it was missing, a live drive watched every deliverable
			// build its work and then fail, unable to record any of it.
			"commit",
			// `delete` for the same reason as `commit`: the classifier refuses
			// `rm` and names this tool instead. It went with `packages/modes` in
			// the flip and the refusal outlived it, so `rm -rf dist` was denied
			// with nowhere to go.
			"delete",
			"finish",
			"subagent",
		]);
		expect(h.names()).toEqual([]);
	});

	it("points a spawned agent at the file its maestro is running", () => {
		expect(extensionPath()).toMatch(/packages\/maestro\/src\/extension\.ts$/);
	});

	it("gives a no-wiring child exactly the reader surface — and no commands", () => {
		// Depth says agent, no wiring says nobody to dial: a read-only child.
		// This path used to be a bare early return that registered nothing; two
		// rulings changed it. Every agent holds `subagent` — depth is the cap,
		// which is what MAX_DEPTH exists for — and a reader holds a confined
		// shell, because "a shell is a write tool" predated ambient confinement.
		// Exactly two tools, and nothing else: no commands, no ask transport,
		// no reporter — a reader's only channel is the answer it returns.
		const h = host();
		startReadOnlyAgent(
			h.pi as unknown as { registerTool(tool: unknown): void },
			{ extensions: [] },
		);
		expect(h.tools.map((t) => t.name).sort()).toEqual(["bash", "subagent"]);
		expect(h.names()).toEqual([]);
	});

	it("refuses a writer's persona from the reader path too", async () => {
		// The reader's `subagent` resolves the same declared catalogue the
		// worker's does — a shared helper, so the two paths cannot drift on
		// what a persona is.
		const h = host();
		startReadOnlyAgent(
			h.pi as unknown as { registerTool(tool: unknown): void },
			{ extensions: [] },
		);
		const subagent = h.tools.find((t) => t.name === "subagent") as unknown as {
			execute: (id: string, p: unknown) => Promise<unknown>;
		};
		await expect(
			subagent.execute("call-1", {
				persona: "deliverable-worker",
				question: "anything",
			}),
		).rejects.toThrow(/writers are plan-authored/);
	});
});

describe("the seat is built on first use, not at load", () => {
	it("registers without touching the repository", () => {
		// An extension that reads a repo at load time is one that fails to load
		// outside a repo.
		const h = host();
		expect(() =>
			startSeat(h.pi, { cwd: join(tmpdir(), "definitely-not-a-repo") }),
		).not.toThrow();
		expect(h.tools).toEqual([]);
	});

	it("allows planning in an umbrella and defers the legacy base refusal until run", async () => {
		const outside = mkdtempSync(join(tmpdir(), "maestro-bare-"));
		dirs.push(outside);
		const h = host();
		const entry = startSeat(h.pi, { cwd: outside });
		const slug = "umbrella-base-refusal";
		entry.seat().store.remove(slug);
		entry.seat().store.savePlan({
			slug,
			title: "Umbrella plan",
			preflight: [],
			postflight: [],
			repos: [{ key: "app", path: join(outside, "app") }],
			deliverables: [
				{
					id: "app",
					title: "Build app",
					after: [],
					reads: [],
					repo: "app",
					tasks: [{ id: "build", title: "Build it" }],
				},
			],
		});
		try {
			await h.run("mode", "auto");
			await h.run("run", slug);
			expect(h.notices[1]?.[0]).toBe("warning");
			expect(h.notices[1]?.[1]).toMatch(/cannot tell what to branch from/);
		} finally {
			entry.seat().store.remove(slug);
		}
	});
});

describe("the workflow cutover authority", () => {
	it("is off by default and never loads coordinator code", async () => {
		const h = host();
		const load = vi.fn(async () => ({ authority: "workflow" }));
		const entry = startSeat(h.pi, {
			cwd: repo(),
			loadWorkflowCoordinator: load,
		});

		await expect(entry.workflowCoordinator()).resolves.toBeUndefined();
		expect(load).not.toHaveBeenCalled();
	});

	it("loads one coordinator only when the depth-zero cutover is explicit", async () => {
		const h = host();
		const coordinator = { authority: "workflow" };
		const load = vi.fn(async () => coordinator);
		const entry = startSeat(h.pi, {
			cwd: repo(),
			workflowCutover: true,
			loadWorkflowCoordinator: load,
		});

		await expect(entry.workflowCoordinator()).resolves.toBe(coordinator);
		await expect(entry.workflowCoordinator()).resolves.toBe(coordinator);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("fails closed when cutover is enabled without a composition", async () => {
		const h = host();
		const entry = startSeat(h.pi, {
			cwd: repo(),
			workflowCutover: true,
		});

		await expect(entry.workflowCoordinator()).rejects.toThrow(
			/no seat coordinator composition is installed/,
		);
	});

	it("keeps plan mode and the repository unchanged when approval is refused", async () => {
		const project = repo();
		const agentDir = mkdtempSync(join(tmpdir(), "maestro-workflow-command-"));
		dirs.push(agentDir);
		const h = host({ provider: "test", id: "implementer" });
		const ask = vi.fn(async (_questions: Parameters<HumanAsker["ask"]>[0]) => [
			{
				questionId: "workflow-plan-approval",
				value: "no",
				source: "human" as const,
			},
		]);
		const run = vi.fn(
			async (input: { asker: HumanAsker; onApproved?: () => void }) => {
				await input.asker.ask([]);
				return { status: "refused" as const, reason: "not-approved" as const };
			},
		);
		const entry = startSeat(h.pi, {
			cwd: project,
			agentDir,
			asker: { ask },
			workflowCutover: true,
			loadWorkflowPlanRunner: async () => ({ run }) as never,
		});
		entry.seat().store.savePlan(workflowPlan("refused-plan", project));
		const before = execFileSync("git", ["status", "--porcelain=v1"], {
			cwd: project,
			encoding: "utf8",
		});

		await h.run("mode", "auto");

		expect(ask).toHaveBeenCalledTimes(1);
		expect(entry.currentMode()).toBe("plan");
		expect(
			execFileSync("git", ["status", "--porcelain=v1"], {
				cwd: project,
				encoding: "utf8",
			}),
		).toBe(before);
		expect(h.notices.at(-1)?.[1]).toMatch(/not approved.*mode remains plan/);
	});

	it("lets a corrected plan start fresh after validation fails before approval", async () => {
		const project = repo();
		const agentDir = mkdtempSync(join(tmpdir(), "maestro-workflow-command-"));
		dirs.push(agentDir);
		const h = host({ provider: "test", id: "implementer" });
		const runRoots: string[] = [];
		let attempt = 0;
		const entry = startSeat(h.pi, {
			cwd: project,
			agentDir,
			asker: { ask: async () => [] },
			workflowCutover: true,
			loadWorkflowPlanRunner: async (input) => {
				runRoots.push(input.coordinatedRunRoot);
				attempt += 1;
				if (attempt === 1) throw new Error("preapproval validation failed");
				return {
					run: async () => ({
						status: "refused" as const,
						reason: "not-approved" as const,
					}),
				};
			},
		});
		entry.seat().store.savePlan(workflowPlan("corrected-plan", project));

		await h.run("mode", "auto");
		expect(h.notices.at(-1)?.[1]).toMatch(/preapproval validation failed/);
		entry.seat().store.savePlan({
			...workflowPlan("corrected-plan", project),
			title: "Corrected workflow command plan",
		});
		await h.run("mode", "auto");

		expect(attempt).toBe(2);
		expect(new Set(runRoots).size).toBe(2);
		expect(h.notices.at(-1)?.[1]).toMatch(/not approved/);
	});

	it("moves plan to auto only inside approved launch and routes /run through workflow", async () => {
		const project = repo();
		const agentDir = mkdtempSync(join(tmpdir(), "maestro-workflow-command-"));
		dirs.push(agentDir);
		const h = host({ provider: "test", id: "implementer" });
		const ask = vi.fn(async () => [
			{
				questionId: "workflow-plan-approval",
				value: "yes",
				source: "human" as const,
			},
		]);
		let entry: ReturnType<typeof startSeat>;
		const observedModes: string[] = [];
		const observedRunIds: string[] = [];
		const run = vi.fn(
			async (input: {
				asker: HumanAsker;
				onApproved?: () => void | Promise<void>;
				runId: string;
			}) => {
				observedModes.push(entry.currentMode());
				observedRunIds.push(input.runId);
				await input.asker.ask([]);
				await input.onApproved?.();
				observedModes.push(entry.currentMode());
				return {
					status: "launched" as const,
					approval: "new" as const,
					record: {},
					launchResult: { runId: input.runId },
				};
			},
		);
		entry = startSeat(h.pi, {
			cwd: project,
			agentDir,
			asker: { ask },
			workflowCutover: true,
			loadWorkflowPlanRunner: async () => ({ run }) as never,
		});
		entry.seat().store.savePlan(workflowPlan("approved-plan", project));

		await h.run("mode", "auto");
		expect(observedModes).toEqual(["plan", "auto"]);
		expect(entry.currentMode()).toBe("auto");
		expect(run).toHaveBeenCalledTimes(1);

		await h.run("run", "approved-plan");
		expect(run).toHaveBeenCalledTimes(2);
		expect(new Set(observedRunIds).size).toBe(2);
	});

	it("crosses Plan → Auto through the real production runner approval boundary", async () => {
		const project = repo();
		const agentDir = mkdtempSync(join(tmpdir(), "maestro-workflow-command-"));
		dirs.push(agentDir);
		const h = host({ provider: "test", id: "implementer" });
		const ask = vi.fn(async (_questions: Parameters<HumanAsker["ask"]>[0]) => [
			{
				questionId: "workflow-plan-approval",
				value: "yes",
				source: "human" as const,
			},
		]);
		let entry: ReturnType<typeof startSeat>;
		const phaseModes: string[] = [];
		const load = vi.fn(async (input) => {
			const prepared: PreparedWorkflowRepository = {
				key: "app",
				sourceRoot: project,
				worktree: join(input.coordinatedRunRoot, "repos", "app"),
				branch: "maestro/approved-plan/run/app",
				baseBranch: "main",
				baseSha: "a".repeat(40),
			};
			let ledger: ReviewDecisionLedger | undefined;
			const components: Partial<ProductionWorkflowPlanRunnerComponents> = {
				createCoordinator: () => ({}) as never,
				createPhaseLauncher: () => ({
					runImplementation: async () => {
						phaseModes.push(entry.currentMode());
					},
					runReview: async () => {
						throw new Error("no review phase was authored");
					},
					runDecision: async () => {
						throw new Error("no decision phase exists without findings");
					},
				}),
				createCheckpointer: () => ({
					checkpoint: ({ runId, phase }) => ({
						runId,
						phase,
						repositories: [
							{
								repository: "app",
								worktree: prepared.worktree,
								expectedBranch: prepared.branch,
								preHead: "a".repeat(40),
								finalHead: "a".repeat(40),
								changedPaths: [],
								commit: null,
							},
						],
						commitRefs: [],
					}),
				}),
				createPrivateArtifacts: () => ({
					putReviewForRun: () => ({
						reference: { id: "b".repeat(32), digest: "c".repeat(64) },
						projection: { findings: [] },
					}),
					joinAfterDecisions: () => ({ findings: [], rawFindings: [] }),
				}),
				createDecisionLedgers: () => ({
					seal: (gate) => {
						ledger = {
							schema: "maestro-review-decision-ledger-v1",
							runId: gate.runId,
							findingIds: [],
							decisions: [],
							repositories: gate.repositories.map((repository) => ({
								repository: repository.repository,
								expectedBranch: repository.expectedBranch,
								implementationHead: repository.implementationHead,
								finalHead: repository.finalHead,
							})),
						};
						return {
							reference: { runId: gate.runId, digest: "d".repeat(64) },
							ledger,
						};
					},
					load: () => ledger as ReviewDecisionLedger,
				}),
				createShipper: () => ({
					ship: async (shipping) => ({
						runId: shipping.runId,
						repositories: [],
					}),
				}),
				previewRepositories: async () => [prepared],
				prepareRepositories: async () => [prepared],
				continueRepositories: async () => [prepared],
			};
			return createProductionWorkflowPlanRunner({
				...input,
				runtimeResolver: {} as never,
				pullRequestCopyProducer: {
					produce: () => ({
						title: "Workflow command plan",
						intent: "Exercise the approved route.",
						rationale: "Keep the route deterministic.",
						changes: ["Invoke the production runner"],
					}),
				},
				components,
				depth: () => 0,
			}).runner;
		});
		entry = startSeat(h.pi, {
			cwd: project,
			agentDir,
			asker: { ask },
			workflowCutover: true,
			loadWorkflowPlanRunner: load,
		});
		entry.seat().store.savePlan(workflowPlan("approved-plan", project));

		expect(entry.currentMode()).toBe("plan");
		await h.run("mode", "auto");

		expect(ask).toHaveBeenCalledTimes(1);
		expect(ask.mock.calls[0]?.[0]).toHaveLength(1);
		expect(load).toHaveBeenCalledTimes(1);
		expect(phaseModes).toEqual(["auto"]);
		expect(entry.currentMode()).toBe("auto");
		expect(h.notices.at(-1)?.[1]).toMatch(/completed/);
	});

	it("does not enter auto from an umbrella when there is no plan to approve", async () => {
		const umbrella = mkdtempSync(join(tmpdir(), "maestro-umbrella-"));
		const agentDir = mkdtempSync(join(tmpdir(), "maestro-workflow-command-"));
		dirs.push(umbrella, agentDir);
		const h = host({ provider: "test", id: "implementer" });
		const entry = startSeat(h.pi, {
			cwd: umbrella,
			agentDir,
			workflowCutover: true,
		});
		await h.run("mode", "auto");
		expect(entry.currentMode()).toBe("plan");
		expect(h.notices.at(-1)?.[1]).toMatch(/No stored plan/);
	});

	it("binds a relative child repository to the umbrella before authorization", async () => {
		const project = repo();
		const umbrella = join(project, "..");
		const agentDir = mkdtempSync(join(tmpdir(), "maestro-workflow-command-"));
		dirs.push(agentDir);
		const h = host({ provider: "test", id: "implementer" });
		let authorizedRoots: readonly string[] = [];
		let compiledPath = "";
		const entry = startSeat(h.pi, {
			cwd: umbrella,
			agentDir,
			asker: { ask: async () => [] },
			workflowCutover: true,
			loadWorkflowPlanRunner: async (input) => {
				authorizedRoots = input.coordinatedRepositoryRoots;
				return {
					run: async (runInput) => {
						compiledPath = runInput.plan.repos[0]?.path ?? "";
						return { status: "refused", reason: "not-approved" };
					},
				};
			},
		});
		entry.seat().store.savePlan(workflowPlan("relative-plan", "project"));

		await h.run("mode", "auto");

		expect(authorizedRoots).toEqual([project]);
		expect(compiledPath).toBe(project);
		expect(entry.currentMode()).toBe("plan");
	});

	it("does not expose the legacy stop path during workflow cutover", async () => {
		const h = host();
		startSeat(h.pi, { cwd: repo(), workflowCutover: true });
		await h.run("stop");
		expect(h.notices.at(-1)).toEqual([
			"warning",
			expect.stringMatching(/\/stop.*unavailable/),
		]);
	});
});

describe("the commands", () => {
	it("reports and switches the posture", async () => {
		const h = host();
		startSeat(h.pi, { cwd: repo() });

		await h.run("mode");
		expect(h.notices[0]?.[1]).toBe("Mode is plan.");

		await h.run("mode", "hack");
		expect(h.notices[1]?.[1]).toContain("can write");
		expect(h.notices[1]?.[1]).toContain("safeguards off");
	});

	it("says which modes exist rather than accepting a wrong one", async () => {
		const h = host();
		startSeat(h.pi, { cwd: repo() });
		await h.run("mode", "yolo");
		expect(h.notices[0]?.[0]).toBe("warning");
		expect(h.notices[0]?.[1]).toContain("plan, auto, hack");
	});

	it("lists nothing when nothing is stored", async () => {
		const h = host();
		startSeat(h.pi, { cwd: repo() });
		await h.run("run");
		expect(h.notices[0]?.[1]).toBe("No plans stored yet.");
	});

	it("puts a refusal in front of the human, not in a stack trace", async () => {
		// Plan mode is the default, and it cannot run a plan — every deliverable
		// produces a worker.
		const h = host();
		startSeat(h.pi, { cwd: repo() });
		await h.run("run", "arc");
		expect(h.notices[0]?.[0]).toBe("warning");
	});

	it("registers the maestro's own tools once the seat exists", async () => {
		const h = host();
		startSeat(h.pi, { cwd: repo() });
		await h.run("mode");
		// No `ask`, no `respond`, no `finish`. The first two come from
		// `packages/ask`, which the manifest loads beside this one; `finish` is
		// a worker's, and the seat has nobody to report to.
		expect(h.tools.map((t) => t.name).sort()).toEqual([
			"bash",
			// `commit` and `delete` for the same reason a worker has them: the
			// classifier refuses `git commit` and `rm` for the MAESTRO too, and
			// names these tools. Granting them to the worker alone left a dead
			// end in the operator's own session — invisible because the guard
			// only ever checked the worker posture.
			"commit",
			"delete",
			"flight",
			"plan",
			// No `respond`: it belongs to `packages/ask`, which owns what a
			// question is. While it lived on maestro's runtime it answered every
			// question in a set with the same string, because the code settling
			// them had never seen a questionnaire.
			"subagent",
		]);
	});
});

describe("a worker consults subagents with the real personas", () => {
	it("resolves personas against the declared catalogue, not a made-up one", async () => {
		// The stub this replaced read `You are a ${agent}. Persona: ${persona}.`
		// — a brief that looks plausible and teaches a reviewer nothing about
		// what to look for. Asserted through an UNKNOWN persona, because the
		// error names what IS declared: if the worker were still inventing
		// briefs, every persona would resolve and nothing would be listed.
		const h = host();
		const started = startWorker(
			h.pi as unknown as { registerTool(tool: unknown): void },
			{
				agentId: "w",
				socketPath: join(tmpdir(), "nothing-listening.sock"),
				token: "t",
				depth: 1,
			},
			{ extensions: [] },
		);
		await expect(started).rejects.toThrow();

		const subagent = h.tools.find((t) => t.name === "subagent") as unknown as {
			execute: (id: string, p: unknown) => Promise<unknown>;
		};
		// Rejected while building the brief, before anything is spawned.
		await expect(
			subagent.execute("call-1", {
				agent: "reviewer",
				persona: "not-a-persona",
				question: "anything",
			}),
		).rejects.toThrow(
			new RegExp(BUILT_IN_PERSONAS.map((p) => p.id).join(".*")),
		);
	});

	it("refuses a writer's persona — the tool starts readers only", async () => {
		const h = host();
		const started = startWorker(
			h.pi as unknown as { registerTool(tool: unknown): void },
			{
				agentId: "w",
				socketPath: join(tmpdir(), "nothing-listening.sock"),
				token: "t",
				depth: 1,
			},
			{ extensions: [] },
		);
		await expect(started).rejects.toThrow();

		const subagent = h.tools.find((t) => t.name === "subagent") as unknown as {
			execute: (id: string, p: unknown) => Promise<unknown>;
		};
		await expect(
			subagent.execute("call-1", {
				persona: "deliverable-worker",
				question: "anything",
			}),
		).rejects.toThrow(/writers are plan-authored/);
	});
});

describe("a worker reports its held readers up the socket it already dials", () => {
	it("sends the current snapshot the moment the handshake completes", async () => {
		// Changes made before the wire existed are dropped, and THIS is what
		// makes that loss free: every message is the full map, so the snapshot
		// on connect catches the maestro up from nothing.
		const dir = mkdtempSync(join(tmpdir(), "maestro-entry-wire-"));
		dirs.push(dir);
		const socketPath = join(dir, "m.sock");
		const link = new MaestroLink({ token: "t" });
		await link.listen(socketPath);
		try {
			const snapshot = new Promise<[string, unknown]>((resolve) =>
				link.on("subagents", (agentId, held) => resolve([agentId, held])),
			);
			const h = host();
			const worker = await startWorker(
				h.pi as unknown as { registerTool(tool: unknown): void },
				{ agentId: "worker-api", socketPath, token: "t", depth: 1 },
				{ extensions: [] },
			);
			// This worker holds nothing yet, and says exactly that.
			expect(await snapshot).toEqual(["worker-api", []]);
			expect(link.heldBy("worker-api")).toEqual([]);
			worker.close();
		} finally {
			await link.close();
		}
	});
});

describe("the wiring a worker reads", () => {
	it("is the three variables the launcher sets", () => {
		// Named here so the entry and the launcher cannot drift on what a worker
		// needs to exist.
		expect([AGENT_ID_ENV, SOCK_ENV, TOKEN_ENV]).toEqual([
			"PI_MAESTRO_AGENT_ID",
			"PI_MAESTRO_SOCK",
			"PI_MAESTRO_TOKEN",
		]);
	});
});
