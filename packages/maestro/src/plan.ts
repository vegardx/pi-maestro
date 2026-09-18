// The plan: what was authored, and nothing else.
//
// The old model put authored intent and run state in one object — a node
// carried its title and tasks alongside its status, session path, worktree,
// PR number and resolution history. That conflation is why it needed rules
// about which fields could be edited after a run started, and why "is this
// plan valid" was never a question you could answer from the plan alone.
//
// Here the plan is only what a human and the maestro agreed to build. What
// happened when it ran is a separate record, keyed by the same ids. They may
// well be persisted in the same file; they are not the same type.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_EFFORT, EFFORTS, type Effort } from "./plan-input.js";

/**
 * The revision of the stored plan document. Re-exported by `store.ts`, which
 * writes it into the envelope and refuses anything else.
 *
 * IT LIVES HERE, WITH THE SHAPE IT VERSIONS. A version defined next to the
 * envelope writer is a version that says nothing about what changed; a
 * document whose own module names its revision can refuse the previous one by
 * name — which is what version 6 does.
 *
 * Version 3 removed preflight/postflight and repository-creation intent.
 * Version 4 renamed `tasks[].by` to `tasks[].review`. Version 5 took reviews
 * off the task altogether — a task is work, and a deliverable lists its reviews
 * once in `reviews` — and dropped authored `stages`, which the run derives.
 * Version 6 left the document alone and added a required envelope field,
 * `authoredBy`: the session id and cwd of whoever wrote the plan. It is a
 * revision of the stored file, so it is this number that moves — a file the
 * store cannot say the author of is not a file this build reads.
 * Nothing before the current version is readable, and nothing tries to be:
 * there is no migration path here on purpose.
 */
export const MAESTRO_SCHEMA_VERSION = 6 as const;

/** An existing Git working-tree root the plan works in. */
export interface PlanRepo {
	readonly key: string;
	readonly path: string;
}

/**
 * What a probe found at a repository path. `root` is the working-tree root
 * that contains the path, resolved the same way as `resolved`, so "is this
 * path the root" is a string comparison the model layer can make without
 * touching a filesystem.
 */
export interface RepoState {
	/** The containing working-tree root, or null when there is no Git tree. */
	readonly root: string | null;
	/** The probed path itself, resolved. */
	readonly resolved: string;
	/** Tracked changes or untracked files present. */
	readonly dirty: boolean;
}

/** Answers "what is at this path" for validation. Injected so tests are pure. */
export type RepoProbe = (path: string) => RepoState;

function realpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A path that does not exist still has to compare as something; the
		// `root === null` branch is what reports it, not this.
		return resolve(path);
	}
}

