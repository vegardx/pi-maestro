// The compiled stage document: the graph a plan becomes, derived here.
//
// **Why pi-maestro derives it.** The blind reviewer (`plan-review`) is shown
// the graph rather than prose about it, and the exit flow shows a human the
// same graph before anything runs. Both need it BEFORE a run exists, and
// pi-maestro cannot import `@vegardx/pi-workflow` — it is an optional peer and
// is not published — so the document is compiled on this side from the same
// §2.1 rules `plan-to-ship` compiles from: the default stage list derived from
// the policy, review lenses seeded from `tasks[].by`, duplicate lens ids
// suffixed by declaration ordinal, and `maxRounds` mapped from the plan's fix
// rounds to the component's verify rounds. Two derivations of one document is
// exactly the duplication this repository is organised against, so it is
// bounded the same way `workflow-contract.ts` is:
//
//   1. The **shape** is checked against a local TypeBox mirror of
//      pi-workflow's own `CompiledStageDocumentSchema`, which is closed
//      (`additionalProperties: false`) at every level. A field this compiler
//      invents, or one pi-workflow renames, fails here rather than at
//      `workflow_validate` inside a dialog sequence.
//   2. The **content** is pinned by `test/stage-document.test.ts`, which
//      compiles the spec's own §2.1 example and compares it to the expected
//      JSON written out by hand.
//   3. The by-hand end-to-end pass compares this document with the one
//      `plan-to-ship` derives from the same plan. They are two readings of one
//      specification, and the run is where they must agree.
//
// Nothing here asks anything or touches disk: a compiler that needed a UI
// could not be tested, and one that needed a runtime would defeat the point.

import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	type Deliverable,
	type Plan,
	type PlanGates,
	type ReviewLens,
	type ReviewTier,
	type Stage,
	withDefaultStages,
} from "./plan.js";
import type { Effort } from "./plan-input.js";

// ── The mirror ───────────────────────────────────────────────────────────────
//
// A copy of `@vegardx/pi-workflow/components`' `CompiledStageDocumentSchema`,
// field for field and bound for bound. Kept in the same order as the original
// so the two can be read side by side.

/** A stage id, a deliverable id: both become workflow namespaces. */
export const COMPILED_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
/** A lens id, which is a fan-out key and may carry a `-2` suffix. */
export const COMPILED_LENS_ID_PATTERN = "^[a-z][a-z0-9-]*$";
/** `plan-to-ship`'s own deliverable bound, repeated as the document's. */
export const MAX_COMPILED_DELIVERABLES = 16;
/** One implement, one verify, one review, a gate — with room to spare. */
export const MAX_COMPILED_STAGES = 8;
/** `reviewFanOut`'s bound, so a compiled fan-out cannot describe an illegal one. */
export const MAX_COMPILED_LENSES = 16;
/** The component counts VERIFY rounds and admits at most this many. */
export const MAX_VERIFY_ROUNDS = 3;

const CompiledStageIdSchema = Type.String({ pattern: COMPILED_ID_PATTERN });

const CompiledImplementStageSchema = Type.Object(
	{
		use: Type.Literal("implement"),
		id: CompiledStageIdSchema,
		tools: Type.Optional(
			Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }), {
				maxItems: 32,
			}),
		),
	},
	{ additionalProperties: false },
);

const CompiledVerifyAndFixStageSchema = Type.Object(
	{
		use: Type.Literal("verify-and-fix"),
		id: CompiledStageIdSchema,
		/** VERIFY rounds, REQUIRED: the plan's fix rounds plus one. */
		maxRounds: Type.Integer({ minimum: 0, maximum: MAX_VERIFY_ROUNDS }),
		escalate: Type.Optional(
			Type.Unsafe<CompiledEscalation>({
				type: "string",
				pattern: "^(thinking|none)$",
			}),
		),
	},
	{ additionalProperties: false },
);

const CompiledLensSchema = Type.Object(
	{
		id: Type.String({ pattern: COMPILED_LENS_ID_PATTERN, maxLength: 128 }),
		tier: Type.Optional(
			Type.Unsafe<ReviewTier>({
				type: "string",
				pattern: "^(light|standard|heavy)$",
			}),
		),
		diverse: Type.Optional(Type.Boolean()),
		skill: Type.Optional(Type.String({ pattern: COMPILED_ID_PATTERN })),
		/** `provider/model`, as pi-maestro writes it; an exact pin. */
		model: Type.Optional(Type.String({ pattern: "^\\S+/\\S+$" })),
	},
	{ additionalProperties: false },
);

