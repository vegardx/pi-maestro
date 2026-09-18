// The v5 plan document: its shape, its field guidance, and the two pure
// functions that turn one into a `Plan`.
//
// SEPARATE FROM THE TOOL THAT ASKS FOR IT. What a plan looks like and how a
// model is asked for one are different questions with different lifetimes: the
// `plan` tool is one way of asking, a direct completion against the session's
// own model is another, and a schema that lived inside a tool registration
// could only ever be used by the first. Everything here is data and pure
// functions — nothing registers, nothing stores, nothing reaches a session —
// so a caller with a parsed JSON value can check it, clean it and build the
// stored document without a tool existing at all.
//
// THE GUIDANCE IS SHORT BECAUSE THE SHAPE IS RIGHT. Version 4's ran to four
// kilobytes across thirty-three field notes, most of them shouting — a task
// carries no `review`, a `lens` is never empty, omit `model`, omit `stages` —
// and four by-hand passes wrote every one of those fields anyway. Guidance
// that has to shout is a shape that is wrong: a document where absence carried
// the meaning, where reviews could be said in two places, and where the
// compiler's own dials were parameters of the authoring surface. Version 5
// says each of those things once, structurally. `test/authoring.test.ts` holds
// the total under a bound, so the notes cannot creep back.

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
	MAX_LENSES,
	type Plan,
	type PlanPolicy,
	REVIEW_TIERS,
	type Review,
	type Task,
} from "./plan.js";

const literals = <T extends string | number>(
	values: readonly T[],
	description: string,
) =>
	Type.Union(
		values.map((value) => Type.Literal(value)),
		{ description },
	);

const TaskSchema = Type.Object({
	id: Type.String({
		description: "Lowercase, digits and hyphens. Unique in this deliverable.",
	}),
	title: Type.String({ description: "One line: what this step is." }),
	body: Type.Optional(
		Type.String({
			description: "Facts and constraints the title does not carry.",
		}),
	),
});

const ReviewSchema = Type.Object({
	lens: Type.String({
		description:
			"What this reviewer reads for, such as `security`. A letter first, then letters, digits and hyphens.",
	}),
	tier: Type.Optional(
		literals(REVIEW_TIERS, "How much reviewer this lens is worth."),
	),
	diverse: Type.Optional(
		Type.Boolean({ description: "Ask for a different model family." }),
	),
	skill: Type.Optional(
		Type.String({ description: "A skill this session has loaded." }),
	),
	model: Type.Optional(
		Type.String({
			description: "A `provider/model` id this host has. Prefer `tier`.",
		}),
	),
});

const DeliverableSchema = Type.Object({
	id: Type.String({
		description: "Lowercase, digits and hyphens. It becomes a workflow id.",
	}),
	title: Type.String(),
	body: Type.Optional(
		Type.String({ description: "What this deliverable is for." }),
	),
	after: Type.Optional(
		Type.Array(Type.String(), {
			description: "Deliverables that must finish first. Ordering only.",
		}),
	),
	reads: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"The `after` entries whose hand-off this one reads. Each lands in its context.",
		}),
	),
	repo: Type.Optional(Type.String({ description: "Which named repo." })),
	tasks: Type.Array(TaskSchema, {
		minItems: 1,
		description: "The work, in order: what gets written.",
	}),
	reviews: Type.Optional(
		Type.Array(ReviewSchema, {
			maxItems: MAX_LENSES,
			description:
				"Who reads the work afterwards, one each. Leave it out for none.",
		}),
	),
});

