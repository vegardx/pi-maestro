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

/** A repo the plan works in. Plan preflight guarantees it exists. */
export interface PlanRepo {
	readonly key: string;
	/** Where it lives once preflight has run. */
	readonly path: string;
	/** Absent = it already exists. Present = preflight creates it this way. */
	readonly create?: {
		readonly remote?: string;
		readonly private?: boolean;
		readonly description?: string;
	};
}

/**
 * What a deliverable id may look like.
 *
 * Narrow because the id is not just a label: it becomes a git branch and a
 * worktree directory, so an id that needs escaping is an id where two
 * deliverables can collide into one branch. Constraining it here means the
 * execution layer needs no escaping step at all.
 */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A task handed to a subagent. There is no `agent` field: a task's subagent is
 * always read-only — a writer is authored as a deliverable, never spawned from
 * a task — so the field could only ever restate a rule, and a field that can
 * only hold one value is a field someone will eventually hold wrong.
 */
export interface SubagentRef {
	/** Which persona — the prose that says what to look for. */
	readonly persona: string;
	/**
	 * Fan out across model families rather than asking one agent. Intent only:
	 * never a model, never a count. Configuration decides the width.
	 */
	readonly fanOut?: boolean;
}

export interface Task {
	readonly id: string;
	readonly title: string;
	readonly body?: string;
	/** Absent = the deliverable's own worker does it. */
	readonly by?: SubagentRef;
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
	/**
	 * What maestro does before ANY deliverable starts — a barrier, not a DAG
	 * root. "Every deliverable waits for this" is a global fact; expressed as
	 * edges it would depend on the author remembering one per deliverable.
	 */
	readonly preflight: readonly Task[];
	readonly deliverables: readonly Deliverable[];
	/** What maestro does once every deliverable is terminal. */
	readonly postflight: readonly Task[];
	readonly repos: readonly PlanRepo[];
}

/**
 * Everything wrong with a plan, not just the first thing. An author fixing one
 * error at a time through five round trips is an author who stops reading.
 */
export function validatePlan(plan: Plan): string[] {
	const errors: string[] = [];
	const ids = new Set<string>();
	const repoKeys = new Set(plan.repos.map((r) => r.key));

	for (const repo of plan.repos) {
		if (!repo.key.trim()) errors.push("a repo has no key");
		if (!repo.path.trim()) errors.push(`repo \`${repo.key}\` has no path`);
	}

	for (const [i, d] of plan.deliverables.entries()) {
		const where = d.id || `deliverables[${i}]`;
		if (!d.id.trim()) errors.push(`${where}: no id`);
		else if (ids.has(d.id)) errors.push(`${where}: duplicate id`);
		else if (!ID_RE.test(d.id))
			errors.push(
				`${where}: \`${d.id}\` cannot be an id — it becomes a branch name and a directory, so it must be lowercase letters, digits and hyphens`,
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

	validateTasks(plan.preflight, "preflight", errors);
	validateTasks(plan.postflight, "postflight", errors);

	return errors;
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
		else if (seen.has(t.id))
			errors.push(`${where}: duplicate task id \`${t.id}\``);
		seen.add(t.id);
		if (!t.title.trim()) errors.push(`${at}: no title`);
		// No agent-kind check: `by` has no agent field to get wrong. A writer as
		// a task's subagent is unrepresentable, not merely refused.
		if (t.by && !t.by.persona.trim())
			errors.push(`${at}: handed to a subagent with no persona`);
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

/**
 * Deliverables ready to start, in author order: not started, and every
 * predecessor SUCCEEDED.
 *
 * Succeeded, not merely terminal. A failure stops its dependents — running
 * work whose input never arrived produces a confident wrong answer, which is
 * worse than not running it. What a failure must NOT stop is everything else,
 * which falls out of this being per-deliverable rather than global.
 */
export function readyDeliverables(
	plan: Plan,
	succeeded: ReadonlySet<string>,
	started: ReadonlySet<string>,
): Deliverable[] {
	return plan.deliverables.filter(
		(d) =>
			!started.has(d.id) &&
			!succeeded.has(d.id) &&
			d.after.every((ref) => succeeded.has(ref)),
	);
}

/**
 * Deliverables that can never run now, and why — the transitive closure of
 * failure through the DAG.
 *
 * Maestro's final report has to distinguish these from work that merely has
 * not started yet: once independent branches are allowed to finish, "the plan
 * ran" stops meaning "the plan is done", and a reader needs to see which of
 * shipped / failed / never-started each deliverable was.
 */
export function strandedByFailure(
	plan: Plan,
	failed: ReadonlySet<string>,
): Map<string, string> {
	const stranded = new Map<string, string>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const d of plan.deliverables) {
			if (failed.has(d.id) || stranded.has(d.id)) continue;
			const blocker = d.after.find(
				(ref) => failed.has(ref) || stranded.has(ref),
			);
			if (blocker) {
				stranded.set(d.id, blocker);
				grew = true;
			}
		}
	}
	return stranded;
}
