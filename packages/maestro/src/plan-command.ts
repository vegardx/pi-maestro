// `/plan` — the seat's only window onto what the plan tool stored.
//
// Until this existed, `loadPlan`, `exists`, `remove` and `list` had no callers
// at all: a plan could be written and then never listed, read, run or deleted
// from the seat. Storage with no reader is a drawer things go into.
//
// `run` DOES NOT RUN ANYTHING HERE. pi-maestro does not depend on the workflow
// runtime and is not going to: the input it builds is pure data, and the run is
// the model's `workflow_run` call, made in the open where the user can see it.
// A command that reached into a workflow service would put a second executor in
// this package, which is the shape the whole cutover removed. So `run` writes
// the input beside the plan, tells the user, and steers the session with the
// exact call to make — a hand-off, not an execution.
//
// The grammar is four verbs and nothing clever. Anything it does not recognise
// gets the usage line rather than a guess, because a mistyped effort that
// silently became `standard` would spend (or fail to spend) a deep run's budget.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { inspectPlan, type Plan, type WorkflowDelegation } from "./plan.js";
import {
	DEFAULT_EFFORT,
	EFFORTS,
	type Effort,
	isEffort,
	toWorkflowInput,
	type WorkflowInput,
} from "./plan-input.js";
import type { PlanStore } from "./store.js";

/** The workflow a stored plan is handed to. Named once. */
export const PLAN_WORKFLOW_REF = "plan-to-ship";

export const PLAN_COMMAND_USAGE =
	`/plan list | show <slug> | run <slug> [${EFFORTS.join("|")}] | rm <slug>` as const;

/**
 * How much workflow input goes into the session inline.
 *
 * A small plan is cheaper to paste than to read back, and seeing the exact
 * bytes in the transcript is the honest form of "approve this". A large one
 * would cost the same context twice — once in the steer, once when the model
 * echoes it into the tool call — so past this bound the message names the file
 * instead. Both paths write the same file, so the run is byte-identical either
 * way.
 */
export const INLINE_INPUT_LIMIT = 4096;

export type PlanCommand =
	| { readonly kind: "list" }
	| { readonly kind: "show"; readonly slug: string }
	| { readonly kind: "run"; readonly slug: string; readonly effort: Effort }
	| { readonly kind: "rm"; readonly slug: string }
	/** Not a verb: what to print when the grammar did not match. */
	| { readonly kind: "usage"; readonly problem?: string };

/**
 * The grammar, as a pure function.
 *
 * Separate from the handler so every rejection is testable without a store, a
 * filesystem or a UI — the rejections are the part that gets this wrong.
 */
export function parsePlanCommand(args: string): PlanCommand {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const [verb, ...rest] = words;
	if (verb === undefined) return { kind: "usage" };

	switch (verb) {
		case "list":
			return rest.length === 0
				? { kind: "list" }
				: { kind: "usage", problem: "`/plan list` takes no arguments" };
		case "show":
		case "rm": {
			if (rest.length !== 1)
				return {
					kind: "usage",
					problem: `\`/plan ${verb}\` takes exactly one slug`,
				};
			return { kind: verb, slug: rest[0] };
		}
		case "run": {
			if (rest.length < 1 || rest.length > 2)
				return {
					kind: "usage",
					problem: "`/plan run` takes a slug and an optional effort",
				};
			const effort = rest[1] ?? DEFAULT_EFFORT;
			if (!isEffort(effort))
				return {
					kind: "usage",
					problem: `unknown effort \`${effort}\` — one of ${EFFORTS.join(", ")}`,
				};
			return { kind: "run", slug: rest[0], effort };
		}
		default:
			return { kind: "usage", problem: `unknown subcommand \`${verb}\`` };
	}
}