/** The real one: `git rev-parse --show-toplevel`, plus a porcelain status. */
export const gitRepoProbe: RepoProbe = (path) => {
	const resolved = realpath(path);
	const git = (args: string[]): string | null => {
		try {
			return execFileSync("git", args, {
				cwd: path,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			// Not a repository, not a directory, or no git at all — the caller
			// cannot act differently on any of those, so they are one answer.
			return null;
		}
	};
	const top = git(["rev-parse", "--show-toplevel"]);
	if (top === null) return { root: null, resolved, dirty: false };
	const status = git(["status", "--porcelain"]);
	return {
		root: realpath(top.trim()),
		resolved,
		dirty: status !== null && status.trim().length > 0,
	};
};

/**
 * What a deliverable id may look like.
 *
 * Narrow because it becomes a workflow stage identifier.
 */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * What a review lens id may look like: `ID_RE`, minus the leading digit.
 *
 * Narrower than a deliverable id for a reason that lives in another package. A
 * lens id is a fan-out key, it reaches `@vegardx/pi-workflow` inside the
 * compiled stage document, and that document's schema accepts
 * `^[a-z][a-z0-9-]*$` — so a lens named `2fa` is a plan that validates here and
 * cannot be compiled anywhere. Refusing it while the plan is being written is
 * the whole point of validating the plan.
 */
export const LENS_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * One independent reading of a deliverable's work, and how it is routed.
 *
 * A REVIEW IS NOT A TASK. Version 3 called this `tasks[].by`, version 4 renamed
 * it `tasks[].review`, and in four by-hand runs the model wrote it onto the
 * implementation, test and docs tasks as well — the document encoded "this is
 * work" as the absence of a field, and absence is the one thing a model writing
 * every field will not produce. Here a task is always work and a deliverable
 * lists its reviews beside them, so there is nothing to leave out.
 */
export interface Review {
	/** The independent point of view this reviewer applies. */
	readonly lens: string;
	/** Optional ambient skill to request explicitly in the stage prompt. */
	readonly skill?: string;
	/**
	 * One concrete launch, pinned. Optional: a plan that names a literal
	 * `provider/model` is a plan that only runs on the host that has it. Repeat
	 * the lens to read the same work under another model.
	 */
	readonly model?: string;
	/** How much reviewer to spend, when the plan does not pin one. */
	readonly tier?: ReviewTier;
	/** Ask for a reviewer from a different model family than the implementer. */
	readonly diverse?: boolean;
}

/** How much reviewer a lens is worth, in the vocabulary a host can route. */
export const REVIEW_TIERS = ["light", "standard", "heavy"] as const;

export type ReviewTier = (typeof REVIEW_TIERS)[number];

/** Work. All of it: implementation, tests, docs. There is no other kind. */
export interface Task {
	readonly id: string;
	readonly title: string;
	readonly body?: string;
}

/**
 * The kinds of stage a deliverable is lowered into.
 *
 * DERIVED, NEVER AUTHORED. `defaultStagesFor` is the only thing that builds
 * one; version 5 removed `deliverables[].stages` from the document, so this
 * vocabulary is the compiler's own intermediate between a plan and the
 * compiled stage document the runtime reads.
 */
export const STAGE_KINDS = [
	"implement",
	"verify-and-fix",
	"review-fan-out",
] as const;

export type StageKind = (typeof STAGE_KINDS)[number];

/** How many fix rounds a `verify-and-fix` stage may take. Bounded on purpose. */
export const FIX_ROUNDS = [0, 1, 2] as const;

export type FixRounds = (typeof FIX_ROUNDS)[number];

/** Whether a fan-out's verdicts get reduced into one statement. */
export const SYNTHESIS_MODES = ["required", "optional", "none"] as const;

export type SynthesisMode = (typeof SYNTHESIS_MODES)[number];

/** What a fix round may spend more of when the round before it failed. */
export const ESCALATIONS = ["thinking", "none"] as const;

export type Escalation = (typeof ESCALATIONS)[number];

/**
 * One point of view in a `review-fan-out`. `id` is the fan-out key, so it is
 * `LENS_ID_RE`; a lens named twice is not an error — the
 * compiler suffixes duplicates `-2`, `-3` by declaration ordinal, which is
 * how the same lens runs twice under two models.
 */
export interface ReviewLens {
	readonly id: string;
	readonly tier?: ReviewTier;
	readonly diverse?: boolean;
	readonly skill?: string;
	readonly model?: string;
}

/** At most this many reviews on one deliverable. The component refuses more. */
export const MAX_LENSES = 16;

/** The deliverable's own work: one worktree, one hand-off. Exactly one. */
export interface ImplementStage {
	readonly use: "implement";
	readonly id: string;
	/** Tool names, never a path and never a command line. */
	readonly tools?: readonly string[];
}

/** Run the check, fix what it says, bounded. Never an open loop. */
export interface VerifyAndFixStage {
	readonly use: "verify-and-fix";
	readonly id: string;
	readonly maxRounds?: FixRounds;
	readonly escalate?: Escalation;
}

/** Independent points of view over the same subject, in parallel. */
export interface ReviewFanOutStage {
	readonly use: "review-fan-out";
	readonly id: string;
	readonly lenses: readonly ReviewLens[];
	readonly synthesis?: SynthesisMode;
}

export type Stage = ImplementStage | VerifyAndFixStage | ReviewFanOutStage;

export interface Deliverable {
	readonly id: string;
	readonly title: string;
	readonly body?: string;
	/**
	 * Deliverables that must be terminal before this one starts. ORDERING ONLY —
	 * waiting for something is not the same as reading it, and conflating them
	 * makes every dependency pay for its predecessor's full handoff in context.
	 */
	readonly after: readonly string[];
	/**
	 * Predecessors whose hand-off this one actually reads. Must be a subset of
	 * `after`: you cannot read from work you did not wait for.
	 */
	readonly reads: readonly string[];
	/** Which named repo. Absent = the plan's first. */
	readonly repo?: string;
	/** The work, in order. A deliverable with none is not a deliverable. */
	readonly tasks: readonly Task[];
	/**
	 * Who reads the work when it is done. Absent and empty mean the same thing:
	 * nobody, and the deliverable compiles without a review stage.
	 */
	readonly reviews?: readonly Review[];
}

export interface Plan {
	readonly slug: string;
	readonly title: string;
	/** What the plan is for, when the title does not carry it. */
	readonly body?: string;
	readonly deliverables: readonly Deliverable[];
	readonly repos: readonly PlanRepo[];
	/**
	 * The dials this run turns. Attached by the seat from the decisions a human
	 * already made on the way out of plan mode, never authored by the model:
	 * the `plan` tool has no `policy` parameter. Defaults when absent.
	 */
	readonly policy?: PlanPolicy;
}

/** How a run is gated. `approve-plan` is never optional. */
export const PLAN_GATES = [
	"approve-plan",
	"approve-plan+ship",
	"every-deliverable",
] as const;

export type PlanGates = (typeof PLAN_GATES)[number];

/** What happens to the hand-offs once a human said ship. */
export const PUBLISH_MODES = ["none", "branch", "pr"] as const;

export type PublishMode = (typeof PUBLISH_MODES)[number];

/**
 * The dials a plan sets for its own run.
 *
 * ON THE PLAN, not in the dialogs that collected it: the blind reviewer should
 * see where this is going, and the plan digest should cover it. A decision that
 * lived only in a dialog transcript is a decision no receipt can be checked
 * against.
 */
export interface PlanPolicy {
	/** Default "standard". */
	readonly effort?: Effort;
	/** Default "approve-plan+ship". */
	readonly gates?: PlanGates;
	/** What a review lens that pins nothing is worth. */
	readonly reviewDefault?: {
		readonly tier?: ReviewTier;
		readonly diverse?: boolean;
	};
	/** Default 0 cheap / 1 standard / 2 deep. */
	readonly maxFixRounds?: FixRounds;
	/** Default `{ mode: "none" }`. `pr` needs `gh`, at readiness, not here. */
	readonly publish?: {
		readonly mode: PublishMode;
		readonly base?: string;
	};
}

/** A policy with every question answered. What the compiler actually reads. */
export interface ResolvedPolicy {
	readonly effort: Effort;
	readonly gates: PlanGates;
	readonly reviewDefault: {
		readonly tier: ReviewTier;
		readonly diverse: boolean;
	};
	readonly maxFixRounds: FixRounds;
	readonly publish: {
		readonly mode: PublishMode;
		readonly base?: string;
	};
}

export const DEFAULT_GATES: PlanGates = "approve-plan+ship";

export const DEFAULT_REVIEW_TIER: ReviewTier = "standard";

export const DEFAULT_PUBLISH_MODE: PublishMode = "none";

/** How much fixing each effort pays for, when the plan does not say. */
export const DEFAULT_FIX_ROUNDS: Readonly<Record<Effort, FixRounds>> =
	Object.freeze({ cheap: 0, standard: 1, deep: 2 });

/** A deliverable with its stages settled. */
export interface StagedDeliverable extends Deliverable {
	readonly stages: readonly Stage[];
}

/** A plan with its policy and every stage list settled. */
export interface StagedPlan extends Plan {
	readonly policy: ResolvedPolicy;
	readonly deliverables: readonly StagedDeliverable[];
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
	return (allowed as readonly unknown[]).includes(value)
		? (value as T)
		: fallback;
}

/**
 * The policy, with every default filled in.
 *
 * TOTAL ON PURPOSE: a value it does not recognise resolves to the default
 * rather than throwing, because `inspectPlan` is the one place that reports an
 * unrecognised value and a renderer must not fail on a document the report is
 * about to explain.
 */
export function resolvePolicy(policy?: PlanPolicy): ResolvedPolicy {
	const effort = pick(policy?.effort, EFFORTS, DEFAULT_EFFORT);
	const base = policy?.publish?.base;
	return {
		effort,
		gates: pick(policy?.gates, PLAN_GATES, DEFAULT_GATES),
		reviewDefault: {
			tier: pick(
				policy?.reviewDefault?.tier,
				REVIEW_TIERS,
				DEFAULT_REVIEW_TIER,
			),
			diverse: policy?.reviewDefault?.diverse === true,
		},
		maxFixRounds: pick(
			policy?.maxFixRounds,
			FIX_ROUNDS,
			DEFAULT_FIX_ROUNDS[effort],
		),
		publish: {
			mode: pick(policy?.publish?.mode, PUBLISH_MODES, DEFAULT_PUBLISH_MODE),
			...(typeof base === "string" && base.length > 0 ? { base } : {}),
		},
	};
}

/**
 * What a deliverable compiles to. The only lowering path there is.
 *
 * Version 5 removed authored `stages`, so this is not a default any more — it
 * is the derivation, and the run a person approves is the run this function
 * says. The review stage is omitted rather than declared empty when the
 * deliverable lists no reviews: a fan-out over zero lenses is not a cheaper
 * review, it is a stage that cannot be compiled.
 */
export function defaultStagesFor(
	deliverable: Deliverable,
	policy: ResolvedPolicy,
): readonly Stage[] {
	const lenses: ReviewLens[] = (deliverable.reviews ?? []).map((review) => ({
		id: review.lens,
		tier: review.tier ?? policy.reviewDefault.tier,
		diverse: review.diverse ?? policy.reviewDefault.diverse,
		...(review.skill ? { skill: review.skill } : {}),
		...(review.model ? { model: review.model } : {}),
	}));
	const stages: Stage[] = [
		{ use: "implement", id: "implement" },
		{ use: "verify-and-fix", id: "verify", maxRounds: policy.maxFixRounds },
	];
	if (lenses.length > 0)
		stages.push({
			use: "review-fan-out",
			id: "review",
			lenses,
			synthesis: "optional",
		});
	return stages;
}

/**
 * The plan as it will be compiled: policy resolved, every stage list derived.
 *
 * PURE, AND NOT WHAT IS STORED. The digest is over the authored document, so
 * the stages worked out here never reach disk and never move a receipt: they
 * are a reading of the stored document, recomputed wherever it is read.
 */
export function withDefaultStages(plan: Plan): StagedPlan {
	const policy = resolvePolicy(plan.policy);
	return {
		...plan,
		policy,
		deliverables: plan.deliverables.map((d) => ({
			...d,
			stages: defaultStagesFor(d, policy),
		})),
	};
}

/**
 * The plan with every heavy reviewer's `diverse` written down.
 *
 * WHY THIS IS A REWRITE AND NOT A DEFAULT. A heavy lens reads the same work the
 * implementer wrote; a reviewer from another model family fails differently,
 * which is the entire point of a second opinion. Both compilers — pi-maestro's
 * `compileStageDocument` and pi-workflow's `plan-to-ship` — agree on that, and
 * they used to disagree about the document, because a lens with `diverse`
 * undefined left each of them to decide for itself. Writing `true` into the
 * STORED plan settles it in the one place a receipt can be checked against: the
 * exit does this once, before it compiles anything, so what the human reviews
 * and what the run executes are the same document.
 *
 * Only `undefined` is filled in. A plan that says `diverse: false` on a heavy
 * lens has answered the question, and answering it again would be the flow
 * overruling the author.
 *
 * Returns `undefined` when there was nothing to write, so a caller does not
 * save — and move the digest of — a document nobody changed.
 */
export function withExplicitDiverse(plan: Plan): Plan | undefined {
	let changed = false;
	const deliverables = plan.deliverables.map((deliverable) => {
		if (!deliverable.reviews) return deliverable;
		const reviews = deliverable.reviews.map((review) => {
			if (review.tier !== "heavy" || review.diverse !== undefined)
				return review;
			changed = true;
			return { ...review, diverse: true };
		});
		return { ...deliverable, reviews };
	});
	return changed ? { ...plan, deliverables } : undefined;
}

/**
 * What is wrong with a plan, and what is merely worth knowing.
 *
 * Warnings are separate from errors because a dirty working tree is a real
 * thing to tell an author about and a terrible thing to refuse a plan over:
 * authoring a plan while the tree has edits in it is the normal case, and a
 * store that rejected it would teach authors to stop reading the list.
 */
export interface PlanReport {
	readonly errors: string[];
	readonly warnings: string[];
}

/**
 * What only the host can answer about a review that pins something.
 *
 * A PORT, SO `inspectPlan` STAYS PURE. Two of the things a review may pin are
 * not claims about the document at all — `model` names a model this machine
 * either has or does not, `skill` names a skill Pi either loaded or did not —
 * and a plan that pins either of them on a host that lacks it is a plan whose
 * run fails at the reviewer, long after two humans approved it. The port is
 * the only seam between plan validation and the session; the Pi adapter is
 * `planHostPort` in `plan-host.ts`, and tests pass a fake.
 *
 * ABSENT MEANS REFUSED, NOT ALLOWED. `inspectPlan` without a host cannot
 * check a pinned model or skill, so it refuses one by name rather than
 * accepting it unchecked — a plan that pins what nothing could verify is the
 * exact case this port exists for.
 */
export interface PlanHostPort {
	/**
	 * Whether this host has that exact model. EXISTENCE ONLY: whether its
	 * provider is authenticated is a run-time question about credentials, and
	 * refusing a plan over one would make the document depend on a login.
	 */
	hasModel(provider: string, id: string): boolean;
	/** Every provider id the host registered, so a refusal can list them. */
	registeredProviders(): readonly string[];
	/** The skills Pi has loaded in this session, by name. */
	loadedSkills(): readonly string[];
}

/**
 * How many loaded skill names a refusal prints before it prints the count.
 *
 * A host with a large skills directory would otherwise answer "that skill is
 * not loaded" with four hundred names, which is not an answer anybody reads.
 */
export const MAX_NAMED_SKILLS = 20;

/**
 * Everything wrong with a plan, not just the first thing. An author fixing one
 * error at a time through five round trips is an author who stops reading.
 */
export function validatePlan(
	plan: Plan,
	probe: RepoProbe = gitRepoProbe,
	host?: PlanHostPort,
): string[] {
	return inspectPlan(plan, probe, host).errors;
}

/** `validatePlan`, plus the non-fatal findings. */
export function inspectPlan(
	plan: Plan,
	probe: RepoProbe = gitRepoProbe,
	host?: PlanHostPort,
): PlanReport {
	const errors: string[] = [];
	const warnings: string[] = [];
	const ids = new Set<string>();
	const repoKeys = new Set<string>();
	if (!ID_RE.test(plan.slug))
		errors.push(
			`plan: \`${plan.slug}\` cannot be a slug — it must be lowercase letters, digits and hyphens`,
		);
	if (!plan.title.trim()) errors.push("plan: no title");
	if (plan.repos.length === 0) errors.push("plan: no repositories");

	for (const repo of plan.repos) {
		if (!repo.key.trim()) errors.push("a repo has no key");
		else if (!ID_RE.test(repo.key))
			errors.push(`repo \`${repo.key}\`: key is not a safe workflow name`);
		else if (repoKeys.has(repo.key))
			errors.push(`repo \`${repo.key}\`: duplicate key`);
		repoKeys.add(repo.key);
		// A repository path is the one field in a plan that makes a claim about
		// the world, so it is the one field that can be checked against it. An
		// unchecked path fails at the first worktree the run tries to create,
		// after both humans have already read and approved the plan.
		if (!repo.path.trim()) errors.push(`repo \`${repo.key}\` has no path`);
		else {
			const state = probe(repo.path);
			if (state.root === null)
				errors.push(
					`repo \`${repo.key}\`: \`${repo.path}\` is not an existing Git working-tree root`,
				);
			else if (state.root !== state.resolved)
				errors.push(
					`repo \`${repo.key}\`: \`${repo.path}\` is not a working-tree root — that is \`${state.root}\``,
				);
			else if (state.dirty)
				warnings.push(
					`repo \`${repo.key}\`: \`${repo.path}\` has uncommitted changes — every worktree branches from its HEAD, so those changes are not in the run`,
				);
		}
	}

	if (plan.policy) validatePolicy(plan.policy, errors);

	for (const [i, d] of plan.deliverables.entries()) {
		const where = d.id || `deliverables[${i}]`;
		if (!d.id.trim()) errors.push(`${where}: no id`);
		else if (ids.has(d.id)) errors.push(`${where}: duplicate id`);
		else if (!ID_RE.test(d.id))
			errors.push(
				`${where}: \`${d.id}\` cannot be a workflow id — use lowercase letters, digits and hyphens`,
			);
		ids.add(d.id);

		if (!d.title.trim()) errors.push(`${where}: no title`);

		// The rule that makes an empty deliverable impossible. A support agent
		// with zero tasks used to be legal, and rendered an empty "## Focus" to a
		// live agent that then had nothing to do.
		if (d.tasks.length === 0)
			errors.push(
				`${where}: no tasks — a deliverable is work, or it is nothing`,
			);

		// THE OLD PLACE, REFUSED BY NAME. A stored document is caught by its
		// envelope version, but a model writing a fresh plan from memory of the
		// version 4 field writes `stages` into a version 5 body, where the type
		// says nothing and the field would simply be ignored — a plan that
		// validates and stores with a run nobody wrote.
		if ((d as { stages?: unknown }).stages !== undefined)
			errors.push(
				`${where}: carries \`stages\`, which plan schema v5 removed: a deliverable's run is derived from its tasks, its \`reviews\` and the policy the seat attaches, so there is nothing here for an author to write. Drop \`stages\``,
			);

		validateTasks(d.tasks, where, errors);
		validateReviews(d.reviews, where, errors, host);

		if (d.repo !== undefined && !repoKeys.has(d.repo))
			errors.push(`${where}: unknown repo \`${d.repo}\``);
	}

	// Which repository a deliverable works in, resolved the way a run resolves
	// it — an absent `repo` is the plan's first.
	const repoOf = (id: string): string | undefined => {
		const found = plan.deliverables.find((d) => d.id === id);
		return found?.repo ?? plan.repos[0]?.key;
	};

	// Edges resolve, and reading implies waiting.
	for (const d of plan.deliverables) {
		for (const ref of d.after) {
			if (ref === d.id) errors.push(`${d.id}: waits for itself`);
			else if (!ids.has(ref))
				errors.push(`${d.id}: after \`${ref}\` — no such deliverable`);
		}
		for (const ref of d.reads) {
			if (!ids.has(ref)) {
				errors.push(`${d.id}: reads \`${ref}\` — no such deliverable`);
			} else if (!d.after.includes(ref)) {
				errors.push(
					`${d.id}: reads \`${ref}\` without waiting for it — add it to \`after\`, or it may not have run yet`,
				);
			} else if (repoOf(ref) === repoOf(d.id)) {
				// A `reads` edge inside one repository says "my code builds on
				// yours". Nothing can deliver that yet: every worktree branches
				// from the same baseline, a hand-off is never applied, and a
				// fan-out has no per-item `after`. Refused BY NAME rather than
				// compiled and silently dropped, which is how a plan gets approved
				// for something the run was never going to do.
				errors.push(
					`${d.id}: reads \`${ref}\` in the same repository — a deliverable cannot build on another's hand-off yet: every worktree branches from the same baseline and a fan-out has no per-item \`after\`. Keep \`after\` for the ordering and say what this one needs in its body, or make them one deliverable`,
				);
			}
		}
	}

	for (const cycle of findCycles(plan.deliverables))
		errors.push(`cycle: ${cycle.join(" → ")}`);

	return { errors, warnings };
}

function validateTasks(
	tasks: readonly Task[],
	where: string,
	errors: string[],
): void {
	const seen = new Set<string>();
	for (const [i, t] of tasks.entries()) {
		const at = `${where}.tasks[${i}]`;
		if (!t.id.trim()) errors.push(`${at}: no id`);
		else if (!ID_RE.test(t.id))
			errors.push(`${at}: \`${t.id}\` is not a safe workflow name`);
		else if (seen.has(t.id))
			errors.push(`${where}: duplicate task id \`${t.id}\``);
		seen.add(t.id);
		if (!t.title.trim()) errors.push(`${at}: no title`);
		// THE TWO OLD NAMES, REFUSED BY NAME. A stored document is caught by its
		// envelope version, but a model writing a fresh plan from memory of an
		// earlier one writes the old field into a version 5 body, where the type
		// says nothing and the field would simply be ignored — a plan that
		// validates, stores, and compiles with no reviewers at all.
		if ((t as { review?: unknown }).review !== undefined)
			errors.push(
				`${at}: task \`${t.id}\` carries \`review\`, which plan schema v5 moved to \`deliverables[].reviews\`: a task is work, and a deliverable lists who reads that work once, beside its tasks. There is no migration`,
			);
		if ((t as { by?: unknown }).by !== undefined)
			errors.push(
				`${at}: task \`${t.id}\` carries \`by\`, which plan schema v5 moved to \`deliverables[].reviews\`: \`by\` was a version 3 field, version 4 renamed it \`review\`, and version 5 took reviews off the task altogether. There is no migration`,
			);
	}
}

/**
 * The reviews of one deliverable: the whole of who reads its work.
 *
 * `lens` is the one required field, so an empty one is the one thing here that
 * cannot be dropped at the boundary as "nothing to say" — it is the document
 * claiming a review exists and declining to say what it reads for. That is the
 * shape four by-hand passes produced, and the refusal names the way out.
 */
function validateReviews(
	reviews: readonly Review[] | undefined,
	where: string,
	errors: string[],
	host?: PlanHostPort,
): void {
	if (reviews === undefined) return;
	if (reviews.length > MAX_LENSES)
		errors.push(
			`${where}: ${reviews.length} reviews — at most ${MAX_LENSES} read one deliverable`,
		);
	for (const [i, review] of reviews.entries()) {
		const at = `${where}.reviews[${i}]`;
		const lens: unknown = review?.lens;
		if (typeof lens !== "string" || lens.trim().length === 0)
			errors.push(
				`${at}: a review needs a lens; a task that is not a review is simply a task, and belongs in \`tasks\` with no review entry`,
			);
		else if (!LENS_ID_RE.test(lens))
			errors.push(`${at}: ${lensIdProblem(lens)}`);
		if (review) validateReviewRouting(review, at, errors, host);
	}
}

/**
 * Why this is not a lens id, in one sentence that names the rule.
 *
 * Said in one place because `deliverables[].reviews[].lens` and a
 * `review-fan-out` lens id are the same key in the compiled document, and two
 * messages for one rule is how the two drift.
 */
function lensIdProblem(id: unknown): string {
	return (
		`\`${String(id)}\` is not a safe review lens — a lens id is ` +
		`a workflow fan-out key, so it must match \`${LENS_ID_RE.source}\`: a ` +
		"lowercase letter, then lowercase letters, digits and hyphens"
	);
}

/** The registered providers, for a refusal, or why there are none to name. */
function providerList(host: PlanHostPort): string {
	const providers = host.registeredProviders();
	return providers.length === 0
		? "this host has registered no model providers"
		: `this host's registered providers are ${providers
				.map((provider) => `\`${provider}\``)
				.join(", ")}`;
}

/** The loaded skills, by name while a reader would read them, else counted. */
function skillList(host: PlanHostPort): string {
	const skills = host.loadedSkills();
	if (skills.length === 0) return "this session has loaded no skills";
	if (skills.length > MAX_NAMED_SKILLS)
		return `this session has ${skills.length} skills loaded, and none of them is that one`;
	return `the skills loaded here are ${skills
		.map((skill) => `\`${skill}\``)
		.join(", ")}`;
}

/**
 * The routing a review can ask for, wherever it is written.
 *
 * Shared by `deliverables[].reviews` and `policy.reviewDefault` on purpose: the
 * two are the same request at two scopes, and a rule that held in one of them
 * would be a rule an author could route around by moving the field.
 *
 * `skill` and `model` are the two fields a document cannot check about itself,
 * so they are the two the host is asked about — and with no host to ask, a
 * pinned one is refused rather than trusted. @see PlanHostPort
 */
function validateReviewRouting(
	routing: {
		readonly tier?: ReviewTier;
		readonly diverse?: boolean;
		readonly skill?: string;
		readonly model?: string;
	},
	at: string,
	errors: string[],
	host?: PlanHostPort,
): void {
	if (routing.skill !== undefined) {
		if (!ID_RE.test(routing.skill))
			errors.push(
				`${at}: \`${routing.skill}\` is not a safe ambient skill name`,
			);
		else if (!host)
			errors.push(
				`${at}: \`skill\` pins \`${routing.skill}\` and there is no session here to ask which skills are loaded, so it is refused rather than stored unchecked — drop \`skill\` and let the lens prompt find it`,
			);
		else if (!host.loadedSkills().includes(routing.skill))
			errors.push(
				`${at}: \`${routing.skill}\` is not a skill this session has loaded — ${skillList(host)}. \`skill\` is optional: drop it and let the lens prompt find what it needs`,
			);
	}
	// `model` is optional: a plan that pins one runs only where that model
	// exists, and the point of `tier`/`diverse` is that the host resolves the
	// reviewer. Neither is legal too — then the running workflow's effort dial
	// decides.
	if (routing.model !== undefined) {
		const slash = routing.model.indexOf("/");
		if (!/^\S+\/\S+$/.test(routing.model))
			errors.push(
				`${at}: review model must be a concrete provider/model ID — ` +
					"`model` is optional, so drop it and pin `tier` instead unless the " +
					"reviewer must be one exact model the host has",
			);
		else if (!host)
			errors.push(
				`${at}: \`model\` pins \`${routing.model}\` and there is no model catalogue here to check it against, so it is refused rather than stored unchecked — drop \`model\` and pin \`tier\` instead`,
			);
		// Split at the FIRST slash: a provider id has none and a model id may
		// have several (`openrouter/anthropic/claude-...`), which is the same
		// reading `shortModelName` and the model router take.
		else if (
			!host.hasModel(
				routing.model.slice(0, slash),
				routing.model.slice(slash + 1),
			)
		)
			errors.push(
				`${at}: \`${routing.model}\` is not a model this host has — ${providerList(host)}. \`model\` is optional: drop it and pin \`tier\` instead unless the reviewer must be one exact model`,
			);
	}
	if (
		routing.tier !== undefined &&
		!(REVIEW_TIERS as readonly string[]).includes(routing.tier)
	)
		errors.push(
			`${at}: \`${routing.tier}\` is not a review tier — one of ${REVIEW_TIERS.join(", ")}`,
		);
	if (routing.diverse !== undefined && typeof routing.diverse !== "boolean")
		errors.push(`${at}: \`diverse\` is true or false`);
}

