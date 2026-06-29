// Plan tools: a thin host-tool facade over PlanEngine. The session/mode layer
// owns which plan is active; these tools only ask for the current engine,
// perform a mutation/read, and return readable markdown plus structured
// details for tests and downstream automation.

import {
	type AgentToolResult,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	DELIVERABLE_STATUSES,
	WORK_ITEM_KINDS,
	type WorkItemKind,
} from "@vegardx/pi-contracts";
import {
	type AddDeliverableInput,
	type AddWorkItemInput,
	PLAN_CONTAINER,
	type PlanEngine,
} from "./engine.js";
import {
	renderPlanMarkdown,
	renderPlanSeed,
	renderPlanSummary,
} from "./markdown.js";
import {
	type Deliverable,
	deliverables,
	findDeliverable,
	findNode,
	isWorkItem,
	type Plan,
	type WorkItem,
} from "./schema.js";

export interface PlanToolDeps {
	/** Current active plan engine; child 3 wires this to mode/session state. */
	readonly engine: () => PlanEngine | undefined;
	/** Notification hook used later by widgets/events. */
	readonly onPlanChanged?: (plan: Plan) => void;
	/** Current mode; used to restrict plan views in plan mode. */
	readonly mode?: () => string;
	/** Steer a running worker when its deliverable is mutated. */
	readonly steerAgent?: (deliverableId: string, guidance: string) => void;
}

interface ToolDetails {
	readonly error?: string;
	readonly plan?: Plan;
	readonly deliverable?: Deliverable;
	readonly deliverables?: readonly Deliverable[];
	readonly workItem?: WorkItem;
	readonly done?: boolean;
}

type Result = AgentToolResult<ToolDetails>;

const DeliverableParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("update"),
		Type.Literal("remove"),
		Type.Literal("reorder"),
		Type.Literal("list"),
		Type.Literal("register-repo"),
		Type.Literal("unregister-repo"),
	]),
	id: Type.Optional(Type.String({ description: "Deliverable id." })),
	title: Type.Optional(Type.String({ description: "Deliverable title." })),
	body: Type.Optional(
		Type.String({ description: "What ships when this merges." }),
	),
	status: Type.Optional(
		Type.Union(DELIVERABLE_STATUSES.map((s) => Type.Literal(s))),
	),
	parentId: Type.Optional(
		Type.String({ description: "Parent grouping deliverable id." }),
	),
	dependsOn: Type.Optional(
		Type.Array(Type.String(), {
			description: "At most one stacking parent id. Use [] for a root.",
		}),
	),
	branch: Type.Optional(
		Type.String({ description: "Branch claimed by this deliverable." }),
	),
	lifecycle: Type.Optional(
		Type.Union([Type.Literal("pre"), Type.Literal("post")]),
	),
	position: Type.Optional(
		Type.Number({ description: "0-based sibling position." }),
	),
	repo: Type.Optional(
		Type.String({
			description:
				'On add/update: registry key of the repo this deliverable targets ("default" clears it). On register-repo/unregister-repo: the repo key.',
		}),
	),
	repoPath: Type.Optional(
		Type.String({ description: "register-repo: absolute path to the repo." }),
	),
	repoDefaultBranch: Type.Optional(
		Type.String({ description: "register-repo: cached default branch." }),
	),
});

const TaskParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("update"),
		Type.Literal("toggle"),
		Type.Literal("remove"),
		Type.Literal("move"),
	]),
	id: Type.Optional(Type.String({ description: "Work-item id." })),
	deliverableId: Type.Optional(
		Type.String({
			description: "Container deliverable id, or @plan for loose items.",
		}),
	),
	title: Type.Optional(Type.String({ description: "Work-item title." })),
	body: Type.Optional(Type.String({ description: "Work-item details." })),
	kind: Type.Optional(Type.Union(WORK_ITEM_KINDS.map((k) => Type.Literal(k)))),
	answer: Type.Optional(
		Type.String({ description: "Decision answer for question items." }),
	),
	targetDeliverableId: Type.Optional(
		Type.String({ description: "Move target deliverable id, or @plan." }),
	),
	position: Type.Optional(
		Type.Number({ description: "0-based insertion position." }),
	),
});