/** One stored plan, in the shape a list is read in. */
export function renderPlanList(
	summaries: readonly {
		readonly slug: string;
		readonly title: string;
		readonly deliverables: number;
		readonly savedAt: string;
	}[],
): string {
	if (summaries.length === 0)
		return "No stored plans. The `plan` tool writes one.";
	const width = Math.max(...summaries.map((s) => s.slug.length));
	return [
		`${summaries.length} stored plan${summaries.length === 1 ? "" : "s"}:`,
		...summaries.map(
			(s) =>
				`  ${s.slug.padEnd(width)}  ${s.title}` +
				`  (${s.deliverables} deliverable${s.deliverables === 1 ? "" : "s"}, updated ${s.savedAt || "unknown"})`,
		),
	].join("\n");
}

/** The review intent, with every routing field the author actually set. */
function renderDelegation(by: WorkflowDelegation): string {
	const parts = [`lens ${by.lens}`];
	if (by.skill) parts.push(`skill ${by.skill}`);
	if (by.tier) parts.push(`tier ${by.tier}`);
	if (by.diverse) parts.push("diverse");
	if (by.model) parts.push(`model ${by.model}`);
	// Said out loud, because "the effort dial decides" is a real answer and an
	// empty bracket reads like a missing field.
	if (!by.tier && !by.model && !by.diverse) parts.push("effort dial decides");
	return parts.join(", ");
}

/**
 * The stored document, read back whole: repositories, the graph, the work, and
 * what is merely worth knowing about it.
 */
export function renderPlan(
	plan: Plan,
	warnings: readonly string[] = [],
): string {
	const lines = [`${plan.slug} — ${plan.title}`, "", "Repositories:"];
	for (const repo of plan.repos) lines.push(`  ${repo.key}  ${repo.path}`);
	lines.push("", "Deliverables:");
	for (const d of plan.deliverables) {
		lines.push(`  ${d.id} — ${d.title}${d.repo ? ` [repo ${d.repo}]` : ""}`);
		if (d.body) lines.push(`    ${d.body}`);
		if (d.after.length > 0) lines.push(`    after ${d.after.join(", ")}`);
		if (d.reads.length > 0) lines.push(`    reads ${d.reads.join(", ")}`);
		for (const t of d.tasks)
			lines.push(
				`    - ${t.id}: ${t.title}` +
					(t.by ? ` — review (${renderDelegation(t.by)})` : ""),
			);
	}
	if (warnings.length > 0)
		lines.push("", ...warnings.map((warning) => `! ${warning}`));
	return lines.join("\n");
}

/**
 * The hand-off the model reads: one tool call, stated exactly, and who may
 * approve it — which is never the model.
 */
export function renderHandoff(
	input: WorkflowInput,
	inputPath: string,
	json: string,
): string {
	const call =
		json.length <= INLINE_INPUT_LIMIT
			? `workflow_run { "ref": ${JSON.stringify(PLAN_WORKFLOW_REF)}, "input": ${json} }`
			: `workflow_run { "ref": ${JSON.stringify(PLAN_WORKFLOW_REF)}, "input": <the JSON in ${inputPath}> }`;
	return [
		`Run the stored plan \`${input.plan.slug}\` at effort ${input.effort}.`,
		"",
		"Make exactly this call:",
		"",
		call,
		"",
		json.length <= INLINE_INPUT_LIMIT
			? `The same input is on disk at ${inputPath} (planDigest ${input.planDigest}) if you would rather read it than copy it.`
			: `Read ${inputPath} and pass its contents verbatim as \`input\` — ${json.length} bytes, planDigest ${input.planDigest}.`,
		"",
		"Do not ask me to approve the plan and do not decide anything on my behalf:",
		`the run parks at its \`approve-plan\` checkpoint, and that checkpoint is the approval record. Surface the run and stop.`,
	].join("\n");
}

export interface PlanCommandDeps {
	readonly store: PlanStore;
	/** Where the exported workflow input for a slug belongs. */
	readonly inputPath: (slug: string) => string;
	/**
	 * How the session is steered. Optional because a host that cannot inject a
	 * message must still be able to run the command — it gets the call printed
	 * rather than nothing at all.
	 */
	readonly sendUserMessage?: (
		content: string,
		options?: { deliverAs?: "steer" | "followUp" },
	) => void;
}

