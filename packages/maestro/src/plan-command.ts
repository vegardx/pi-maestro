// `/plan` — the seat's only window onto what the plan tool stored.
//
// Until this existed, `loadPlan`, `exists`, `remove` and `list` had no callers
// at all: a plan could be written and then never listed, read, run or deleted
// from the seat. Storage with no reader is a drawer things go into.
//
// `run` STARTS THE RUN, AND THE MODEL IS NEVER ASKED TO. It used to write the
// input beside the plan and steer the session with the call to make, because
// the workflow client this seat holds could only read. It can start
// `plan-to-ship` now, so the command does: it loads the plan, builds the input,
// writes it beside the plan, and hands it to the injected `start` — the same
// allowlisted `startBuiltin` the plan-mode exit uses. Still no executor here:
// the run is the workflow runtime's, through the provider seam, and this file
// knows nothing about either beyond the one injected function.
//
// `ship` is the one verb that acts on the world, and it does not act here
// either: it hands a stored plan and a finished run to `publish.ts`, which runs
// every command through the seat's audited Bash tool. The injected `ship` is
// absent on a seat with no workflow runtime, and the command says so rather
// than pretending publication is a thing this file can do alone.
//
// The grammar is five verbs and nothing clever. Anything it does not recognise
// gets the usage line rather than a guess, because a mistyped effort that
// silently became `standard` would spend (or fail to spend) a deep run's budget.
//
// THERE IS NO SIXTH VERB, and each of the five is here for a stated reason:
// `list` and `show` read this project's plans; `run` starts or restarts the
// `plan-to-ship` run for a stored plan whose run never started or failed, which
// the plan-mode exit normally starts for you; `rm` removes one; `ship` is the
// manual publication fallback for when the automatic publication after the ship
// gate did not happen. A verb whose reason cannot be written on one line is a
// verb this command does not need.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	gateStops,
	inspectPlan,
	type Plan,
	type ResolvedPolicy,
	type Review,
	type ReviewLens,
	resolvePolicy,
	type Stage,
	withDefaultStages,
} from "./plan.js";
import {
	EFFORTS,
	type Effort,
	isEffort,
	toWorkflowInput,
	type WorkflowInput,
} from "./plan-input.js";
import type { Publication } from "./publish.js";
import type { AuthoredBy, PlanStore } from "./store.js";

/** The workflow a stored plan is handed to. Named once. */
export const PLAN_WORKFLOW_REF = "plan-to-ship";

/** The grammar, on one line, for the command list and the first prompt. */
export const PLAN_COMMAND_USAGE =
	`/plan list | show <slug> | run <slug> [${EFFORTS.join("|")}] | rm <slug> | ship <slug>` as const;

/**
 * The grammar plus what each verb is FOR.
 *
 * Printed whenever the parse fails, because the failures here are not typos so
 * much as wrong expectations — `run` looks like the normal way to start a run
 * and is not, and `ship` looks like the normal way to publish and is not.
 */
export const PLAN_COMMAND_HELP = [
	PLAN_COMMAND_USAGE,
	"",
	"  list          the plans stored for this project — plans are per project, and this",
	"                lists no other project's",
	"  show <slug>   one stored plan in full, with the session and cwd that authored it",
	"  run <slug>    start or restart `plan-to-ship` for a stored plan whose run did not",
	"                start or failed; the plan-mode exit normally starts it for you",
	"  rm <slug>     remove one stored plan and everything stored with it",
	"  ship <slug>   the manual publication fallback, for when the automatic publication",
	"                after the ship gate did not happen",
].join("\n");