const CompiledReviewFanOutStageSchema = Type.Object(
	{
		use: Type.Literal("review-fan-out"),
		id: CompiledStageIdSchema,
		lenses: Type.Array(CompiledLensSchema, { maxItems: MAX_COMPILED_LENSES }),
		synthesis: Type.Optional(
			Type.Unsafe<CompiledSynthesis>({
				type: "string",
				pattern: "^(required|optional|none)$",
			}),
		),
	},
	{ additionalProperties: false },
);

const CompiledGateStageSchema = Type.Object(
	{
		use: Type.Literal("gate"),
		id: CompiledStageIdSchema,
		question: Type.String({ minLength: 1, maxLength: 1024 }),
		show: Type.Optional(Type.Array(CompiledStageIdSchema, { maxItems: 8 })),
	},
	{ additionalProperties: false },
);

const CompiledDeliverableSchema = Type.Object(
	{
		/** The PLAN's deliverable id, so the two documents line up by key. */
		id: CompiledStageIdSchema,
		stages: Type.Array(
			Type.Union([
				CompiledImplementStageSchema,
				CompiledVerifyAndFixStageSchema,
				CompiledReviewFanOutStageSchema,
				CompiledGateStageSchema,
			]),
			{ maxItems: MAX_COMPILED_STAGES },
		),
	},
	{ additionalProperties: false },
);

export const CompiledStageDocumentMirror = Type.Object(
	{
		deliverables: Type.Array(CompiledDeliverableSchema, {
			minItems: 1,
			maxItems: MAX_COMPILED_DELIVERABLES,
		}),
		/** The resolved effort — `policy.effort` with its default applied. */
		effort: Type.Union([
			Type.Literal("cheap"),
			Type.Literal("standard"),
			Type.Literal("deep"),
		]),
		/** The resolved gates — `policy.gates` with its default applied. */
		gates: Type.Union([
			Type.Literal("approve-plan"),
			Type.Literal("approve-plan+ship"),
			Type.Literal("every-deliverable"),
		]),
	},
	{ additionalProperties: false },
);

// ── The document, in TypeScript ──────────────────────────────────────────────

export type CompiledEscalation = "thinking" | "none";
export type CompiledSynthesis = "required" | "optional" | "none";

export interface CompiledLens {
	readonly id: string;
	readonly tier?: ReviewTier;
	readonly diverse?: boolean;
	readonly skill?: string;
	readonly model?: string;
}

export type CompiledStage =
	| {
			readonly use: "implement";
			readonly id: string;
			readonly tools?: readonly string[];
	  }
	| {
			readonly use: "verify-and-fix";
			readonly id: string;
			readonly maxRounds: number;
			readonly escalate?: CompiledEscalation;
	  }
	| {
			readonly use: "review-fan-out";
			readonly id: string;
			readonly lenses: readonly CompiledLens[];
			readonly synthesis?: CompiledSynthesis;
	  }
	| {
			readonly use: "gate";
			readonly id: string;
			readonly question: string;
			readonly show?: readonly string[];
	  };

export interface CompiledDeliverable {
	readonly id: string;
	readonly stages: readonly CompiledStage[];
}

export interface CompiledStageDocument {
	readonly deliverables: readonly CompiledDeliverable[];
	readonly effort: Effort;
	readonly gates: PlanGates;
}

/** A document this seat refuses to compile, show, or send to a reviewer. */
export class StageDocumentError extends Error {
	constructor(readonly problems: readonly string[]) {
		super(
			`the plan does not compile to a stage document:\n${problems
				.map((problem) => `  - ${problem}`)
				.join("\n")}`,
		);
		this.name = "StageDocumentError";
	}
}

/**
 * Everything the mirror rejects about a value, as messages.
 *
 * Reported whole, like every other validator here: a caller fixing one field
 * per round trip through an editor dialog is a caller who gives up.
 */
export function validateStageDocument(value: unknown): string[] {
	if (Value.Check(CompiledStageDocumentMirror, value)) return [];
	const problems: string[] = [];
	try {
		for (const error of Value.Errors(CompiledStageDocumentMirror, value)) {
			const at =
				typeof error.instancePath === "string" && error.instancePath.length > 0
					? error.instancePath
					: "the document";
			problems.push(`${at}: ${error.message}`);
			if (problems.length >= 16) break;
		}
	} catch {
		// A validator that cannot explain itself still said no, and the caller
		// needs a message rather than an exception inside a dialog sequence.
	}
	if (problems.length === 0)
		problems.push(
			"it is not a compiled stage document this seat and the runtime agree on",
		);
	return problems;
}

/** True when `value` is a document both sides would accept. */
export function isStageDocument(
	value: unknown,
): value is CompiledStageDocument {
	return Value.Check(CompiledStageDocumentMirror, value);
}

// ── Compiling ────────────────────────────────────────────────────────────────