/** Everything the command says, for a caller that wants it without a UI. */
export interface PlanCommandOutcome {
	readonly level: "info" | "warning" | "error";
	readonly message: string;
	/** The text handed to the model, when a hand-off happened. */
	readonly steer?: string;
	/** Where the workflow input was written, when one was. */
	readonly wrote?: string;
}

function usage(problem?: string): PlanCommandOutcome {
	return {
		level: problem ? "warning" : "info",
		message: problem
			? `${problem}.\n${PLAN_COMMAND_USAGE}`
			: PLAN_COMMAND_USAGE,
	};
}

function unknownSlug(slug: string): PlanCommandOutcome {
	return {
		level: "warning",
		message: `No stored plan \`${slug}\`. \`/plan list\` shows what there is.`,
	};
}

/**
 * Run one parsed command.
 *
 * Returns what to say rather than saying it, so the decision and the rendering
 * are testable apart from the dialog that carries them.
 */
export async function runPlanCommand(
	deps: PlanCommandDeps,
	command: PlanCommand,
	ctx: Pick<ExtensionCommandContext, "ui" | "hasUI">,
): Promise<PlanCommandOutcome> {
	switch (command.kind) {
		case "usage":
			return usage(command.problem);

		case "list":
			return { level: "info", message: renderPlanList(deps.store.list()) };

		case "show": {
			const plan = deps.store.loadPlan(command.slug);
			if (!plan) return unknownSlug(command.slug);
			// Re-inspected rather than read from the store: the warnings are about
			// the world (a dirty tree), not about the document, and the world has
			// moved since it was written.
			return {
				level: "info",
				message: renderPlan(plan, inspectPlan(plan).warnings),
			};
		}

		case "run": {
			const plan = deps.store.loadPlan(command.slug);
			if (!plan) return unknownSlug(command.slug);
			const input = toWorkflowInput(plan, command.effort);
			const path = deps.inputPath(plan.slug);
			const json = `${JSON.stringify(input, null, 2)}`;
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${json}\n`, "utf8");
			const steer = renderHandoff(input, path, json);
			if (deps.sendUserMessage)
				deps.sendUserMessage(steer, { deliverAs: "followUp" });
			return {
				level: "info",
				message: deps.sendUserMessage
					? `Handed \`${plan.slug}\` to the model as \`workflow_run { ref: "${PLAN_WORKFLOW_REF}" }\` at effort ${input.effort}. ` +
						`Input written to ${path}. Approval is the run's \`approve-plan\` checkpoint, not this command.`
					: // No steering channel: the call is printed so the hand-off is
						// still possible by hand, instead of failing silently.
						`This host cannot steer the session. Input written to ${path}.\n\n${steer}`,
				steer,
				wrote: path,
			};
		}

		case "rm": {
			if (!deps.store.exists(command.slug)) return unknownSlug(command.slug);
			// A delete with no one to ask is a delete nobody agreed to. Refusing
			// is not an inconvenience here: the path is printed, and `rm -rf` is
			// a thing the operator already has.
			if (!ctx.hasUI)
				return {
					level: "error",
					message:
						`\`/plan rm\` needs a UI to confirm, and this session has none. ` +
						`Remove the plan directory by hand if you mean it.`,
				};
			const plan = deps.store.loadPlan(command.slug);
			const confirmed = await ctx.ui.confirm(
				"Remove plan",
				`Delete \`${command.slug}\`${plan ? ` — ${plan.title}` : ""} and everything stored with it? This cannot be undone.`,
			);
			if (!confirmed)
				return { level: "info", message: `Kept \`${command.slug}\`.` };
			deps.store.remove(command.slug);
			return { level: "info", message: `Removed \`${command.slug}\`.` };
		}
	}
}

/** The registered command: parse, run, and say the one thing it decided. */
export function createPlanCommand(deps: PlanCommandDeps): {
	description: string;
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
} {
	return {
		description: `List, show, run or remove a stored plan. ${PLAN_COMMAND_USAGE}`,
		handler: async (args, ctx) => {
			const outcome = await runPlanCommand(deps, parsePlanCommand(args), ctx);
			ctx.ui.notify(outcome.message, outcome.level);
		},
	};
}
