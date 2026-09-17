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
 * A task compiled into its own read-only workflow stage. There is no agent
 * kind: a writer is authored as a deliverable, never as delegated work.
 */
export interface WorkflowDelegation {
	/** The independent point of view this reviewer applies. */
	readonly lens: string;
	/** Optional ambient skill to request explicitly in the stage prompt. */
	readonly skill?: string;
	/**
	 * One concrete launch, pinned. OPTIONAL: a plan that names a literal
	 * `provider/model` is a plan that only runs on the host that has it. Repeat
	 * the lens in another task to use another model.
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

export interface Task {
	readonly id: string;
	readonly title: string;
	readonly body?: string;
	/** Absent = the deliverable's own worker does it. */
	readonly by?: WorkflowDelegation;
}

/**
 * The kinds of stage a deliverable compiles into.
 *
 * `use` names a PLAN STAGE KIND, not a component: the plan's vocabulary and
 * the library that lowers it are allowed to diverge, and several components
 * the library will grow have nothing behind them yet. `dynamic` is reserved
 * here so a document can be written against it before anything compiles it —
 * validation refuses it by name rather than letting it reach a compiler that
 * would drop it.
 */
export const STAGE_KINDS = [
	"implement",
	"verify-and-fix",
	"review-fan-out",
	"gate",
	"dynamic",
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

/** At most this many lenses in one fan-out. The component refuses more. */
export const MAX_LENSES = 16;

/** A tool NAME, which is the only thing a stage may say about tools. */
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

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

/** A human decides. Last in its deliverable, because nothing follows a gate. */
export interface GateStage {
	readonly use: "gate";
	readonly id: string;
	readonly question: string;
	/** Earlier sibling stage ids whose results the decision is shown. */
	readonly show?: readonly string[];
}

/** Reserved: a stage the run writes for itself. Refused until it compiles. */
export interface DynamicStage {
	readonly use: "dynamic";
	readonly id: string;
	readonly brief: string;
}

export type Stage =
	| ImplementStage
	| VerifyAndFixStage
	| ReviewFanOutStage
	| GateStage
	| DynamicStage;

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
	 * How this deliverable is compiled, in order. OPTIONAL: a deliverable
	 * with none gets `defaultStagesFor` — implement, verify, review — derived
	 * from the plan's policy, so every document written before stages existed
	 * still compiles to what it always compiled to.
	 */
	readonly stages?: readonly Stage[];
}