export type PlanCommand =
	| { readonly kind: "list" }
	| { readonly kind: "show"; readonly slug: string }
	| {
			readonly kind: "run";
			readonly slug: string;
			/** Absent when the human named none: the plan's `policy.effort` decides. */
			readonly effort?: Effort;
	  }
	| { readonly kind: "ship"; readonly slug: string }
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
		case "ship":
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
			// Not defaulted here: an omitted effort has to reach
			// `toWorkflowInput` as an omission, or the plan's own `policy.effort`
			// is overridden by a default nobody typed.
			const effort = rest[1];
			if (effort !== undefined && !isEffort(effort))
				return {
					kind: "usage",
					problem: `unknown effort \`${effort}\` — one of ${EFFORTS.join(", ")}`,
				};
			return {
				kind: "run",
				slug: rest[0],
				...(effort ? { effort } : {}),
			};
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
		return "No stored plans for this project. The `plan` tool writes one.";
	const width = Math.max(...summaries.map((s) => s.slug.length));
	return [
		`${summaries.length} stored plan${summaries.length === 1 ? "" : "s"} for this project:`,
		...summaries.map(
			(s) =>
				`  ${s.slug.padEnd(width)}  ${s.title}` +
				`  (${s.deliverables} deliverable${s.deliverables === 1 ? "" : "s"}, updated ${s.savedAt || "unknown"})`,
		),
	].join("\n");
}

/** One review, with every field the author actually set. */
function renderReview(review: Review): string {
	const parts = [review.lens];
	if (review.skill) parts.push(`skill ${review.skill}`);
	if (review.tier) parts.push(`tier ${review.tier}`);
	if (review.diverse) parts.push("diverse");
	if (review.model) parts.push(`model ${review.model}`);
	// Said out loud, because "the effort dial decides" is a real answer and an
	// empty bracket reads like a missing field.
	if (!review.tier && !review.model && !review.diverse)
		parts.push("effort dial decides");
	return parts.join(", ");
}

/** One lens, with every routing field the author actually set. */
function renderLens(lens: ReviewLens): string {
	const parts: string[] = [];
	if (lens.tier) parts.push(`tier ${lens.tier}`);
	if (lens.diverse) parts.push("diverse");
	if (lens.skill) parts.push(`skill ${lens.skill}`);
	if (lens.model) parts.push(`model ${lens.model}`);
	return parts.length > 0 ? `${lens.id} (${parts.join(", ")})` : lens.id;
}

/** How many fix rounds a round-count actually buys, said in words. */
function renderRounds(rounds: number): string {
	if (rounds === 0) return "no fix rounds — the check passes or a human hears";
	return `up to ${rounds} fix round${rounds === 1 ? "" : "s"}`;
}

/**
 * One stage, as what it will do rather than as its JSON.
 *
 * `policy` is passed because a stage that set nothing is not a stage with no
 * answer — it is a stage taking the plan's, and printing a blank there would
 * read like a missing field.
 */
function renderStage(stage: Stage, policy: ResolvedPolicy): string {
	switch (stage.use) {
		case "implement":
			return (
				`${stage.id} — implement` +
				(stage.tools && stage.tools.length > 0
					? `, tools ${stage.tools.join(", ")}`
					: "")
			);
		case "verify-and-fix":
			return (
				`${stage.id} — verify-and-fix, ${renderRounds(stage.maxRounds ?? policy.maxFixRounds)}` +
				(stage.escalate && stage.escalate !== "none"
					? `, escalating to ${stage.escalate}`
					: "")
			);
		case "review-fan-out":
			return (
				`${stage.id} — review-fan-out over ${stage.lenses.map(renderLens).join(", ")}` +
				`, synthesis ${stage.synthesis ?? "optional"}`
			);
	}
}

/** The dials, resolved, and whether the plan set any of them itself. */
function renderPolicy(policy: ResolvedPolicy, declared: boolean): string[] {
	return [
		"",
		declared
			? "Policy:"
			: "Policy (the plan sets none — these are the defaults):",
		`  effort ${policy.effort}, gates ${policy.gates}, ${renderRounds(policy.maxFixRounds)}`,
		`  reviews that pin nothing: tier ${policy.reviewDefault.tier}${policy.reviewDefault.diverse ? ", diverse" : ""}`,
		`  publish ${policy.publish.mode}${policy.publish.base ? ` from ${policy.publish.base}` : ""}`,
	];
}

