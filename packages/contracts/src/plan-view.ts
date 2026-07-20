// PlanView: the ONE read-side projection of a plan that every consumer
// renders from — HUD plan tab, /agents overview, the e2e driver's state and
// assertions. Consumers never touch the plan schema directly; when the v2
// recursive-node schema lands, only projectPlanView changes (walking nodes
// with real depth) and every consumer keeps working (plan-schema spike PR-1).
//
// Pure and defensive over PARSED JSON (the plan file is the state API): the
// driver reads plan.json off disk, the HUD projects the live engine object —
// both go through here. Unknown shapes project to undefined, never throw.

export interface PlanViewTask {
	readonly id: string;
	readonly title: string;
	readonly done: boolean;
	/** Effective kind — absent in the file means "task". */
	readonly kind: string;
}

/** A support agent attached to a node (v1's AgentSpec; child rows in v2). */
export interface PlanViewAgent {
	readonly name: string;
	readonly mode?: string;
	readonly after: readonly string[];
}

export interface PlanViewNode {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	/** Distance from the root. Always 0 for v1 flat plans. */
	readonly depth: number;
	readonly tasks: readonly PlanViewTask[];
	readonly agents: readonly PlanViewAgent[];
	readonly dependsOn: readonly string[];
	readonly stacked?: boolean;
	readonly branch?: string;
	readonly baseSha?: string;
	readonly prUrl?: string;
	readonly workerMode?: string;
	readonly workerModel?: string;
	readonly workerEffort?: string;
	/** Who authored this node: "plan" (default) or a parent node id (v2). */
	readonly authoredBy: string;
}

export interface PlanView {
	readonly slug?: string;
	readonly title?: string;
	readonly nodes: readonly PlanViewNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strings(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function projectTask(raw: unknown): PlanViewTask | undefined {
	if (!isRecord(raw)) return undefined;
	const id = str(raw.id);
	const title = str(raw.title);
	if (!id || !title) return undefined;
	return { id, title, done: raw.done === true, kind: str(raw.kind) ?? "task" };
}

function projectAgent(raw: unknown): PlanViewAgent | undefined {
	if (!isRecord(raw)) return undefined;
	const name = str(raw.name);
	if (!name) return undefined;
	return {
		name,
		...(str(raw.mode) ? { mode: str(raw.mode) } : {}),
		after: strings(raw.after),
	};
}

function projectNode(raw: unknown, depth: number): PlanViewNode | undefined {
	if (!isRecord(raw)) return undefined;
	const id = str(raw.id);
	const title = str(raw.title);
	if (!id || !title) return undefined;
	const worker = isRecord(raw.worker) ? raw.worker : undefined;
	return {
		id,
		title,
		status: str(raw.status) ?? "planned",
		depth,
		tasks: (Array.isArray(raw.tasks) ? raw.tasks : [])
			.map(projectTask)
			.filter((task): task is PlanViewTask => task !== undefined),
		agents: (Array.isArray(raw.agents) ? raw.agents : [])
			.map(projectAgent)
			.filter((agent): agent is PlanViewAgent => agent !== undefined),
		dependsOn: strings(raw.dependsOn),
		...(raw.stacked === true ? { stacked: true } : {}),
		...(str(raw.branch) ? { branch: str(raw.branch) } : {}),
		...(str(raw.baseSha) ? { baseSha: str(raw.baseSha) } : {}),
		...(str(raw.prUrl) ? { prUrl: str(raw.prUrl) } : {}),
		...(str(worker?.mode) ? { workerMode: str(worker?.mode) } : {}),
		...(str(worker?.model) ? { workerModel: str(worker?.model) } : {}),
		...(str(worker?.effort) ? { workerEffort: str(worker?.effort) } : {}),
		authoredBy: str(raw.authoredBy) ?? "plan",
	};
}

/**
 * Project a plan — the live engine object or parsed plan.json — into the
 * view every consumer renders from. Returns undefined when the value has no
 * recognizable plan shape.
 */
export function projectPlanView(planLike: unknown): PlanView | undefined {
	if (!isRecord(planLike)) return undefined;
	// v1: a flat deliverables list, every node at depth 0. (v2 will walk the
	// recursive nodes tree here — the only place that changes.)
	if (!Array.isArray(planLike.deliverables)) return undefined;
	const nodes = planLike.deliverables
		.map((raw) => projectNode(raw, 0))
		.filter((node): node is PlanViewNode => node !== undefined);
	return {
		...(str(planLike.slug) ? { slug: str(planLike.slug) } : {}),
		...(str(planLike.title) ? { title: str(planLike.title) } : {}),
		nodes,
	};
}

/** Gating tasks only (the checkbox rows): effective kind "task". */
export function planViewTasks(node: PlanViewNode): readonly PlanViewTask[] {
	return node.tasks.filter((task) => task.kind === "task");
}