/**
 * Duplicate lens ids, suffixed by DECLARATION ORDINAL.
 *
 * The same lens named twice is not an error — it is how one point of view runs
 * under two models — so the second becomes `<id>-2` and the third `<id>-3`.
 * The ordinal is the position in the authored array, never a counter over
 * runtime data: a counter would make the same plan compile to two different
 * graphs on two runs, and the digest a human approved would name neither.
 */
export function disambiguateLensIds(
	lenses: readonly ReviewLens[],
): readonly ReviewLens[] {
	const seen = new Map<string, number>();
	return lenses.map((lens) => {
		const before = seen.get(lens.id) ?? 0;
		seen.set(lens.id, before + 1);
		if (before === 0) return lens;
		const suffix = `-${before + 1}`;
		return { ...lens, id: `${lens.id.slice(0, 128 - suffix.length)}${suffix}` };
	});
}

function compileLens(lens: ReviewLens): CompiledLens {
	return {
		id: lens.id,
		...(lens.tier ? { tier: lens.tier } : {}),
		...(lens.diverse === undefined ? {} : { diverse: lens.diverse }),
		...(lens.skill ? { skill: lens.skill } : {}),
		...(lens.model ? { model: lens.model } : {}),
	};
}

/**
 * The plan's fix rounds as the component's verify rounds.
 *
 * `verifyAndFix` counts VERIFY rounds and a plan counts FIX rounds, so the
 * mapping is `+1` and a fix is never left unchecked: zero fix rounds still
 * verifies once, which is the difference between "no fixing" and "no checking".
 */
export function verifyRoundsFor(fixRounds: number): number {
	return fixRounds + 1;
}

function compileStage(
	stage: Stage,
	fixRounds: number,
	where: string,
	problems: string[],
): CompiledStage | undefined {
	switch (stage.use) {
		case "implement":
			return {
				use: "implement",
				id: stage.id,
				...(stage.tools ? { tools: [...stage.tools] } : {}),
			};
		case "verify-and-fix":
			return {
				use: "verify-and-fix",
				id: stage.id,
				maxRounds: verifyRoundsFor(stage.maxRounds ?? fixRounds),
				...(stage.escalate ? { escalate: stage.escalate } : {}),
			};
		case "review-fan-out":
			return {
				use: "review-fan-out",
				id: stage.id,
				lenses: disambiguateLensIds(stage.lenses).map(compileLens),
				...(stage.synthesis ? { synthesis: stage.synthesis } : {}),
			};
		case "gate":
			return {
				use: "gate",
				id: stage.id,
				question: stage.question,
				...(stage.show ? { show: [...stage.show] } : {}),
			};
		default:
			// The plan vocabulary reserves `dynamic` so a document can be written
			// against it; nothing compiles one, here or in the runtime, and a
			// compiled document has no place to put it.
			problems.push(
				`${where}: \`${(stage as { use: string }).use}\` stages are not compiled yet`,
			);
			return undefined;
	}
}

/**
 * The graph this plan becomes.
 *
 * @throws StageDocumentError when the plan cannot be lowered, or when the
 * document that comes out is not one the runtime's own schema would accept.
 */
export function compileStageDocument(plan: Plan): CompiledStageDocument {
	const staged = withDefaultStages(plan);
	const problems: string[] = [];
	const deliverables: CompiledDeliverable[] = [];
	for (const deliverable of staged.deliverables) {
		const stages: CompiledStage[] = [];
		for (const stage of deliverable.stages) {
			const compiled = compileStage(
				stage,
				staged.policy.maxFixRounds,
				`deliverable \`${deliverable.id}\` stage \`${stage.id}\``,
				problems,
			);
			if (compiled) stages.push(compiled);
		}
		deliverables.push({ id: deliverable.id, stages });
	}
	if (problems.length > 0) throw new StageDocumentError(problems);
	const document: CompiledStageDocument = {
		deliverables,
		effort: staged.policy.effort,
		gates: staged.policy.gates,
	};
	// The mirror is the last word. A plan that validates here and compiles to
	// something the runtime's closed schema rejects is drift between two
	// readings of §2.1, and this is the place it is cheap to see.
	const invalid = validateStageDocument(document);
	if (invalid.length > 0) throw new StageDocumentError(invalid);
	return document;
}

// ── Back into the plan ───────────────────────────────────────────────────────

/**
 * An edited compiled document, written back into the plan's `stages`.
 *
 * The exit flow lets a human edit the compiled graph, and what they edited has
 * to end up on the document the run is given — otherwise the next compile
 * throws their edit away and nothing says so. The mapping is the compile in
 * reverse, including `maxRounds`: the component's verify rounds become the
 * plan's fix rounds again.
 *
 * Returns the problems rather than throwing, because the caller shows them and
 * re-opens the editor.
 */