/**
 * The stored document, read back whole: repositories, the policy, the graph,
 * the work, how it compiles, and what is merely worth knowing about it.
 */
export function renderPlan(
	plan: Plan,
	warnings: readonly string[] = [],
	authoredBy?: AuthoredBy,
): string {
	// Read back as it will COMPILE: the stages are derived, never authored, and
	// showing only what was typed would hide the run from the person being asked
	// to approve it.
	const staged = withDefaultStages(plan);
	const lines = [`${plan.slug} — ${plan.title}`];
	// Who wrote it, before what it says: a plan read back in a project it was
	// not written in, or by a session that is not this one, is the first thing
	// worth knowing about it.
	if (authoredBy)
		lines.push(
			`  authored by session ${authoredBy.sessionId} in ${authoredBy.cwd}`,
		);
	if (plan.body) lines.push("", plan.body);
	lines.push("", "Repositories:");
	for (const repo of plan.repos) lines.push(`  ${repo.key}  ${repo.path}`);
	lines.push(...renderPolicy(staged.policy, plan.policy !== undefined));
	lines.push("", "Deliverables:");
	for (const d of staged.deliverables) {
		lines.push(`  ${d.id} — ${d.title}${d.repo ? ` [repo ${d.repo}]` : ""}`);
		if (d.body) lines.push(`    ${d.body}`);
		if (d.after.length > 0) lines.push(`    after ${d.after.join(", ")}`);
		if (d.reads.length > 0) lines.push(`    reads ${d.reads.join(", ")}`);
		for (const t of d.tasks) lines.push(`    - ${t.id}: ${t.title}`);
		for (const review of d.reviews ?? [])
			lines.push(`    read by ${renderReview(review)}`);
		lines.push("    stages (derived):");
		for (const stage of d.stages)
			lines.push(`      ${renderStage(stage, staged.policy)}`);
	}
	if (warnings.length > 0)
		lines.push("", ...warnings.map((warning) => `! ${warning}`));
	return lines.join("\n");
}

/**
 * Publication, injected.
 *
 * A function rather than a provider and a Bash tool, so this file keeps knowing
 * nothing about either: the seat builds it from the acquired workflow client and
 * its own audited Bash runner, and a test hands over a recorder. Absent means a
 * seat that cannot publish — no workflow runtime, or no Bash to publish with —
 * and `ship` says which rather than failing silently.
 */
export type PlanShip = (
	plan: Plan,
	ctx: Pick<ExtensionCommandContext, "ui" | "hasUI">,
) => Promise<Publication>;

/**
 * Starting a run, injected — the same shape publication has, for the same
 * reason: this file keeps knowing nothing about the workflow runtime or the
 * event bus it is found on.
 *
 * The run id, or `undefined` for a seat that could not start it — no workflow
 * runtime, a runtime that refused the ref or the input, a runtime that failed.
 * Every one of those has ALREADY been reported through the provider seam's
 * sanitized `notify`, naming what a person can do instead; `undefined` is this
 * command's cue to say its own one line and leave the plan stored.
 */
export type PlanStart = (
	input: WorkflowInput,
	ctx: Pick<ExtensionCommandContext, "ui" | "hasUI">,
) => Promise<string | undefined>;

export interface PlanCommandDeps {
	/**
	 * This project's plans. Every path this command writes comes off it —
	 * `workflowInputFile` rather than a join of its own — because the store's
	 * root is keyed by project and a join made here would be a second answer to
	 * "which project is this?".
	 */
	readonly store: PlanStore;
	/** @see PlanShip */
	readonly ship?: PlanShip;
	/** @see PlanStart */
	readonly start?: PlanStart;
}

/** Everything the command says, for a caller that wants it without a UI. */
export interface PlanCommandOutcome {
	readonly level: "info" | "warning" | "error";
	readonly message: string;
	/** The run that was started, when one was. */
	readonly runId?: string;
	/** Where the workflow input was written, when one was. */
	readonly wrote?: string;
}