const PlanParams = Type.Object({
	view: Type.Optional(
		Type.Union([
			Type.Literal("markdown"),
			Type.Literal("seed"),
			Type.Literal("json"),
		]),
	),
	activeDeliverableId: Type.Optional(
		Type.String({ description: "Seed focus deliverable id." }),
	),
});

export function createPlanTools(deps: PlanToolDeps): ToolDefinition[] {
	return [
		createDeliverableTool(deps),
		createTaskTool(deps),
		createPlanTool(deps),
	];
}

export function createDeliverableTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "deliverable",
		label: "Deliverable",
		description:
			"Manage the active Maestro plan's deliverables and repo registry: add, update, remove, reorder, list, register-repo, unregister-repo.",
		promptSnippet:
			"deliverable — manage plan deliverables + repo registry (add/update/remove/reorder/list/register-repo/unregister-repo).",
		parameters: DeliverableParams,
		async execute(_id, params): Promise<Result> {
			return withEngine(deps, (engine) => {
				switch (params.action) {
					case "add": {
						if (!params.title) return error("add requires title");
						const input: AddDeliverableInput = {
							title: params.title,
							body: params.body,
							parentId: params.parentId,
							dependsOn: params.dependsOn,
							lifecycle: params.lifecycle,
							position: params.position,
							repo: params.repo === "default" ? undefined : params.repo,
						};
						const deliverable = engine.addDeliverable(input);
						notify(deps, engine);
						return ok(`✓ ${deliverable.id}`, {
							deliverable,
							plan: engine.get(),
						});
					}
					case "update": {
						if (!params.id) return error("update requires id");
						engine.updateDeliverable(params.id, {
							title: params.title,
							body: params.body,
							branch: params.branch,
							dependsOn: params.dependsOn,
							lifecycle: params.lifecycle,
							...(params.repo !== undefined && {
								repo: params.repo === "default" ? undefined : params.repo,
							}),
						});
						if (params.status) engine.setStatus(params.id, params.status);
						notify(deps, engine);
						return ok(`Updated deliverable ${params.id}.`, {
							deliverable:
								findDeliverable(engine.get(), params.id) ?? undefined,
							plan: engine.get(),
						});
					}
					case "remove": {
						if (!params.id) return error("remove requires id");
						engine.removeDeliverable(params.id);
						notify(deps, engine);
						return ok(`Removed deliverable ${params.id}.`, {
							plan: engine.get(),
						});
					}
					case "reorder": {
						if (!params.id) return error("reorder requires id");
						if (params.position === undefined)
							return error("reorder requires position");
						engine.reorderDeliverable(params.id, params.position);
						notify(deps, engine);
						return ok(`Reordered deliverable ${params.id}.`, {
							plan: engine.get(),
						});
					}
					case "list": {
						const rows = deliverables(engine.get());
						const text = rows.length
							? rows
									.map((d) => `- ${d.id}: ${d.status} — ${d.title}`)
									.join("\n")
							: "No deliverables.";
						return ok(text, { deliverables: rows, plan: engine.get() });
					}
					case "register-repo": {
						if (!params.repo) return error("register-repo requires repo (key)");
						if (!params.repoPath)
							return error("register-repo requires repoPath");
						engine.registerRepo({
							key: params.repo,
							path: params.repoPath,
							defaultBranch: params.repoDefaultBranch,
						});
						notify(deps, engine);
						return ok(`Registered repo ${params.repo}.`, {
							plan: engine.get(),
						});
					}
					case "unregister-repo": {
						if (!params.repo)
							return error("unregister-repo requires repo (key)");
						engine.unregisterRepo(params.repo);
						notify(deps, engine);
						return ok(`Unregistered repo ${params.repo}.`, {
							plan: engine.get(),
						});
					}
				}
			});
		},
	}) as ToolDefinition;
}

