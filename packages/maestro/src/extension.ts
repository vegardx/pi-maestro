import { join, resolve } from "node:path";
import {
	type ExtensionCommandContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { MODE_NAMES, type ModeName } from "./mode.js";
import { maestroRoot } from "./paths.js";
import type { Plan } from "./plan.js";
import { createSeat, type Seat } from "./seat.js";
import {
	loadOrCreateWorkflowCommandRun,
	releaseUnapprovedWorkflowCommandRun,
	releaseWorkflowCommandRun,
	workflowCommandAuthoredDigest,
} from "./workflow/command-run.js";
import type {
	WorkflowPlanRunnerInput,
	WorkflowPlanRunnerResult,
} from "./workflow/workflow-plan-runner.js";

export interface SeatHost {
	registerTool(tool: unknown): void;
	registerCommand(name: string, spec: unknown): void;
	sendUserMessage(text: string, opts?: unknown): unknown;
}

export interface HumanAsker {
	ask(questions: Questionnaire): Promise<Answers>;
}

export interface WorkflowPlanRunnerLoaderInput {
	readonly coordinatedRunRoot: string;
	readonly maestroStateRoot: string;
	readonly coordinatedRepositoryRoots: readonly string[];
	readonly plan: Plan;
}

export interface LoadedWorkflowPlanRunner {
	run(input: WorkflowPlanRunnerInput): Promise<WorkflowPlanRunnerResult>;
}

export function askThroughCapability(asker: HumanAsker): (
	question: string,
) => Promise<{
	readonly answer: string;
	readonly from: "maestro" | "human";
}> {
	return async (question) => {
		const answers = await asker.ask([
			{ id: "maestro", question, allowFreeText: true, blocking: true },
		]);
		const answer = answers[0];
		if (!answer || answer.deferred || answer.skipped || !answer.value.trim())
			return {
				answer:
					"nobody answered this. Decide for yourself and say in your hand-off what you assumed.",
				from: "maestro",
			};
		return {
			answer: answer.value,
			from: answer.source === "human" ? "human" : "maestro",
		};
	};
}

function planOnlyPullRequestCopy(plan: Plan, repositoryKey: string) {
	const deliverables = plan.deliverables.filter(
		(deliverable) => (deliverable.repo ?? plan.repos[0]?.key) === repositoryKey,
	);
	const rationale = deliverables
		.flatMap((deliverable) => [
			deliverable.body,
			...deliverable.tasks.filter((task) => !task.by).map((task) => task.body),
		])
		.filter((body): body is string => Boolean(body?.trim()));
	const changes = deliverables.flatMap((deliverable) =>
		deliverable.tasks.filter((task) => !task.by).map((task) => task.title),
	);
	if (rationale.length === 0)
		throw new Error(
			`plan \`${plan.slug}\` has no authored rationale for ${repositoryKey}; refusing to invent pull-request rationale`,
		);
	if (changes.length === 0)
		throw new Error(
			`plan \`${plan.slug}\` has no implementation changes for ${repositoryKey}`,
		);
	return {
		title: plan.title,
		intent: `Implement the approved \`${plan.slug}\` plan in ${repositoryKey}.`,
		rationale: rationale.join("\n\n"),
		changes,
	};
}

export function startSeat(
	pi: SeatHost,
	options: {
		readonly cwd?: string;
		readonly agentDir?: string;
		readonly asker?: HumanAsker;
		readonly loadWorkflowPlanRunner?: (
			input: WorkflowPlanRunnerLoaderInput,
		) => Promise<LoadedWorkflowPlanRunner>;
	} = {},
): { seat(): Seat; currentMode(): ModeName } {
	const cwd = options.cwd ?? process.cwd();
	let built: Seat | undefined;
	const workflowRunners = new Map<string, Promise<LoadedWorkflowPlanRunner>>();

	const seat = (): Seat => {
		if (built) return built;
		built = createSeat({
			cwd,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
			...(options.asker
				? { askHuman: askThroughCapability(options.asker) }
				: {}),
		});
		for (const tool of built.tools.definitionsFor("maestro"))
			pi.registerTool(tool);
		return built;
	};

	const runWorkflowPlan = async (
		slug: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		if (!options.loadWorkflowPlanRunner)
			throw new Error("no production workflow plan runner is installed");
		if (!options.asker)
			throw new Error(
				"workflow execution needs the ask-user-question package for plan approval",
			);
		const authoredPlan = seat().store.loadPlan(slug);
		if (!authoredPlan) throw new Error(`no stored plan named \`${slug}\``);
		const plan = {
			...authoredPlan,
			repos: authoredPlan.repos.map((repository) => ({
				...repository,
				path: resolve(cwd, repository.path),
			})),
		};
		const current = ctx.model;
		if (!current?.provider || !current.id)
			throw new Error(
				"workflow execution needs a concrete current seat model (provider/model)",
			);
		const implementationModel = `${current.provider}/${current.id}`;
		const authoredDigest = workflowCommandAuthoredDigest({
			plan,
			implementationModel,
			decisionModel: implementationModel,
		});
		const agentDir = options.agentDir ?? getAgentDir();
		const root = maestroRoot(agentDir);
		const maestroStateRoot = join(root, "workflow-state");
		const commandRun = loadOrCreateWorkflowCommandRun({
			maestroStateRoot,
			coordinatedRunsRoot: join(root, "workflow-runs"),
			planSlug: plan.slug,
			authoredDigest,
		});
		let result: WorkflowPlanRunnerResult;
		try {
			const loaded =
				workflowRunners.get(commandRun.runId) ??
				options.loadWorkflowPlanRunner({
					coordinatedRunRoot: commandRun.coordinatedRunRoot,
					maestroStateRoot,
					coordinatedRepositoryRoots: plan.repos.map(({ path }) => path),
					plan,
				});
			workflowRunners.set(commandRun.runId, loaded);
			result = await (await loaded).run({
				runId: commandRun.runId,
				coordinatedRunRoot: commandRun.coordinatedRunRoot,
				plan,
				implementationModel,
				decisionModel: implementationModel,
				asker: options.asker,
				onApproved: () => {
					if (seat().mode().name !== "auto") seat().setMode("auto");
				},
			});
		} catch (error) {
			releaseUnapprovedWorkflowCommandRun({
				maestroStateRoot,
				coordinatedRunsRoot: join(root, "workflow-runs"),
				planSlug: plan.slug,
				runId: commandRun.runId,
			});
			workflowRunners.delete(commandRun.runId);
			throw error;
		}
		releaseWorkflowCommandRun({
			maestroStateRoot,
			planSlug: plan.slug,
			runId: commandRun.runId,
		});
		workflowRunners.delete(commandRun.runId);
		if (result.status === "refused") {
			ctx.ui.notify(
				`Plan \`${plan.slug}\` was not approved; mode remains ${seat().mode().name}.`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			`Workflow \`${plan.slug}\` completed as ${result.launchResult.runId}.`,
			"info",
		);
	};

	pi.registerCommand("mode", {
		description: `Switch posture. /mode [${MODE_NAMES.join("|")}]`,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const wanted = args.trim().toLowerCase();
			if (!wanted) {
				ctx.ui.notify(`Mode is ${seat().mode().name}.`, "info");
				return;
			}
			if (!MODE_NAMES.includes(wanted as ModeName)) {
				ctx.ui.notify(
					`Unknown mode \`${wanted}\` — one of ${MODE_NAMES.join(", ")}.`,
					"warning",
				);
				return;
			}
			if (wanted === "auto" && seat().mode().name === "plan") {
				const selected = seat().store.list()[0];
				if (!selected) {
					ctx.ui.notify(
						"No stored plan is available to approve and run; mode remains plan.",
						"warning",
					);
					return;
				}
				try {
					await runWorkflowPlan(selected.slug, ctx);
				} catch (error) {
					ctx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"warning",
					);
				}
				return;
			}
			const next = seat().setMode(wanted as ModeName);
			ctx.ui.notify(
				`Mode ${next.name}: ${next.cwd === "write" ? "can write" : "read-only"}, safeguards ${next.safeguards}.`,
				"info",
			);
		},
	});

	pi.registerCommand("run", {
		description: "Run a stored plan. /run <slug>, or /run to list them.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const slug = args.trim();
			try {
				if (!slug) {
					const plans = seat().store.list();
					ctx.ui.notify(
						plans.length === 0
							? "No plans stored yet."
							: plans
									.map((p) => `${p.slug} — ${p.title} (${p.deliverables})`)
									.join("\n"),
						"info",
					);
					return;
				}
				if (seat().mode().name !== "auto")
					throw new Error(
						"workflow plans run only in auto mode; use `/mode auto` to preview and approve the most recent plan",
					);
				await runWorkflowPlan(slug, ctx);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"warning",
				);
			}
		},
	});

	return {
		seat,
		currentMode: () => built?.mode().name ?? "plan",
	};
}

