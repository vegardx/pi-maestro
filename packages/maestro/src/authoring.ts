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
import { type Static, Type } from "@sinclair/typebox";
import type { ModeName } from "./mode.js";
import { MAX_INTENT_LENGTH } from "./pending-exit.js";
import {
	ESCALATIONS,
	FIX_ROUNDS,
	inspectPlan,
	MAX_LENSES,
	PLAN_GATES,
	type Plan,
	type PlanHostPort,
	type PlanPolicy,
	PUBLISH_MODES,
	REVIEW_TIERS,
	type Stage,
	SYNTHESIS_MODES,
	type Task,
} from "./plan.js";
import { PLAN_WORKFLOW_REF } from "./plan-command.js";
import { DEFAULT_EFFORT, EFFORTS } from "./plan-input.js";
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
	review: Type.Optional(
		Type.Object(
			{
				lens: Type.String({
					description:
						"REQUIRED. The independent review focus, such as `security`. It is a workflow fan-out key, so it must match `^[a-z][a-z0-9-]{0,63}$`: a lowercase letter, then lowercase letters, digits and hyphens. Never empty.",
				}),
				skill: Type.Optional(
					Type.String({
						description:
							"An ambient discoverable skill to request explicitly, and only one this session has actually loaded — an unloaded skill is refused by name. Omit when the lens prompt is sufficient for discovery.",
					}),
				),
				model: Type.Optional(
					Type.String({
						description:
							"OPTIONAL, and only ever a concrete `provider/model` ID — a provider id, a slash, and a model id this host actually has; one it does not have is refused by name, with its providers listed. Prefer `tier` and leave this out: a pinned model only runs on a host that has it. Never a role, a size word or a placeholder.",
					}),
				),
				tier: Type.Optional(
					Type.Union(
						REVIEW_TIERS.map((tier) => Type.Literal(tier)),
						{
							description:
								"How much reviewer this lens is worth, for the host to resolve. Omit to let the run's effort dial decide.",
						},
					),
				),
				diverse: Type.Optional(
					Type.Boolean({
						description:
							"Ask for a reviewer from a different model family than the implementer.",
					}),
				),
			},
			{
				description:
					"PRESENT ⇒ THIS TASK IS A REVIEW, compiled into its own read-only workflow stage and seeding a lens. An implementation, test or docs task carries NO `review`; a review is a separate task whose only work is reviewing. Repeat a lens in another task to run it with another model.",
			},
		),
	),
});

const literals = <T extends string | number>(
	values: readonly T[],
	description: string,
) =>
	Type.Union(
		values.map((value) => Type.Literal(value)),
		{ description },
	);

const LensSchema = Type.Object({
	id: Type.String({
		description:
			"REQUIRED. The point of view, such as `security`. It is the fan-out key, so it must match `^[a-z][a-z0-9-]{0,63}$`. Never empty.",
	}),
	tier: Type.Optional(
		literals(
			REVIEW_TIERS,
			"How much reviewer this lens is worth. Omit to take the plan's `policy.reviewDefault`.",
		),
	),
	diverse: Type.Optional(
		Type.Boolean({
			description:
				"Ask for a reviewer from a different model family than the implementer.",
		}),
	),
	skill: Type.Optional(
		Type.String({
			description:
				"An ambient skill to request explicitly, and only one this session has loaded.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"OPTIONAL, and only ever a concrete `provider/model` ID this host has. Prefer `tier` and leave this out.",
		}),
	),
});

/**
 * The stage kinds a model may author.
 *
 * `dynamic` is deliberately absent: it is reserved in the plan schema and
 * refused by validation until something compiles it, and offering a kind whose
 * only possible outcome is a refusal would spend a turn to learn that.
 */