export interface Plan {
	readonly slug: string;
	readonly title: string;
	readonly deliverables: readonly Deliverable[];
	readonly repos: readonly PlanRepo[];
	/** The dials this plan sets for its own run. Defaults when absent. */
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
 * What a deliverable that declared no stages compiles to.
 *
 * The review stage is omitted rather than declared empty when nothing in the
 * deliverable asked for a review: a fan-out over zero lenses is not a cheaper
 * review, it is a stage that cannot be compiled.
 */
export function defaultStagesFor(
	deliverable: Deliverable,
	policy: ResolvedPolicy,
): readonly Stage[] {
	const lenses: ReviewLens[] = [];
	for (const task of deliverable.tasks) {
		const by = task.by;
		if (!by) continue;
		lenses.push({
			id: by.lens,
			tier: by.tier ?? policy.reviewDefault.tier,
			diverse: by.diverse ?? policy.reviewDefault.diverse,
			...(by.skill ? { skill: by.skill } : {}),
			...(by.model ? { model: by.model } : {}),
		});
	}
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
 * The plan as it will be compiled: policy resolved, every stage list explicit.
 *
 * PURE, AND NOT WHAT IS STORED. The digest is over the authored document, so
 * filling defaults in here cannot change what a receipt is checked against —
 * an author who never wrote `stages` keeps the same digest they had before
 * stages existed, and gets the same three stages either way.
 */
export function withDefaultStages(plan: Plan): StagedPlan {
	const policy = resolvePolicy(plan.policy);
	return {
		...plan,
		policy,
		deliverables: plan.deliverables.map((d) => ({
			...d,
			stages: d.stages ?? defaultStagesFor(d, policy),
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
	const heavyUndecided = (routing: {
		readonly tier?: ReviewTier;
		readonly diverse?: boolean;
	}): boolean => routing.tier === "heavy" && routing.diverse === undefined;
	const deliverables = plan.deliverables.map((deliverable) => {
		const tasks = deliverable.tasks.map((task) => {
			if (!task.by || !heavyUndecided(task.by)) return task;
			changed = true;
			return { ...task, by: { ...task.by, diverse: true } };
		});
		const stages = deliverable.stages?.map((stage) => {
			if (stage.use !== "review-fan-out") return stage;
			let stageChanged = false;
			const lenses = stage.lenses.map((lens) => {
				if (!heavyUndecided(lens)) return lens;
				stageChanged = true;
				return { ...lens, diverse: true };
			});
			if (!stageChanged) return stage;
			changed = true;
			return { ...stage, lenses };
		});
		return {
			...deliverable,
			tasks,
			...(stages ? { stages } : {}),
		};
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
 * Everything wrong with a plan, not just the first thing. An author fixing one
 * error at a time through five round trips is an author who stops reading.
 */
export function validatePlan(
	plan: Plan,
	probe: RepoProbe = gitRepoProbe,
): string[] {
	return inspectPlan(plan, probe).errors;
}

/** `validatePlan`, plus the non-fatal findings. */
export function inspectPlan(
	plan: Plan,
	probe: RepoProbe = gitRepoProbe,
): PlanReport {
	const errors: string[] = [];
	const warnings: string[] = [];
	const ids = new Set<string>();
	const repoKeys = new Set<string>();
	// Validated as it will be COMPILED, not as it was typed: a deliverable that
	// declared no stages still has three, and a rule that only ran over authored
	// stages would report nothing about the run that is actually going to happen.
	const staged = withDefaultStages(plan);
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

	for (const [i, d] of staged.deliverables.entries()) {
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

		validateTasks(d.tasks, where, errors);
		validateStages(d.stages, where, errors);

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
		// No agent-kind check: delegated tasks compile to read-only workflow stages.
		if (t.by) {
			if (!LENS_ID_RE.test(t.by.lens))
				errors.push(`${at}: ${lensIdProblem(t.by.lens)}`);
			validateReviewRouting(t.by, at, errors);
		}
	}
}

/**
 * A stage may say what to decide. It may not say how, or where the bytes are:
 * a plan is read by a human and by a blind reviewer, and both of them are
 * entitled to a document that does not smuggle an implementation past them.
 */
const PATH_LIKE = /(^|\s)(~|\.{1,2})?\/\S/;

const CODE_LIKE = /```|=>|\bfunction\s*\(|\bconst\s+\w+\s*=|[;{}]\s*$/m;

function validateProse(
	value: string,
	at: string,
	field: string,
	errors: string[],
): void {
	if (PATH_LIKE.test(value))
		errors.push(
			`${at}: \`${field}\` names a filesystem path — a stage says what to do, not where the bytes are`,
		);
	else if (CODE_LIKE.test(value))
		errors.push(
			`${at}: \`${field}\` contains code — a stage says what to do, not how to do it`,
		);
}

/**
 * The routing a review can ask for, wherever it is written.
 *
 * Shared by `tasks[].by` and `review-fan-out` lenses on purpose: the two are
 * the same request in two places, and a rule that held in one of them would be
 * a rule an author could route around by moving the field.
 */
/**
 * Why this is not a lens id, in one sentence that names the rule.
 *
 * Said in one place because `tasks[].by.lens` and a `review-fan-out` lens id
 * are the same key in the compiled document, and two messages for one rule is
 * how the two drift.
 */
function lensIdProblem(id: unknown): string {
	return (
		`\`${String(id)}\` is not a safe review lens — a lens id is required and is ` +
		`a workflow fan-out key, so it must match \`${LENS_ID_RE.source}\`: a ` +
		"lowercase letter, then lowercase letters, digits and hyphens"
	);
}

function validateReviewRouting(
	routing: {
		readonly tier?: ReviewTier;
		readonly diverse?: boolean;
		readonly skill?: string;
		readonly model?: string;
	},
	at: string,
	errors: string[],
): void {
	if (routing.skill !== undefined && !ID_RE.test(routing.skill))
		errors.push(`${at}: \`${routing.skill}\` is not a safe ambient skill name`);
	// `model` is optional: a plan that pins one runs only where that model
	// exists, and the point of `tier`/`diverse` is that the host resolves the
	// reviewer. Neither is legal too — then the running workflow's effort dial
	// decides.
	if (routing.model !== undefined && !/^\S+\/\S+$/.test(routing.model))
		errors.push(
			`${at}: delegated task model must be a concrete provider/model ID — ` +
				"`model` is optional, so drop it and pin `tier` instead unless the " +
				"reviewer must be one exact model the host has",
		);
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

/**
 * The stage list of one deliverable.
 *
 * Every rule reports rather than throws, and the list is walked to the end
 * even after a bad stage, because a stage list is authored whole and an author
 * fixing one stage per round trip is an author who starts guessing.
 */
function validateStages(
	stages: readonly Stage[],
	where: string,
	errors: string[],
): void {
	const declared = new Set<string>();
	const implementAt: number[] = [];
	const verifyAt: number[] = [];

	for (const [i, stage] of stages.entries()) {
		const at = `${where}.stages[${i}]`;
		const kind: unknown = (stage as { use?: unknown }).use;
		if (
			typeof kind !== "string" ||
			!(STAGE_KINDS as readonly string[]).includes(kind)
		) {
			errors.push(
				`${at}: \`${String(kind)}\` is not a stage kind — one of ${STAGE_KINDS.join(", ")}`,
			);
			continue;
		}

		const id: unknown = (stage as { id?: unknown }).id;
		if (typeof id !== "string" || !id.trim()) errors.push(`${at}: no id`);
		else if (!ID_RE.test(id))
			errors.push(
				`${at}: \`${id}\` cannot be a stage id — it becomes a workflow namespace, so use lowercase letters, digits and hyphens`,
			);
		else if (declared.has(id))
			errors.push(`${where}: duplicate stage id \`${id}\``);

		switch (stage.use) {
			case "implement": {
				implementAt.push(i);
				for (const tool of stage.tools ?? [])
					if (!TOOL_NAME_RE.test(tool))
						errors.push(
							`${at}: \`${tool}\` is not a tool name — \`tools\` names tools, not commands or paths`,
						);
				break;
			}
			case "verify-and-fix": {
				verifyAt.push(i);
				if (
					stage.maxRounds !== undefined &&
					!(FIX_ROUNDS as readonly number[]).includes(stage.maxRounds)
				)
					errors.push(
						`${at}: \`maxRounds\` is ${FIX_ROUNDS.join(", ")} — a fix loop is bounded or it is not a loop anyone approved`,
					);
				if (
					stage.escalate !== undefined &&
					!(ESCALATIONS as readonly string[]).includes(stage.escalate)
				)
					errors.push(
						`${at}: \`${stage.escalate}\` is not an escalation — one of ${ESCALATIONS.join(", ")}`,
					);
				break;
			}
			case "review-fan-out": {
				const lenses = stage.lenses ?? [];
				if (lenses.length === 0)
					errors.push(
						`${at}: no lenses — a fan-out over nothing is not a cheaper review`,
					);
				if (lenses.length > MAX_LENSES)
					errors.push(
						`${at}: ${lenses.length} lenses — at most ${MAX_LENSES} fan out at once`,
					);
				for (const [j, lens] of lenses.entries()) {
					const lensAt = `${at}.lenses[${j}]`;
					if (typeof lens?.id !== "string" || !LENS_ID_RE.test(lens.id))
						errors.push(`${lensAt}: ${lensIdProblem(lens?.id)}`);
					if (lens) validateReviewRouting(lens, lensAt, errors);
				}
				if (
					stage.synthesis !== undefined &&
					!(SYNTHESIS_MODES as readonly string[]).includes(stage.synthesis)
				)
					errors.push(
						`${at}: \`${stage.synthesis}\` is not a synthesis mode — one of ${SYNTHESIS_MODES.join(", ")}`,
					);
				break;
			}
			case "gate": {
				if (typeof stage.question !== "string" || !stage.question.trim())
					errors.push(`${at}: no question — a gate asks something`);
				else validateProse(stage.question, at, "question", errors);
				for (const ref of stage.show ?? [])
					if (!declared.has(ref))
						errors.push(
							`${at}: shows \`${ref}\` — a gate shows stages declared before it in this deliverable`,
						);
				if (i !== stages.length - 1)
					errors.push(
						`${at}: a \`gate\` is the last stage of its deliverable — nothing runs after a human decided`,
					);
				break;
			}
			case "dynamic": {
				errors.push(`${at}: dynamic stages are not compiled yet`);
				if (typeof stage.brief === "string")
					validateProse(stage.brief, at, "brief", errors);
				break;
			}
		}

		if (typeof id === "string") declared.add(id);
	}

	if (implementAt.length === 0)
		errors.push(
			`${where}: stages declare no \`implement\` stage — a deliverable is work, or it is nothing`,
		);
	else if (implementAt.length > 1)
		errors.push(
			`${where}: ${implementAt.length} \`implement\` stages — a deliverable produces one hand-off, so it implements once`,
		);

	const firstImplement = implementAt[0];
	for (const i of verifyAt)
		if (firstImplement === undefined || i < firstImplement)
			errors.push(
				`${where}.stages[${i}]: a \`verify-and-fix\` stage follows the \`implement\` stage — there is nothing to verify before it`,
			);
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