export default defineExtension(
	{
		name: "maestro",
		path: "packages/maestro/src/extension.ts",
		doc: "Author, approve, and run autonomous multi-repository workflows.",
	},
	async (pi, maestro) => {
		const asker = maestro.capabilities.get(CAPABILITIES.ask) as
			| HumanAsker
			| undefined;
		const agentDir = getAgentDir();
		const seatEntry = startSeat(pi, {
			agentDir,
			...(asker ? { asker } : {}),
			loadWorkflowPlanRunner: async (input) => {
				if (input.plan.preflight.length > 0)
					throw new Error(
						"workflow execution does not support autonomous preflight seat tasks",
					);
				if (input.plan.postflight.length > 0)
					throw new Error(
						"workflow execution does not support autonomous postflight seat tasks",
					);
				for (const repository of input.plan.repos)
					planOnlyPullRequestCopy(input.plan, repository.key);
				const [production, runtime] = await Promise.all([
					import("./workflow/production-plan-runner.js"),
					import("./workflow/host-runtime-resolver.js"),
				]);
				const usage = maestro.capabilities.get(CAPABILITIES.usage);
				return production.createProductionWorkflowPlanRunner({
					...input,
					runtimeResolver: new runtime.HostWorkflowPhaseRuntimeResolver({
						cwd: process.cwd(),
						agentDir,
					}),
					pullRequestCopyProducer: {
						produce: ({ plan, repository }) =>
							planOnlyPullRequestCopy(plan, repository.key),
					},
					...(usage ? { usage } : {}),
				}).runner;
			},
		});
		const { installMaestroObservability } = await import("./observability.js");
		installMaestroObservability(pi, maestro, seatEntry.currentMode);
	},
);