export function createTaskTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "task",
		label: "Task",
		description:
			"Manage work items in the active Maestro plan: add, update, toggle, remove, move.",
		promptSnippet:
			"task — manage plan work-items (task/followup/question/manual).",
		parameters: TaskParams,
		async execute(_id, params): Promise<Result> {
			return withEngine(deps, (engine) => {
				switch (params.action) {
					case "add": {
						const container = params.deliverableId ?? PLAN_CONTAINER;
						if (!params.title) return error("add requires title");
						const input: AddWorkItemInput = {
							title: params.title,
							body: params.body,
							kind: params.kind as WorkItemKind | undefined,
							position: params.position,
						};
						const workItem = engine.addWorkItem(container, input);
						notify(deps, engine);
						if (container !== PLAN_CONTAINER) {
							deps.steerAgent?.(
								container,
								`New task: "${workItem.title}". ${workItem.body ?? ""}`.trim(),
							);
						}
						return ok(`✓ ${workItem.id}`, {
							workItem,
							plan: engine.get(),
						});
					}
					case "update": {
						if (!params.id) return error("update requires id");
						engine.updateWorkItem(params.id, {
							title: params.title,
							body: params.body,
							kind: params.kind as WorkItemKind | undefined,
							answer: params.answer,
						});
						notify(deps, engine);
						return ok(`Updated work item ${params.id}.`, {
							workItem: workItem(engine.get(), params.id),
							plan: engine.get(),
						});
					}
					case "toggle": {
						if (!params.id) return error("toggle requires id");
						const done = engine.toggleWorkItem(params.id);
						notify(deps, engine);
						return ok(`${params.id} is now ${done ? "done" : "not done"}.`, {
							done,
							workItem: workItem(engine.get(), params.id),
							plan: engine.get(),
						});
					}
					case "remove": {
						if (!params.id) return error("remove requires id");
						engine.removeWorkItem(params.id);
						notify(deps, engine);
						return ok(`Removed work item ${params.id}.`, {
							plan: engine.get(),
						});
					}
					case "move": {
						if (!params.id) return error("move requires id");
						const target = params.targetDeliverableId ?? params.deliverableId;
						if (!target) return error("move requires targetDeliverableId");
						engine.moveWorkItem(params.id, target);
						notify(deps, engine);
						return ok(`Moved work item ${params.id} to ${target}.`, {
							plan: engine.get(),
						});
					}
				}
			});
		},
	}) as ToolDefinition;
}

export function createPlanTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "plan",
		label: "Plan",
		description:
			"Read the active Maestro plan as markdown, deterministic seed text, or JSON.",
		promptSnippet: "plan — read the active plan; does not mutate state.",
		parameters: PlanParams,
		async execute(_id, params): Promise<Result> {
			return withEngine(deps, (engine) => {
				const plan = engine.get();
				if (params.view === "json") {
					if (deps.mode?.() === "plan") {
						return ok(renderPlanSummary(plan), { plan });
					}
					return ok(`\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``, {
						plan,
					});
				}
				if (params.view === "seed") {
					return ok(renderPlanSeed(plan, params.activeDeliverableId), { plan });
				}
				if (params.view === "markdown") {
					if (deps.mode?.() === "plan") {
						return ok(renderPlanSummary(plan), { plan });
					}
					return ok(renderPlanMarkdown(plan), { plan });
				}
				return ok(renderPlanSummary(plan), { plan });
			});
		},
	}) as ToolDefinition;
}

function withEngine(
	deps: PlanToolDeps,
	fn: (engine: PlanEngine) => Result,
): Result {
	const engine = deps.engine();
	if (!engine) return error("no plan active — run /plan first to start one");
	try {
		return fn(engine);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return error(message);
	}
}

function ok(text: string, details: ToolDetails): Result {
	return { content: [{ type: "text", text }], details };
}

function error(message: string): Result {
	return {
		content: [{ type: "text", text: message }],
		details: { error: message },
	};
}

function notify(deps: PlanToolDeps, engine: PlanEngine): void {
	deps.onPlanChanged?.(engine.get());
}

function workItem(plan: Plan, id: string): WorkItem | undefined {
	const node = findNode(plan, id);
	return node && isWorkItem(node) ? node : undefined;
}