const StageSchema = Type.Union(
	[
		Type.Object({
			use: Type.Literal("implement"),
			id: Type.String({
				description:
					"Unique in this deliverable. Becomes a workflow namespace.",
			}),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Tool NAMES the implementer needs. Never a path or a command.",
				}),
			),
		}),
		Type.Object({
			use: Type.Literal("verify-and-fix"),
			id: Type.String(),
			maxRounds: Type.Optional(
				literals(
					FIX_ROUNDS,
					"How many fix rounds the check may drive. Omit to take the plan's `policy.maxFixRounds`.",
				),
			),
			escalate: Type.Optional(
				literals(
					ESCALATIONS,
					"What a later round may spend more of when an earlier one failed.",
				),
			),
		}),
		Type.Object({
			use: Type.Literal("review-fan-out"),
			id: Type.String(),
			lenses: Type.Array(LensSchema, {
				minItems: 1,
				maxItems: MAX_LENSES,
				description:
					"Independent points of view over this deliverable's hand-off, run in parallel. The same lens twice runs it twice.",
			}),
			synthesis: Type.Optional(
				literals(
					SYNTHESIS_MODES,
					"Whether the verdicts are reduced into one statement. Default optional.",
				),
			),
		}),
		Type.Object({
			use: Type.Literal("gate"),
			id: Type.String(),
			question: Type.String({
				description:
					"What a human is being asked. Prose — never code or a path.",
			}),
			show: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Ids of stages declared EARLIER in this deliverable whose results the decision is shown.",
				}),
			),
		}),
	],
	{
		description:
			"One compiled stage. `use` names the kind; the other fields are that kind's own.",
	},
);

const PolicySchema = Type.Object(
	{
		effort: Type.Optional(
			literals(
				EFFORTS,
				`How much budget the run may spend. Default ${DEFAULT_EFFORT}.`,
			),
		),
		gates: Type.Optional(
			literals(
				PLAN_GATES,
				"Where the run stops for a human. Default approve-plan+ship.",
			),
		),
		reviewDefault: Type.Optional(
			Type.Object(
				{
					tier: Type.Optional(literals(REVIEW_TIERS, "Default review tier.")),
					diverse: Type.Optional(Type.Boolean()),
				},
				{ description: "What a review that pins nothing is worth." },
			),
		),
		maxFixRounds: Type.Optional(
			literals(
				FIX_ROUNDS,
				"Fix rounds a `verify-and-fix` stage takes when it does not say. Default 0 cheap / 1 standard / 2 deep.",
			),
		),
		publish: Type.Optional(
			Type.Object(
				{
					mode: literals(
						PUBLISH_MODES,
						"What happens to the hand-offs once a human said ship.",
					),
					base: Type.Optional(
						Type.String({ description: "The branch publication starts from." }),
					),
				},
				{ description: 'Default `{ mode: "none" }`.' },
			),
		),
	},
	{
		description:
			"The dials this plan sets for its own run. On the plan, so a reviewer sees them and the digest covers them.",
	},
);

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
		description:
			"The work, in order. A deliverable with none is not one. The tasks that DO the work — implementation, tests, docs — carry no `review`; only a task whose only work is reviewing does.",
	}),
	stages: Type.Optional(
		Type.Array(StageSchema, {
			description:
				"How this deliverable is compiled, in order. OMIT IT unless the default is wrong: implement, verify-and-fix, then one review lens per task with `review`. Exactly one `implement`; `verify-and-fix` follows it; a `gate` is last.",
		}),
	),
});