export function planWithStageDocument(
	plan: Plan,
	document: unknown,
): { readonly plan?: Plan; readonly problems: readonly string[] } {
	const problems = validateStageDocument(document);
	if (problems.length > 0) return { problems };
	const compiled = document as CompiledStageDocument;
	const byId = new Map(compiled.deliverables.map((d) => [d.id, d]));
	const unknownIds = compiled.deliverables
		.map((d) => d.id)
		.filter((id) => !plan.deliverables.some((d) => d.id === id));
	if (unknownIds.length > 0)
		return {
			problems: unknownIds.map(
				(id) =>
					`\`${id}\` is not a deliverable of this plan — the compiled document names the plan's own ids`,
			),
		};
	if (byId.size !== plan.deliverables.length)
		return {
			problems: [
				`the compiled document describes ${byId.size} deliverables and the plan has ${plan.deliverables.length}; every deliverable is compiled`,
			],
		};
	const back: string[] = [];
	const deliverables = plan.deliverables.map((deliverable) => {
		const compiledDeliverable = byId.get(deliverable.id);
		if (!compiledDeliverable) return deliverable;
		const stages = compiledDeliverable.stages.map((stage) =>
			planStage(stage, `deliverable \`${deliverable.id}\``, back),
		);
		return { ...deliverable, stages } satisfies Deliverable;
	});
	if (back.length > 0) return { problems: back };
	return { plan: { ...plan, deliverables }, problems: [] };
}

function planStage(
	stage: CompiledStage,
	where: string,
	problems: string[],
): Stage {
	switch (stage.use) {
		case "verify-and-fix": {
			// Zero verify rounds is a stage that never checks its own work. The
			// plan vocabulary cannot say it (fix rounds would have to be -1) and
			// the seat will not invent a rounding that quietly adds a round.
			if (stage.maxRounds < 1)
				problems.push(
					`${where} stage \`${stage.id}\`: \`maxRounds\` counts verify rounds and must be at least 1 — a fix is never left unchecked`,
				);
			const fixRounds = Math.max(0, Math.min(2, stage.maxRounds - 1)) as
				| 0
				| 1
				| 2;
			if (stage.maxRounds - 1 > 2)
				problems.push(
					`${where} stage \`${stage.id}\`: \`maxRounds\` ${stage.maxRounds} is more fixing than a plan may ask for`,
				);
			return {
				use: "verify-and-fix",
				id: stage.id,
				maxRounds: fixRounds,
				...(stage.escalate ? { escalate: stage.escalate } : {}),
			};
		}
		case "review-fan-out":
			return {
				use: "review-fan-out",
				id: stage.id,
				lenses: stage.lenses.map((lens) => ({ ...lens })),
				...(stage.synthesis ? { synthesis: stage.synthesis } : {}),
			};
		case "gate":
			return {
				use: "gate",
				id: stage.id,
				question: stage.question,
				...(stage.show ? { show: [...stage.show] } : {}),
			};
		default:
			return {
				use: "implement",
				id: stage.id,
				...(stage.tools ? { tools: [...stage.tools] } : {}),
			};
	}
}

// ── Showing it ───────────────────────────────────────────────────────────────

/** The document as a human reads it before deciding what to do with it. */
export function renderStageDocument(document: CompiledStageDocument): string {
	const lines = [
		`Compiled run — effort ${document.effort}, gates ${document.gates}.`,
	];
	for (const deliverable of document.deliverables) {
		lines.push(`  ${deliverable.id}`);
		for (const stage of deliverable.stages) {
			switch (stage.use) {
				case "implement":
					lines.push(
						`    implement ${stage.id}${stage.tools ? ` [${stage.tools.join(", ")}]` : ""}`,
					);
					break;
				case "verify-and-fix":
					lines.push(
						`    verify-and-fix ${stage.id} — ${stage.maxRounds} verify round${stage.maxRounds === 1 ? "" : "s"}${stage.escalate ? `, escalate ${stage.escalate}` : ""}`,
					);
					break;
				case "review-fan-out":
					lines.push(
						`    review-fan-out ${stage.id} — ${
							stage.lenses.length === 0
								? "no lenses"
								: stage.lenses
										.map(
											(lens) =>
												`${lens.id}${lens.tier ? `/${lens.tier}` : ""}${lens.diverse ? "/diverse" : ""}`,
										)
										.join(", ")
						}${stage.synthesis ? ` (synthesis ${stage.synthesis})` : ""}`,
					);
					break;
				default:
					lines.push(`    gate ${stage.id} — ${stage.question}`);
			}
		}
	}
	return lines.join("\n");
}