/**
 * Whether Git would accept this as a branch name.
 *
 * Checked here rather than at publication because `policy.publish.base` is
 * part of the approved document: a base branch nobody can check out is worth
 * catching while the plan is still being written, not on the push.
 */
export function isRefName(name: string): boolean {
	if (name.length === 0 || name.length > 255) return false;
	for (const char of name) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) return false;
	}
	if (/[\s~^:?*[\\]/.test(name)) return false;
	if (name.includes("..") || name.includes("@{") || name.includes("//"))
		return false;
	if (name.startsWith("/") || name.endsWith("/")) return false;
	if (name.startsWith("-") || name.startsWith(".")) return false;
	if (name.endsWith(".") || name.endsWith(".lock")) return false;
	return true;
}

/**
 * Every dial the plan set, checked against the vocabulary that has meaning.
 *
 * Exported because a plan is not the only place a policy is written down: the
 * plan-mode exit records the one a human chose before the document exists
 * (`pending-exit.ts`), and a second validator there would be a second opinion
 * about what is legal.
 */
export function validatePolicy(policy: PlanPolicy, errors: string[]): void {
	const at = "policy";
	if (policy.effort !== undefined && !EFFORTS.includes(policy.effort))
		errors.push(
			`${at}: \`${policy.effort}\` is not an effort — one of ${EFFORTS.join(", ")}`,
		);
	if (
		policy.gates !== undefined &&
		!(PLAN_GATES as readonly string[]).includes(policy.gates)
	)
		errors.push(
			`${at}: \`${policy.gates}\` is not a gate policy — one of ${PLAN_GATES.join(", ")}`,
		);
	if (
		policy.maxFixRounds !== undefined &&
		!(FIX_ROUNDS as readonly number[]).includes(policy.maxFixRounds)
	)
		errors.push(
			`${at}: \`maxFixRounds\` is ${FIX_ROUNDS.join(", ")} — a fix loop is bounded or it is not a loop anyone approved`,
		);
	if (policy.reviewDefault)
		validateReviewRouting(policy.reviewDefault, `${at}.reviewDefault`, errors);
	if (policy.publish) {
		const { mode, base } = policy.publish;
		if (!(PUBLISH_MODES as readonly string[]).includes(mode))
			errors.push(
				`${at}.publish: \`${mode}\` is not a publication mode — one of ${PUBLISH_MODES.join(", ")}`,
			);
		if (base !== undefined && !isRefName(base))
			errors.push(`${at}.publish: \`${base}\` is not a valid branch name`);
		// `mode: "pr"` needs `gh`, and that is a fact about the host at readiness
		// time, not about the document. Not checked here on purpose.
	}
}

/** Every dependency cycle, reported once each, as the path that closes it. */
function findCycles(deliverables: readonly Deliverable[]): string[][] {
	const edges = new Map(deliverables.map((d) => [d.id, d.after]));
	const cycles: string[][] = [];
	const reported = new Set<string>();
	const state = new Map<string, "open" | "done">();
	const stack: string[] = [];

	const visit = (id: string): void => {
		if (state.get(id) === "done") return;
		const at = stack.indexOf(id);
		if (at !== -1) {
			const cycle = [...stack.slice(at), id];
			// Same cycle, different entry point, is still one cycle.
			const key = [...cycle.slice(0, -1)].sort().join(",");
			if (!reported.has(key)) {
				reported.add(key);
				cycles.push(cycle);
			}
			return;
		}
		state.set(id, "open");
		stack.push(id);
		for (const next of edges.get(id) ?? []) if (edges.has(next)) visit(next);
		stack.pop();
		state.set(id, "done");
	};

	for (const d of deliverables) visit(d.id);
	return cycles;
}