function usage(problem?: string): PlanCommandOutcome {
	return {
		level: problem ? "warning" : "info",
		message: problem ? `${problem}.\n${PLAN_COMMAND_HELP}` : PLAN_COMMAND_HELP,
	};
}

function unknownSlug(slug: string): PlanCommandOutcome {
	return {
		level: "warning",
		message: `No stored plan \`${slug}\` in this project. \`/plan list\` shows what there is.`,
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
			const record = deps.store.loadRecord(command.slug);
			if (!record) return unknownSlug(command.slug);
			// Re-inspected rather than read from the store: the warnings are about
			// the world (a dirty tree), not about the document, and the world has
			// moved since it was written.
			return {
				level: "info",
				message: renderPlan(
					record.plan,
					inspectPlan(record.plan).warnings,
					record.authoredBy,
				),
			};
		}

		case "run": {
			const plan = deps.store.loadPlan(command.slug);
			if (!plan) return unknownSlug(command.slug);
			if (!deps.start)
				return {
					level: "warning",
					message:
						`This seat cannot start \`${command.slug}\`: starting a run needs the workflow runtime, ` +
						"and `@vegardx/pi-workflow` is an optional peer this session does not have. " +
						"The plan is stored and unchanged.",
				};
			const input = toWorkflowInput(plan, command.effort);
			// Written before the run is asked for, and kept whatever the answer is:
			// the export is the record of what this command would start, and a run
			// that failed to start is when it is wanted most.
			const path = deps.store.workflowInputFile(plan.slug);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(input, null, 2)}\n`, "utf8");
			const runId = await deps.start(input, ctx);
			// The refusal itself was already notified by the provider seam, with
			// what to do about it; this is the one line the command owes the caller.
			if (!runId)
				return {
					level: "warning",
					message:
						`\`${command.slug}\` was not started, so nothing is running. The plan is stored and ` +
						`\`/plan run ${command.slug}\` tries again. Input written to ${path}.`,
					wrote: path,
				};
			return {
				level: "info",
				message:
					`Started \`${plan.slug}\` as \`${PLAN_WORKFLOW_REF}\` run \`${runId}\` at effort ${input.effort}. ` +
					`Input written to ${path}. Starting it is the approval, and ${gateStops(resolvePolicy(plan.policy).gates)}.`,
				runId,
				wrote: path,
			};
		}

		case "ship": {
			const plan = deps.store.loadPlan(command.slug);
			if (!plan) return unknownSlug(command.slug);
			if (!deps.ship)
				return {
					level: "warning",
					message:
						`This seat cannot publish \`${command.slug}\`: publication needs the workflow runtime ` +
						"(to read the run's receipt) and the seat's audited Bash tool (to branch, check and push). " +
						"Cherry-pick the run's handoff refs by hand — `/workflow` names them.",
				};
			// Publication asks before it pushes, and a session with no dialogs
			// cannot answer. Refusing here is the same rule `/plan rm` follows.
			if (!ctx.hasUI)
				return {
					level: "error",
					message:
						`\`/plan ship\` pushes and needs a UI to confirm with, and this session has none. ` +
						"Publish by hand if you mean it.",
				};
			const published = await deps.ship(plan, ctx);
			// Every refusal was already notified by `publishPlan` as it happened,
			// with the branch it left behind named in it; this is the one line the
			// command itself owes the caller.
			return published.ok
				? {
						level: "info",
						message:
							`Published \`${command.slug}\` as \`${published.branch}\`` +
							`${published.prUrl ? ` — ${published.prUrl}` : ""}.`,
					}
				: {
						level: "warning",
						message:
							`\`/plan ship ${command.slug}\` stopped at \`${published.stoppedAt}\`` +
							`${published.branch ? `; the branch \`${published.branch}\` is in place` : ""}.`,
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
		description: `List, show, run, publish or remove a stored plan. ${PLAN_COMMAND_USAGE}`,
		handler: async (args, ctx) => {
			const outcome = await runPlanCommand(deps, parsePlanCommand(args), ctx);
			ctx.ui.notify(outcome.message, outcome.level);
		},
	};
}