const PlanSchema = Type.Object({
	slug: Type.String({
		description: "Lowercase, digits and hyphens. Names the plan on disk.",
	}),
	title: Type.String(),
	body: Type.Optional(Type.String({ description: "What the plan is for." })),
	deliverables: Type.Array(DeliverableSchema),
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

// ── Empty optional values, dropped at the boundary ───────────────────────────
//
// A model that has nothing to say about an optional field writes `""` for it,
// or `[""]`, far more often than it leaves the field out — and every one of
// those reached `inspectPlan` as a value and came back as an error by name. The
// first by-hand pass of this loop lost a whole `plan` call to ten of them:
// "`` is not a safe ambient skill name" five times over, and a delegated model
// that "must be a concrete provider/model ID" five more, for a document whose
// author had meant to say nothing at all.
//
// Refusing them was right and useless. An empty optional is not a claim about
// anything, so it is DROPPED here, before validation, and omitting a field and
// sending it empty mean the same thing. The rule is narrow on purpose:
//
//   - only OPTIONAL fields. A required empty string is still refused by name,
//     because an empty `id`, `slug`, `title` or `lens` IS a claim, and a silent
//     drop would turn it into a different error three steps later.
//   - an optional string whose `trim()` is empty goes; a surviving value is
//     passed through exactly as written, never rewritten.
//   - an optional string array loses its empty entries, and goes entirely when
//     nothing is left — `[""]` and `[]` both mean "nothing to say".
//
// The stored plan and its digest therefore never contain a dropped value: this
// runs on the authored document, before the `Plan` is built.

/**
 * The document as it arrives, before any of this is decided.
 *
 * Exported with its schema because the schema is the contract with whatever
 * asks the model for a plan — the `plan` tool today, and a direct completion
 * tomorrow. Both hand what comes back to `withoutEmptyOptionals`, then
 * `planFrom`, then `inspectPlan`, so there is one reading of one document.
 */
export type AuthoredPlan = Static<typeof PlanSchema>;

export { PlanSchema };

/** A trimmed-empty optional string is nothing. Anything else is itself. */
function keptText(value: string | undefined): string | undefined {
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/** An optional list without its empty entries, or nothing when none survive. */
function keptList(value: readonly string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const kept = value.filter((entry) => entry.trim().length > 0);
	return kept.length > 0 ? kept : undefined;
}

/**
 * The same object with its dropped keys actually gone.
 *
 * `{ body: undefined }` is not the same document as `{}` — it is a key whose
 * presence every later reader has to remember to test for — so the drop is a
 * delete rather than an assignment. The value stays exactly as authored.
 */
function pruned<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T;
}

type AuthoredDeliverable = AuthoredPlan["deliverables"][number];
type AuthoredReview = NonNullable<AuthoredDeliverable["reviews"]>[number];

/** One review's two host-checked pins, which are the two it may leave out. */
function withoutEmptyRouting(review: AuthoredReview): AuthoredReview {
	// `lens` is REQUIRED and is not touched here: an empty one is a claim this
	// document makes, and validation names it.
	return pruned({
		...review,
		skill: keptText(review.skill),
		model: keptText(review.model),
	});
}

/**
 * The authored document with every empty optional gone.
 *
 * Exported because this is a boundary rule, not an implementation detail: the
 * test that proves `skill: ""` stores cleanly, and that an empty `id` still
 * does not, asks this function the same question the tool asks it.
 */
export function withoutEmptyOptionals(authored: AuthoredPlan): AuthoredPlan {
	return pruned({
		...authored,
		body: keptText(authored.body),
		deliverables: authored.deliverables.map((deliverable) =>
			pruned({
				...deliverable,
				body: keptText(deliverable.body),
				after: keptList(deliverable.after),
				reads: keptList(deliverable.reads),
				repo: keptText(deliverable.repo),
				tasks: deliverable.tasks.map((task) =>
					pruned({ ...task, body: keptText(task.body) }),
				),
				reviews: deliverable.reviews?.map(withoutEmptyRouting),
			}),
		),
	});
}

/** What the seat supplies that the author does not. @see AuthoringDeps */
export interface PlanSurroundings {
	/** The repository the maestro is sitting in — the default for `repos`. */
	readonly cwd: string;
	/** The dials, from the exit that settled them. @see AuthoringDeps.policy */
	readonly policy?: PlanPolicy;
}

/**
 * The stored document an authored one becomes.
 *
 * Separate from the tool so that anything asking a model for a plan reaches the
 * same document: this fills in what the author is not asked for — the default
 * repository, and the policy a human already decided — and nothing else. It
 * does not validate; `inspectPlan` is still the one reader that says whether a
 * plan is any good.
 */
export function planFrom(
	authored: AuthoredPlan,
	surroundings: PlanSurroundings,
): Plan {
	return {
		slug: authored.slug,
		title: authored.title,
		...(authored.body ? { body: authored.body } : {}),
		repos: authored.repos ?? [{ key: "main", path: surroundings.cwd }],
		deliverables: authored.deliverables.map((d) => ({
			id: d.id,
			title: d.title,
			...(d.body ? { body: d.body } : {}),
			after: d.after ?? [],
			reads: d.reads ?? [],
			...(d.repo ? { repo: d.repo } : {}),
			tasks: d.tasks as Task[],
			...(d.reviews ? { reviews: d.reviews as Review[] } : {}),
		})),
		// Attached, never authored: the dials a human answered before this
		// document existed. @see AuthoringDeps.policy
		...(surroundings.policy ? { policy: surroundings.policy } : {}),
	};
}

/**
 * Everything the schema rejects about a parsed JSON value, as messages.
 *
 * For a caller that did not come through a tool: `defineTool` checks its own
 * arguments against `PlanSchema` before `execute` runs, and a model answering a
 * completion has nothing doing that for it. Reported whole, like every other
 * validator here, because a caller fixing one field per round trip is a caller
 * who starts guessing.
 */
export function authoredPlanProblems(value: unknown): string[] {
	if (Value.Check(PlanSchema, value)) return [];
	const problems: string[] = [];
	for (const error of Value.Errors(PlanSchema, value)) {
		const at =
			typeof error.path === "string" && error.path.length > 0
				? error.path
				: "the document";
		problems.push(`${at}: ${error.message}`);
		if (problems.length >= 16) break;
	}
	return problems.length > 0
		? problems
		: ["it is not a plan document this build can read"];
}

/**
 * What a model is told the `plan` document is, in one paragraph.
 *
 * The same sentences the `plan` tool carries as its description, said here so
 * that a caller asking for the document another way says the same thing. The
 * per-field guidance travels with the schema itself.
 */
export const PLAN_DOCUMENT_GUIDE =
	"Write the plan and store it. Deliverables form a dependency graph. Each one lists `tasks`, which are the work, and may list `reviews`, who read that work when it is done. Send the whole plan on every call: to change one thing, send it all again with that thing changed. Leave out any optional field you have nothing to say about; an empty string means the same and is dropped.";
