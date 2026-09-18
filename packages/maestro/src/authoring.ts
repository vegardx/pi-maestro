// Authoring: how a plan gets written.
//
// ONE TOOL, AND IT TAKES THE WHOLE PLAN. There is no add-a-deliverable, no
// move-a-task, no reorder. Every incremental authoring API this system has had
// grew rules about what may be edited once something has started, ordering
// constraints between calls, and half-written states that were valid for no
// reason except that the next call had not arrived yet — and the model had to
// hold all of it while also thinking about the work.
//
// Writing the whole document has none of that. The plan is either valid or it
// is not, `validatePlan` says everything wrong with it at once, and nothing
// invalid reaches disk. Extending a plan means sending it again with more in
// it, which needs no merge semantics because there is no merge.

import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ModeName } from "./mode.js";
import { MAX_INTENT_LENGTH } from "./pending-exit.js";
import {
	inspectPlan,
	type Plan,
	type PlanHostPort,
	type PlanPolicy,
} from "./plan.js";
import { PLAN_WORKFLOW_REF } from "./plan-command.js";
import {
	PLAN_DOCUMENT_GUIDE,
	PlanSchema,
	planFrom,
	withoutEmptyOptionals,
} from "./plan-document.js";
import { DEFAULT_EFFORT, EFFORTS } from "./plan-input.js";
import type { PlanStore } from "./store.js";

/** Both outcomes report the same shape, so a caller needs no narrowing. */
interface PlanToolDetails {
	readonly stored: boolean;
	readonly errors: readonly string[];
	/** Non-fatal findings — a dirty repository, today. Recorded, never fatal. */
	readonly warnings: readonly string[];
	readonly slug: string;
	readonly deliverables: number;
}

export interface AuthoringDeps {
	readonly store: PlanStore;
	/** The repository the maestro is sitting in — the default for `repos`. */
	readonly cwd: () => string;
	/**
	 * The posture the write happened in. Plan mode has no exit path — it is a
	 * tool posture, not a state machine — so a successful write is the nearest
	 * thing it has to a completion point, and that is where the way out is said.
	 */
	readonly mode?: () => ModeName;
	/**
	 * The host a pinned review `model` or `skill` is checked against, read at
	 * call time because the session it describes outlives neither the seat nor
	 * this tool. @see PlanHostPort
	 *
	 * The same seam the store is given, from the same place, so the plan the
	 * tool accepts and the plan the store saves are judged against one host.
	 */
	readonly host?: () => PlanHostPort | undefined;
	/**
	 * The dials, from whoever already decided them.
	 *
	 * NOT A PARAMETER OF THIS TOOL, on purpose. Effort, gates, publication and
	 * the base branch are answered in the plan-mode exit's dialogs, before any
	 * document exists; version 4 pasted them into the steer as a JSON block for
	 * the model to echo back, which made the author responsible for copying a
	 * decision they had no part in and exposed the compiler's dials as if they
	 * were authoring choices. The seat attaches them here instead. Absent — in
	 * auto or hack, with no exit in progress — means `resolvePolicy` fills the
	 * defaults, exactly as it always did for a plan that set none.
	 */
	readonly policy?: () => PlanPolicy | undefined;
}

/**
 * Write a plan.
 *
 * ONE WAY OF ASKING, NOT THE DOCUMENT. The shape, the field guidance and the
 * two pure steps from an authored document to a stored one live in
 * `plan-document.ts`; this registers a tool over them and does the storing.
 *
 * The failure path is the interesting one: a rejected plan comes back with
 * EVERY error, because an author fixing one error per round trip through five
 * round trips is an author that starts guessing.
 */
export function createPlanTool(deps: AuthoringDeps): ToolDefinition {
	return defineTool({
		name: "plan",
		label: "Plan",
		description: PLAN_DOCUMENT_GUIDE,
		promptSnippet:
			"write the whole plan: deliverables in a graph, each an ordered list of work.",
		parameters: PlanSchema,
		async execute(_id, submitted) {
			// Before anything reads the document: an optional field left empty is
			// not a claim, so it is dropped rather than refused. Required fields
			// are untouched, and an empty one is still refused by name below.
			const authored = withoutEmptyOptionals(submitted);
			const policy = deps.policy?.();
			const plan = planFrom(authored, {
				cwd: deps.cwd(),
				...(policy ? { policy } : {}),
			});

			const { errors, warnings } = inspectPlan(plan, undefined, deps.host?.());
			const details = (stored: boolean): PlanToolDetails => ({
				stored,
				errors,
				warnings,
				slug: plan.slug,
				deliverables: plan.deliverables.length,
			});
			if (errors.length > 0)
				return {
					content: [
						{
							type: "text" as const,
							text: [
								`This plan was not stored. ${errors.length === 1 ? "One thing is" : `${errors.length} things are`} wrong with it:`,
								"",
								...errors.map((error) => `- ${error}`),
								"",
								"Send the whole plan again with these fixed.",
							].join("\n"),
						},
					],
					details: details(false),
				};

			deps.store.savePlan(plan);
			return {
				content: [
					{
						type: "text" as const,
						text: describe(plan, warnings, deps.mode?.()),
					},
				],
				details: details(true),
			};
		},
	});
}

/**
 * What was stored, read back in the shape that matters: the order things will
 * run in, and what each one waits for. An author who cannot see the graph they
 * just wrote will write the same wrong edge twice.
 */
