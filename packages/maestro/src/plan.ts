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
}

export interface Plan {
	readonly slug: string;
	readonly title: string;
	readonly deliverables: readonly Deliverable[];
	readonly repos: readonly PlanRepo[];
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

		validateTasks(d.tasks, where, errors);

		if (d.repo !== undefined && !repoKeys.has(d.repo))
			errors.push(`${where}: unknown repo \`${d.repo}\``);
	}

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
			if (!ID_RE.test(t.by.lens))
				errors.push(`${at}: \`${t.by.lens}\` is not a safe review lens`);
			if (t.by.skill !== undefined && !ID_RE.test(t.by.skill))
				errors.push(
					`${at}: \`${t.by.skill}\` is not a safe ambient skill name`,
				);
			// `model` is optional: a plan that pins one runs only where that
			// model exists, and the point of `tier`/`diverse` is that the host
			// resolves the reviewer. Neither is legal too — then the running
			// workflow's effort dial decides.
			if (t.by.model !== undefined && !/^\S+\/\S+$/.test(t.by.model))
				errors.push(
					`${at}: delegated task model must be a concrete provider/model ID`,
				);
			if (
				t.by.tier !== undefined &&
				!(REVIEW_TIERS as readonly string[]).includes(t.by.tier)
			)
				errors.push(
					`${at}: \`${t.by.tier}\` is not a review tier — one of ${REVIEW_TIERS.join(", ")}`,
				);
			if (t.by.diverse !== undefined && typeof t.by.diverse !== "boolean")
				errors.push(`${at}: \`diverse\` is true or false`);
		}
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
