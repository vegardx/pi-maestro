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
import { type Plan, SUBAGENT_KINDS, type Task, validatePlan } from "./plan.js";
import type { PlanStore } from "./store.js";

const TaskSchema = Type.Object({
	id: Type.String({
		description: "Unique within its list. Lowercase, digits and hyphens.",
	}),
	title: Type.String({ description: "One line: what this step is." }),
	body: Type.Optional(
		Type.String({
			description:
				"What the agent needs to know that the title does not say. Facts and constraints, not encouragement.",
		}),
	),
	by: Type.Optional(
		Type.Object(
			{
				agent: Type.Union(SUBAGENT_KINDS.map((kind) => Type.Literal(kind))),
				persona: Type.String({
					description: "Which persona — what it should be looking for.",
				}),
			},
			{
				description:
					"Hand this step to a read-only agent instead of doing it. Research before the work, review after there is a diff.",
			},
		),
	),
});

const DeliverableSchema = Type.Object({
	id: Type.String({
		description:
			"Lowercase, digits and hyphens. It becomes a branch name and a directory.",
	}),
	title: Type.String(),
	body: Type.Optional(
		Type.String({ description: "What this deliverable is for." }),
	),
	after: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Deliverables that must SUCCEED before this starts. Ordering only.",
		}),
	),
	reads: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Predecessors whose hand-off this one actually needs. Must be a subset of `after` — you cannot read from work you did not wait for. Keep it small: everything here lands in this deliverable's context.",
		}),
	),
	repo: Type.Optional(Type.String({ description: "Which named repo." })),
	tasks: Type.Array(TaskSchema, {
		description: "The work, in order. A deliverable with none is not one.",
	}),
});

const PlanSchema = Type.Object({
	slug: Type.String({
		description: "Lowercase, digits and hyphens. Names the plan on disk.",
	}),
	title: Type.String(),
	deliverables: Type.Array(DeliverableSchema),
	preflight: Type.Optional(
		Type.Array(TaskSchema, {
			description:
				"What YOU do before any deliverable starts — a barrier every one of them waits on. Repos existing is the usual case.",
		}),
	),
	postflight: Type.Optional(
		Type.Array(TaskSchema, {
			description:
				"What YOU do once every deliverable has SHIPPED. Skipped entirely if any failed.",
		}),
	),
	repos: Type.Optional(
		Type.Array(
			Type.Object({
				key: Type.String(),
				path: Type.String(),
			}),
			{ description: "Defaults to this repository." },
		),
	),
});

/** Both outcomes report the same shape, so a caller needs no narrowing. */
interface PlanToolDetails {
	readonly stored: boolean;
	readonly errors: readonly string[];
	readonly slug: string;
	readonly deliverables: number;
}

export interface AuthoringDeps {
	readonly store: PlanStore;
	/** The repository the maestro is sitting in — the default for `repos`. */
	readonly cwd: () => string;
	/** Told after a plan is stored, so the seat can offer to run it. */
	readonly onStored?: (plan: Plan) => void;
}

/**
 * Write a plan.
 *
 * The failure path is the interesting one: a rejected plan comes back with
 * EVERY error, because an author fixing one error per round trip through five
 * round trips is an author that starts guessing.
 */
export function createPlanTool(deps: AuthoringDeps): ToolDefinition {
	return defineTool({
		name: "plan",
		label: "Plan",
		description:
			"Write the plan: deliverables in a dependency graph, each an ordered list of work. Send the WHOLE plan every time — to change one thing, send it again with that thing changed.",
		promptSnippet:
			"write the whole plan: deliverables in a graph, each an ordered list of work.",
		parameters: PlanSchema,
		async execute(_id, authored) {
			const plan: Plan = {
				slug: authored.slug,
				title: authored.title,
				preflight: (authored.preflight ?? []) as Task[],
				postflight: (authored.postflight ?? []) as Task[],
				repos: authored.repos ?? [{ key: "main", path: deps.cwd() }],
				deliverables: authored.deliverables.map((d) => ({
					id: d.id,
					title: d.title,
					...(d.body ? { body: d.body } : {}),
					after: d.after ?? [],
					reads: d.reads ?? [],
					...(d.repo ? { repo: d.repo } : {}),
					tasks: d.tasks as Task[],
				})),
			};

			const errors = validatePlan(plan);
			const details = (stored: boolean): PlanToolDetails => ({
				stored,
				errors,
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
			deps.onStored?.(plan);
			return {
				content: [{ type: "text" as const, text: describe(plan) }],
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
function describe(plan: Plan): string {
	const lines = [
		`Stored \`${plan.slug}\` — ${plan.title}.`,
		"",
		...plan.deliverables.map((d) => {
			const waits = d.after.length > 0 ? ` after ${d.after.join(", ")}` : "";
			const reads = d.reads.length > 0 ? ` reads ${d.reads.join(", ")}` : "";
			const toSubagents = d.tasks.filter((t) => t.by).length;
			const handed = toSubagents > 0 ? `, ${toSubagents} to subagents` : "";
			return `- ${d.id}: ${d.tasks.length} task${d.tasks.length === 1 ? "" : "s"}${handed}${waits}${reads}`;
		}),
	];
	if (plan.preflight.length > 0)
		lines.push(
			"",
			`Preflight: ${plan.preflight.length} step(s) before any of it.`,
		);
	if (plan.postflight.length > 0)
		lines.push(`Postflight: ${plan.postflight.length} step(s), if all ship.`);
	lines.push("", `Run it with \`/run ${plan.slug}\`.`);
	return lines.join("\n");
}