const PlanSchema = Type.Object({
	slug: Type.String({
		description: "Lowercase, digits and hyphens. Names the plan on disk.",
	}),
	title: Type.String(),
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
	policy: Type.Optional(PolicySchema),
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
//     because an empty `id`, `slug`, `title`, `lens` or `question` IS a claim,
//     and a silent drop would turn it into a different error three steps later.
//   - an optional string whose `trim()` is empty goes; a surviving value is
//     passed through exactly as written, never rewritten.
//   - an optional string array loses its empty entries, and goes entirely when
//     nothing is left — `[""]` and `[]` both mean "nothing to say".
//
// The stored plan and its digest therefore never contain a dropped value: this
// runs on the authored document, before the `Plan` is built.

/** The document as the tool receives it, before any of this is decided. */
type AuthoredPlan = Static<typeof PlanSchema>;

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
type AuthoredTask = AuthoredDeliverable["tasks"][number];
type AuthoredStage = NonNullable<AuthoredDeliverable["stages"]>[number];
type AuthoredRouting = NonNullable<AuthoredTask["review"]>;

/** `review`, and the fan-out lenses that share its optional fields. */
function withoutEmptyRouting<
	T extends Pick<AuthoredRouting, "skill" | "model">,
>(routing: T): T {
	// `lens` and a lens's `id` are REQUIRED and are not touched here: an empty
	// one is a claim this document makes, and validation names it.
	return pruned({
		...routing,
		skill: keptText(routing.skill),
		model: keptText(routing.model),
	});
}

function withoutEmptyStage(stage: AuthoredStage): AuthoredStage {
	if (stage.use === "implement")
		return pruned({ ...stage, tools: keptList(stage.tools) });
	if (stage.use === "gate")
		return pruned({ ...stage, show: keptList(stage.show) });
	if (stage.use === "review-fan-out")
		return { ...stage, lenses: stage.lenses.map(withoutEmptyRouting) };
	return stage;
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
		deliverables: authored.deliverables.map((deliverable) =>
			pruned({
				...deliverable,
				body: keptText(deliverable.body),
				after: keptList(deliverable.after),
				reads: keptList(deliverable.reads),
				repo: keptText(deliverable.repo),
				tasks: deliverable.tasks.map((task) =>
					pruned({
						...task,
						body: keptText(task.body),
						review:
							task.review === undefined
								? undefined
								: withoutEmptyRouting(task.review),
					}),
				),
				stages: deliverable.stages?.map(withoutEmptyStage),
			}),
		),
		policy:
			authored.policy === undefined
				? undefined
				: pruned({
						...authored.policy,
						publish:
							authored.policy.publish === undefined
								? undefined
								: pruned({
										...authored.policy.publish,
										base: keptText(authored.policy.publish.base),
									}),
					}),
	});
}

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
			'Write the plan: deliverables in a dependency graph, each an ordered list of work. Send the WHOLE plan every time — to change one thing, send it again with that thing changed. `review` marks a REVIEW task: an implementation, test or docs task carries no `review`, and a review is a separate task whose only work is reviewing. Two fields are got wrong most often: a review task\'s `review.lens` is REQUIRED and must match `^[a-z][a-z0-9-]{0,63}$`, and `review.model` is OPTIONAL and only ever a concrete `provider/model` ID this host has — prefer `review.tier` and omit `review.model`. An optional field left empty (`""`, or a list of them) is dropped before validation rather than refused, so omitting a field and sending it empty mean the same thing.',
		promptSnippet:
			"write the whole plan: deliverables in a graph, each an ordered list of work.",
		parameters: PlanSchema,
		async execute(_id, submitted) {
			// Before anything reads the document: an optional field left empty is
			// not a claim, so it is dropped rather than refused. Required fields
			// are untouched, and an empty one is still refused by name below.
			const authored = withoutEmptyOptionals(submitted);
			const plan: Plan = {
				slug: authored.slug,
				title: authored.title,
				repos: authored.repos ?? [{ key: "main", path: deps.cwd() }],
				deliverables: authored.deliverables.map((d) => ({
					id: d.id,
					title: d.title,
					...(d.body ? { body: d.body } : {}),
					after: d.after ?? [],
					reads: d.reads ?? [],
					...(d.repo ? { repo: d.repo } : {}),
					tasks: d.tasks as Task[],
					...(d.stages ? { stages: d.stages as Stage[] } : {}),
				})),
				...(authored.policy ? { policy: authored.policy as PlanPolicy } : {}),
			};

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
			const reviews = d.tasks.filter((t) => t.review).length;
			const handed = reviews > 0 ? `, ${reviews} review task(s)` : "";
			// Said only when the author wrote them: a stage list echoed back as the
			// default would read like the plan declared one.
			const stages = d.stages
				? `, stages ${d.stages.map((stage) => stage.id).join(" → ")}`
				: "";
			return `- ${d.id}: ${d.tasks.length} task${d.tasks.length === 1 ? "" : "s"}${handed}${waits}${reads}${stages}`;
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