function describe(
	plan: Plan,
	warnings: readonly string[] = [],
	mode?: ModeName,
): string {
	const lines = [
		`Stored \`${plan.slug}\` — ${plan.title}.`,
		"",
		...plan.deliverables.map((d) => {
			const waits = d.after.length > 0 ? ` after ${d.after.join(", ")}` : "";
			const reads = d.reads.length > 0 ? ` reads ${d.reads.join(", ")}` : "";
			// The lenses by name, not a count: "2 reviews" is the one reading an
			// author cannot check against what they meant to ask for.
			const lenses = d.reviews ?? [];
			const read =
				lenses.length > 0
					? `, read by ${lenses.map((review) => review.lens).join(", ")}`
					: "";
			return `- ${d.id}: ${d.tasks.length} task${d.tasks.length === 1 ? "" : "s"}${read}${waits}${reads}`;
		}),
	];
	if (warnings.length > 0)
		lines.push("", ...warnings.map((warning) => `! ${warning}`));
	// The offer, not a status line. What was here before ("workflow execution is
	// unavailable") told the author that the thing they had just done led
	// nowhere, which stopped being true the moment a workflow could take this
	// document. Both ways of starting a run are named because the human and the
	// model reach for different ones.
	lines.push(
		"",
		`Run it: \`/plan run ${plan.slug} [${EFFORTS.join("|")}]\`, or call`,
		`\`workflow_run { ref: "${PLAN_WORKFLOW_REF}", input: { plan, planDigest, effort } }\``,
		`yourself — effort is one of ${EFFORTS.join(", ")}, and defaults to ${DEFAULT_EFFORT}.`,
		"",
		"Approval is not given here. The run parks at its `approve-plan`",
		"checkpoint and a human decides it; that decision is the approval record.",
	);
	if (mode === "plan")
		lines.push(
			"",
			"You are in plan mode, which cannot write files and from which you",
			"cannot start a workflow run: `workflow_run` and `workflow_propose` are",
			"refused here, this plan included. I start a run with `/workflow run`,",
			"and leaving plan mode starts this plan's own run — its blind reviewer",
			"is what checks the plan, not a workflow you start over it. To hand-edit",
			"this plan instead, ask for `/mode auto`.",
		);
	return lines.join("\n");
}

// ── The agreed description ───────────────────────────────────────────────────
//
// The plan-mode exit needs one thing from the conversation before it needs the
// plan: two or three sentences saying what we are doing and why. A human is not
// asked to write them — the conversation already contains them — and the model
// is not trusted to decide they are right. So the model submits them HERE, a
// dialog shows them back, and only an agreed description opens the `plan` tool.
//
// It is a tool rather than a message because the exit has to know when the
// sentences arrive and has to have the exact text: a model that answers in
// prose is a model whose answer has to be parsed out of a transcript.

/** The tool's name, in the one place it exists. */
export const PLAN_INTENT_TOOL = "plan_intent";

/** Two or three sentences. Fewer is a title; more is the plan. */
export const MIN_INTENT_SENTENCES = 2;
export const MAX_INTENT_SENTENCES = 3;

/**
 * How many sentences a submission has.
 *
 * Terminator-counting, deliberately simple: a sentence ends at `.`, `!` or `?`
 * followed by whitespace or the end of the text. It over-counts an abbreviation
 * and under-counts a semicolon, which is why the refusal says the count it
 * arrived at rather than only that the text was wrong.
 */
export function countSentences(text: string): number {
	return text
		.trim()
		.split(/[.!?]+(?:\s|$)/)
		.filter((part) => part.trim().length > 0).length;
}

/** Why this submission is not two or three sentences, or nothing. */
export function intentProblem(summary: string): string | undefined {
	const text = summary.trim();
	if (text.length === 0) return "it is empty";
	if (text.length > MAX_INTENT_LENGTH)
		return `it is ${text.length} characters, past the ${MAX_INTENT_LENGTH} bound`;
	const sentences = countSentences(text);
	if (sentences < MIN_INTENT_SENTENCES || sentences > MAX_INTENT_SENTENCES)
		return `it reads as ${sentences} sentence${sentences === 1 ? "" : "s"}, and ${MIN_INTENT_SENTENCES} to ${MAX_INTENT_SENTENCES} are asked for — each one ending in \`.\`, \`!\` or \`?\``;
	return undefined;
}

/** What a caller of the tool learns; the `tool_result` trigger reads this. */
export interface PlanIntentDetails {
	readonly submitted: boolean;
	readonly summary: string;
	readonly problem?: string;
}

/**
 * Submit the agreed description.
 *
 * It stores nothing and decides nothing: the `tool_result` of this call is what
 * opens the one dialog that agrees it, and the exit flow owns the record.
 */
export function createPlanIntentTool(): ToolDefinition {
	return defineTool({
		name: PLAN_INTENT_TOOL,
		label: "Plan intent",
		description:
			"Submit two or three sentences saying what we are doing and why, written from this conversation. Held only while a plan-mode exit is in progress; the human agrees to the sentences before the plan is written.",
		promptSnippet:
			"submit the two or three sentences that say what we are doing and why.",
		parameters: Type.Object({
			summary: Type.String({
				description: `Two or three sentences, at most ${MAX_INTENT_LENGTH} characters: what we are doing and why, from this conversation. Not a title, not the plan.`,
			}),
		}),
		async execute(_id, { summary }) {
			const problem = intentProblem(summary);
			if (problem)
				return {
					content: [
						{
							type: "text" as const,
							text: `That description was not submitted: ${problem}. Send it again as two or three sentences on what we are doing and why.`,
						},
					],
					isError: true,
					details: { submitted: false, summary, problem } as PlanIntentDetails,
				};
			const text = summary.trim();
			return {
				content: [
					{
						type: "text" as const,
						text: "Submitted. The human is being asked whether this is what we are doing; wait for their answer rather than continuing.",
					},
				],
				details: { submitted: true, summary: text } as PlanIntentDetails,
			};
		},
	});
}
