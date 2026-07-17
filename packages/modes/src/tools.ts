// Plan tools: deliverable, task, agent — flat-parameter tools for the deliverable-based
// execution model. The session/mode layer owns which plan is active; these
// tools perform mutations/reads and return readable markdown.

import { join } from "node:path";
import {
	type AgentToolResult,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	AGENT_KINDS,
	type AgentAssignmentRequest,
	type AgentKind,
	type AgentsCapabilityV1,
	DELIVERABLE_STATUSES,
	type DeliveryFailure,
	WORK_ITEM_KINDS,
	type WorkItemKind,
} from "@vegardx/pi-contracts";
import type { AgentBridge } from "./agent-bridge.js";
import type {
	AddAgentInput,
	AddDeliverableInput,
	AddWorkItemInput,
	PlanEngine,
} from "./engine.js";
import { buildKnowledgeSession, KNOWLEDGE_TEMPLATE } from "./exec/knowledge.js";
import { renderResearchIndex, researchReportsDir } from "./research.js";
import type {
	AgentMode,
	AgentSpec,
	Deliverable,
	Plan,
	ThinkingLevel,
	WorkItem,
} from "./schema.js";
import {
	deliverables,
	findDeliverable,
	hasExecutionStarted,
	slugify,
} from "./schema.js";
import { plansRoot } from "./storage.js";

export interface PlanToolDeps {
	readonly engine: () => PlanEngine | undefined;
	readonly agents?: () => AgentsCapabilityV1 | undefined;
	readonly onPlanChanged?: (plan: Plan) => void;
	readonly mode?: () => string;
	readonly steerAgent?: (deliverableId: string, guidance: string) => void;
	readonly onTaskToggle?: (deliverableId: string, taskId: string) => void;
	readonly seedContent?: () => string | undefined;
	readonly agentBridge?: () => AgentBridge | undefined;
	readonly agentDeliverableId?: () => string | undefined;
}

interface ToolDetails {
	readonly error?: string;
	readonly plan?: Plan;
	readonly deliverable?: Deliverable;
	readonly deliverables?: readonly Deliverable[];
	readonly workItem?: WorkItem;
	readonly workItems?: readonly WorkItem[];
	readonly agent?: AgentSpec;
	readonly workflow?: Plan["workflow"];
	readonly kinds?: unknown;
	readonly done?: boolean;
}

type Result = AgentToolResult<ToolDetails>;

// ─── Parameter schemas ───────────────────────────────────────────────────────

const DeliverableParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("update"),
		Type.Literal("remove"),
		Type.Literal("list"),
	]),
	id: Type.Optional(
		Type.String({
			description:
				"Deliverable id. On add: your preferred id (slugified + de-duped); " +
				"omit to derive it from the title. On update/remove: which " +
				"deliverable to target.",
		}),
	),
	title: Type.Optional(Type.String({ description: "Deliverable title." })),
	body: Type.Optional(
		Type.String({ description: "What ships when this merges." }),
	),
	status: Type.Optional(
		Type.Union(DELIVERABLE_STATUSES.map((s) => Type.Literal(s))),
	),
	failure: Type.Optional(
		Type.Object(
			{
				code: Type.String({ minLength: 1 }),
				message: Type.String({ minLength: 1 }),
				failedAt: Type.String({ minLength: 1 }),
				recoverable: Type.Boolean(),
				attempt: Type.Integer({ minimum: 1 }),
				agentId: Type.Optional(Type.String({ minLength: 1 })),
				cause: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
	),
	dependsOn: Type.Optional(
		Type.Array(Type.String(), {
			description: "Deliverable ids this one waits on.",
		}),
	),
	stacked: Type.Optional(
		Type.Boolean({
			description: "Branch from predecessor tip (default true).",
		}),
	),
	workspace: Type.Optional(
		Type.Union([Type.Literal("repo"), Type.Literal("scratch")], {
			description:
				'"repo" (default): worktree + branch, ships as a PR. "scratch": a ' +
				"plain directory for work not tied to any repo (creating repos, " +
				"provisioning, ops) — no branch, no PR; ships when its review gate " +
				"passes and its summary is recorded.",
		}),
	),
	repo: Type.Optional(
		Type.String({
			description:
				"Repo registry key this deliverable targets (see the repo tool); " +
				"omit for the plan's default repo. Not allowed with workspace=scratch.",
		}),
	),
	workerMode: Type.Optional(
		Type.Union([Type.Literal("full"), Type.Literal("read-only")]),
	),
	workerModel: Type.Optional(
		Type.String({
			description:
				"Exact provider/model id from the active worker role pool. Omit for its default.",
		}),
	),
	workerEffort: Type.Optional(
		Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
		]),
	),
	items: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Optional(
					Type.String({
						description:
							"Preferred id (slugified + de-duped). Give one so siblings " +
							"can reference it in `dependsOn`.",
					}),
				),
				title: Type.String({ description: "Deliverable title." }),
				body: Type.Optional(
					Type.String({ description: "What ships when this merges." }),
				),
				dependsOn: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Ids this one waits on: sibling ids from THIS batch (resolved " +
							"to their minted ids) or existing deliverable ids (passed " +
							"through). Order items dependencies-first.",
					}),
				),
				stacked: Type.Optional(
					Type.Boolean({
						description: "Branch from predecessor tip (default true).",
					}),
				),
				workspace: Type.Optional(
					Type.Union([Type.Literal("repo"), Type.Literal("scratch")]),
				),
				repo: Type.Optional(
					Type.String({
						description: "Repo registry key; omit for the plan's default repo.",
					}),
				),
				workerMode: Type.Optional(
					Type.Union([Type.Literal("full"), Type.Literal("read-only")], {
						description: "Default full.",
					}),
				),
				workerModel: Type.Optional(
					Type.String({
						description:
							"Exact provider/model id from the active worker role pool.",
					}),
				),
				workerEffort: Type.Optional(
					Type.Union([
						Type.Literal("off"),
						Type.Literal("minimal"),
						Type.Literal("low"),
						Type.Literal("medium"),
						Type.Literal("high"),
						Type.Literal("xhigh"),
					]),
				),
			}),
			{
				description:
					"BATCH add: create many deliverables in ONE call, in order. Use " +
					"this instead of one add per deliverable. Give each an explicit " +
					"`id` and reference those ids in `dependsOn` — sibling refs resolve " +
					"to the minted ids, existing-deliverable refs pass through. " +
					"All-or-nothing (a bad item rejects the whole batch). `add` only; " +
					"ignores the top-level title/body/dependsOn/etc.",
			},
		),
	),
});

const TaskParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("update"),
		Type.Literal("toggle"),
		Type.Literal("remove"),
	]),
	deliverableId: Type.Optional(
		Type.String({
			description:
				"Parent deliverable id. Worker agents: omit — your own deliverable is used automatically.",
		}),
	),
	taskId: Type.Optional(Type.String({ description: "Work-item id." })),
	title: Type.Optional(Type.String({ description: "Work-item title." })),
	body: Type.Optional(
		Type.String({
			description: "Work-item details — file paths, signatures, edge cases.",
		}),
	),
	kind: Type.Optional(Type.Union(WORK_ITEM_KINDS.map((k) => Type.Literal(k)))),
	answer: Type.Optional(
		Type.String({ description: "Decision answer for question items." }),
	),
	position: Type.Optional(
		Type.Number({ description: "0-based insertion position." }),
	),
	items: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String({ description: "Work-item title." }),
				body: Type.Optional(
					Type.String({
						description:
							"Work-item details — file paths, signatures, edge cases.",
					}),
				),
				kind: Type.Optional(
					Type.Union(WORK_ITEM_KINDS.map((k) => Type.Literal(k))),
				),
			}),
			{
				description:
					"BATCH add: create many work items in ONE call, in order. Use " +
					"this instead of one add per task. All-or-nothing (a bad item " +
					"rejects the whole batch). `add` only; ignores title/body/kind.",
			},
		),
	),
});

const AgentParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("update"),
		Type.Literal("remove"),
	]),
	deliverableId: Type.Optional(
		Type.String({ description: "Parent deliverable id." }),
	),
	name: Type.Optional(
		Type.String({ description: "Agent name (unique within deliverable)." }),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("full"), Type.Literal("read-only")]),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Exact provider/model id from the active worker role pool. Omit for its default.",
		}),
	),
	effort: Type.Optional(
		Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
		]),
	),
	focus: Type.Optional(
		Type.String({ description: "What this agent should focus on." }),
	),
	after: Type.Optional(
		Type.Array(Type.String(), {
			description: '"worker" or other agent names.',
		}),
	),
});

const WorkflowParams = Type.Object({
	action: Type.Union([
		Type.Literal("set"),
		Type.Literal("update-stage"),
		Type.Literal("list"),
		Type.Literal("options"),
	]),
	kind: Type.Optional(
		Type.Union(AGENT_KINDS.map((kind) => Type.Literal(kind))),
	),
	stageId: Type.Optional(Type.String()),
	after: Type.Optional(Type.Array(Type.String())),
	assignmentIds: Type.Optional(Type.Array(Type.String())),
	inputRevision: Type.Optional(Type.String()),
	inputContracts: Type.Optional(Type.Array(Type.String())),
	barrier: Type.Optional(
		Type.Union([Type.Literal("all"), Type.Literal("workers")]),
	),
	assignments: Type.Optional(
		Type.Array(
			Type.Object({
				agentId: Type.String(),
				kind: Type.Union(AGENT_KINDS.map((kind) => Type.Literal(kind))),
				focus: Type.String(),
				rationale: Type.String(),
				inputContracts: Type.Array(Type.String()),
				outputContracts: Type.Optional(Type.Array(Type.String())),
				model: Type.Optional(Type.String()),
				effort: Type.Optional(
					Type.Union([
						Type.Literal("off"),
						Type.Literal("minimal"),
						Type.Literal("low"),
						Type.Literal("medium"),
						Type.Literal("high"),
						Type.Literal("xhigh"),
					]),
				),
			}),
		),
	),
	stages: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
				after: Type.Array(Type.String()),
				assignmentIds: Type.Array(Type.String()),
				inputRevision: Type.String(),
				inputContracts: Type.Array(Type.String()),
				barrier: Type.Union([Type.Literal("all"), Type.Literal("workers")]),
			}),
		),
	),
});
const RepoParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("remove"),
		Type.Literal("list"),
	]),
	key: Type.Optional(
		Type.String({
			description: 'Registry key deliverables reference (e.g. "service").',
		}),
	),
	path: Type.Optional(
		Type.String({
			description:
				"Absolute path to the repo. For a late-bound repo (createdBy) this " +
				"is where it WILL live once its creator deliverable runs.",
		}),
	),
	defaultBranch: Type.Optional(
		Type.String({
			description: "Default branch; detected from the repo when omitted.",
		}),
	),
	createdBy: Type.Optional(
		Type.String({
			description:
				"Deliverable id expected to create this repo (a scratch " +
				"deliverable running e.g. `gh repo create` + clone). Add that " +
				"deliverable first; every deliverable targeting this repo must " +
				"depend on it.",
		}),
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

// ─── Tool constructors ───────────────────────────────────────────────────────

export function createPlanTools(deps: PlanToolDeps): ToolDefinition[] {
	return [
		createDeliverableTool(deps),
		createTaskTool(deps),
		createWorkflowTool(deps),
		createPlanTool(deps),
		createRepoTool(deps),
		createKnowledgeTool(deps),
	];
}

export function createDeliverableTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "deliverable",
		label: "Deliverable",
		description:
			"Manage work deliverables in the active plan: add, update, remove, list. " +
			"One repo deliverable = one branch = one PR; a scratch deliverable " +
			"(workspace=scratch) runs in a plain directory with no branch or PR — " +
			"for work not tied to any repo yet (creating repos, provisioning, ops).",
		promptSnippet:
			"deliverable — manage work deliverables (add/update/remove/list). One deliverable = one branch = one PR; workspace=scratch for non-repo work.",
		parameters: DeliverableParams,
		async execute(_id, params): Promise<Result> {
			if (!deps.engine() && deps.agentBridge?.()) {
				if (params.action === "list") {
					const content = await deps.agentBridge?.()?.planRead();
					if (content) return ok(content, {});
				}
				return error("agents cannot modify plan structure");
			}
			return withEngine(deps, (engine) => {
				const plan = engine.get();

				if (hasExecutionStarted(plan)) {
					if (params.id) {
						const target = findDeliverable(plan, params.id);
						if (target && target.status !== "planned") {
							if (params.action === "remove") {
								return error("cannot remove an active deliverable");
							}
							if (params.action === "update" && (params.title || params.body)) {
								return error(
									"cannot update title/body of an active deliverable",
								);
							}
						}
					}
				}

				switch (params.action) {
					case "add": {
						// Batch: create many deliverables in one call, all-or-nothing.
						// Two passes so `dependsOn` is order-independent: pass 1 mints
						// every id (deps withheld), building a handle→minted-id map;
						// pass 2 resolves each dependsOn through it — sibling handles
						// become minted ids, existing-deliverable refs pass through.
						if (params.items && params.items.length > 0) {
							if (params.items.some((i) => !i.title?.trim())) {
								return error("every batch item requires a title");
							}
							const idMap = new Map<string, string>();
							const created = params.items.map((i) => {
								const d = engine.addDeliverable({
									...(i.id ? { id: i.id } : {}),
									title: i.title,
									body: i.body,
									stacked: i.stacked,
									workspace: i.workspace,
									repo: i.repo,
									workerMode: i.workerMode ?? "full",
									workerModel: i.workerModel,
									workerEffort: i.workerEffort as ThinkingLevel | undefined,
								});
								// Map both the written handle and its slug form to the
								// minted id, so a dependsOn ref written either way resolves.
								const handle = i.id?.trim() || i.title;
								idMap.set(handle, d.id);
								idMap.set(slugify(handle), d.id);
								return d;
							});
							params.items.forEach((i, n) => {
								if (i.dependsOn && i.dependsOn.length > 0) {
									engine.updateDeliverable(created[n].id, {
										dependsOn: i.dependsOn.map((d) => idMap.get(d) ?? d),
									});
								}
							});
							notify(deps, engine);
							const fresh = created.map(
								(d) => findDeliverable(engine.get(), d.id) ?? d,
							);
							return ok(
								`✓ ${created.length} deliverables: ${created.map((d) => d.id).join(", ")}`,
								{ deliverables: fresh, plan: engine.get() },
							);
						}
						if (!params.title) return error("add requires title or items");
						if (!params.workerMode) return error("add requires workerMode");
						const input: AddDeliverableInput = {
							...(params.id ? { id: params.id } : {}),
							title: params.title,
							body: params.body,
							dependsOn: params.dependsOn,
							stacked: params.stacked,
							workspace: params.workspace,
							repo: params.repo,
							workerMode: params.workerMode,
							workerModel: params.workerModel,
							workerEffort: params.workerEffort as ThinkingLevel | undefined,
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
							dependsOn: params.dependsOn,
							stacked: params.stacked,
							workspace: params.workspace,
							repo: params.repo,
							workerMode: params.workerMode as AgentMode | undefined,
							workerModel: params.workerModel,
							workerEffort: params.workerEffort as ThinkingLevel | undefined,
						});
						if (params.status) {
							engine.setDeliverableStatus(
								params.id,
								params.status,
								params.failure as DeliveryFailure | undefined,
							);
						}
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
					case "list": {
						const rows = deliverables(engine.get());
						const text = rows.length
							? rows
									.map((g) => `- ${g.id}: ${g.status} — ${g.title}`)
									.join("\n")
							: "No deliverables.";
						return ok(text, { deliverables: rows, plan: engine.get() });
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
			"Manage work items in a deliverable: add, update, toggle, remove.",
		promptSnippet:
			"task — manage work items within a deliverable (add/update/toggle/remove).",
		parameters: TaskParams,
		async execute(_id, params): Promise<Result> {
			// Agent mode: forward mutations over RPC and await the result —
			// a fire-and-forget toggle here once reported success for task ids
			// that did not exist, wedging the completion gate.
			if (!deps.engine()) {
				const bridge = deps.agentBridge?.();
				if (bridge) {
					// The authenticated identity wins: agents may only mutate their own
					// deliverable, and models fill the optional param with "" or a slug
					// guessed from the deliverable title.
					const gId =
						deps.agentDeliverableId?.() ?? (params.deliverableId?.trim() || "");
					switch (params.action) {
						case "add": {
							// Batch: title-preflight is atomic (a bad item rejects the
							// whole batch before any add); the RPC adds are sequential, so
							// a mid-loop RPC failure is reported with a count, not rolled
							// back — the common failure (a missing title) still can't leave
							// a partial batch.
							if (params.items && params.items.length > 0) {
								if (params.items.some((i) => !i.title?.trim())) {
									return error("every batch item requires a title");
								}
								const ids: string[] = [];
								for (const i of params.items) {
									const r = await bridge.planMutate("addTask", gId, {
										title: i.title,
										body: i.body,
										kind: i.kind as WorkItemKind | undefined,
									});
									if (!r.success) {
										return error(
											`${r.error ?? "mutation failed"} (added ${ids.length}/${params.items.length})`,
										);
									}
									ids.push(r.taskId ?? "?");
								}
								return ok(`✓ ${ids.length} tasks: ${ids.join(", ")}`, {});
							}
							if (!params.title) return error("add requires title or items");
							const res = await bridge.planMutate("addTask", gId, {
								title: params.title,
								body: params.body,
								kind: params.kind as WorkItemKind | undefined,
							});
							if (!res.success) return error(res.error ?? "mutation failed");
							return ok(`✓ ${res.taskId}`, {});
						}
						case "update": {
							if (!params.taskId) return error("update requires taskId");
							const res = await bridge.planMutate("updateTask", gId, {
								taskId: params.taskId,
								title: params.title,
								body: params.body,
							});
							if (!res.success) return error(res.error ?? "mutation failed");
							return ok(`Updated task ${params.taskId}.`, {});
						}
						case "toggle": {
							if (!params.taskId) return error("toggle requires taskId");
							const res = await bridge.planMutate("toggleTask", gId, {
								taskId: params.taskId,
							});
							if (!res.success) return error(res.error ?? "mutation failed");
							return ok(`${params.taskId} marked done.`, { done: true });
						}
						case "remove":
							return error("agents cannot remove tasks");
					}
				}
				return error("no plan active — run /plan first to start one");
			}
			return withEngine(deps, (engine) => {
				const deliverableId = params.deliverableId;
				if (!deliverableId) return error("deliverableId is required");

				const plan = engine.get();
				if (hasExecutionStarted(plan)) {
					const g = findDeliverable(plan, deliverableId);
					if (g && g.status !== "planned" && params.action === "remove") {
						return error("cannot remove tasks from an active deliverable");
					}
				}

				switch (params.action) {
					case "add": {
						// Batch: create many items in one call, all-or-nothing.
						if (params.items && params.items.length > 0) {
							if (params.items.some((i) => !i.title?.trim())) {
								return error("every batch item requires a title");
							}
							const created = params.items.map((i, n) =>
								engine.addWorkItem(deliverableId, {
									title: i.title,
									body: i.body,
									kind: i.kind as WorkItemKind | undefined,
									position:
										params.position !== undefined
											? params.position + n
											: undefined,
								}),
							);
							notify(deps, engine);
							for (const item of created) {
								deps.steerAgent?.(
									deliverableId,
									`New task: "${item.title}". ${item.body ?? ""}`.trim(),
								);
							}
							return ok(
								`✓ ${created.length} tasks: ${created.map((i) => i.id).join(", ")}`,
								{ workItems: created, plan: engine.get() },
							);
						}
						if (!params.title) return error("add requires title or items");
						const input: AddWorkItemInput = {
							title: params.title,
							body: params.body,
							kind: params.kind as WorkItemKind | undefined,
							position: params.position,
						};
						const item = engine.addWorkItem(deliverableId, input);
						notify(deps, engine);
						deps.steerAgent?.(
							deliverableId,
							`New task: "${item.title}". ${item.body ?? ""}`.trim(),
						);
						return ok(`✓ ${item.id}`, { workItem: item, plan: engine.get() });
					}
					case "update": {
						if (!params.taskId) return error("update requires taskId");
						engine.updateWorkItem(deliverableId, params.taskId, {
							title: params.title,
							body: params.body,
							kind: params.kind as WorkItemKind | undefined,
							answer: params.answer,
						});
						notify(deps, engine);
						const g = findDeliverable(engine.get(), deliverableId);
						return ok(`Updated task ${params.taskId}.`, {
							workItem: g
								? (findDeliverable(engine.get(), deliverableId)?.tasks.find(
										(t) => t.id === params.taskId,
									) ?? undefined)
								: undefined,
							plan: engine.get(),
						});
					}
					case "toggle": {
						if (!params.taskId) return error("toggle requires taskId");
						const done = engine.toggleWorkItem(deliverableId, params.taskId);
						notify(deps, engine);
						return ok(
							`${params.taskId} is now ${done ? "done" : "not done"}.`,
							{
								done,
								plan: engine.get(),
							},
						);
					}
					case "remove": {
						if (!params.taskId) return error("remove requires taskId");
						engine.removeWorkItem(deliverableId, params.taskId);
						notify(deps, engine);
						return ok(`Removed task ${params.taskId}.`, { plan: engine.get() });
					}
				}
			});
		},
	}) as ToolDefinition;
}

export function createWorkflowTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "workflow",
		label: "Workflow",
		description:
			"Compose fully resolved assignments and explicit parallel stage DAGs atomically, inspect kinds/options, or update ordering.",
		promptSnippet:
			"workflow — inspect exact options and atomically set resolved assignments plus stages.",
		parameters: WorkflowParams,
		async execute(_id, params): Promise<Result> {
			const engine = deps.engine();
			if (!engine) return error("no plan active — run /plan first");
			const capability = deps.agents?.();
			switch (params.action) {
				case "list":
					return ok(
						engine.get().workflow
							? JSON.stringify(engine.get().workflow, null, 2)
							: "No workflow configured.",
						{ workflow: engine.get().workflow },
					);
				case "options": {
					if (!capability) return error("agents.v1 is unavailable");
					if (params.kind) {
						const options = await capability.options(params.kind as AgentKind);
						return ok(JSON.stringify(options, null, 2), { kinds: options });
					}
					const kinds = await Promise.all(
						capability
							.kinds()
							.filter((kind) => kind.id !== "host")
							.map(async (kind) => capability.options(kind.id)),
					);
					return ok(JSON.stringify(kinds, null, 2), { kinds });
				}
				case "set": {
					if (!capability) return error("agents.v1 is unavailable");
					if (!params.assignments || !params.stages)
						return error("set requires assignments and stages");
					const requests = params.assignments as AgentAssignmentRequest[];
					const assignments = await Promise.all(
						requests.map((request) => capability.resolve(request)),
					);
					engine.setWorkflow({ assignments, stages: params.stages });
					notify(deps, engine);
					return ok(
						`Configured ${assignments.length} resolved assignments in ${params.stages.length} stages.`,
						{ workflow: engine.get().workflow, plan: engine.get() },
					);
				}
				case "update-stage": {
					if (!params.stageId) return error("update-stage requires stageId");
					engine.updateWorkflowStage(params.stageId, {
						after: params.after,
						assignmentIds: params.assignmentIds,
						inputRevision: params.inputRevision,
						inputContracts: params.inputContracts,
						barrier: params.barrier,
					});
					notify(deps, engine);
					return ok(`Updated workflow stage ${params.stageId}.`, {
						workflow: engine.get().workflow,
						plan: engine.get(),
					});
				}
			}
		},
	}) as ToolDefinition;
}

export function createAgentTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "agent",
		label: "Agent",
		description:
			"Manage support agents within a deliverable: add, update, remove.",
		promptSnippet:
			"agent — manage support agents in a deliverable (add/update/remove).",
		parameters: AgentParams,
		async execute(_id, params): Promise<Result> {
			if (!deps.engine() && deps.agentBridge?.()) {
				return error("agents cannot modify plan structure");
			}
			return withEngine(deps, (engine) => {
				const plan = engine.get();
				const deliverableId = params.deliverableId;
				if (!deliverableId) return error("deliverableId is required");

				if (hasExecutionStarted(plan)) {
					const g = findDeliverable(plan, deliverableId);
					if (g && g.status !== "planned") {
						return error("cannot modify agents in an active deliverable");
					}
				}

				switch (params.action) {
					case "add": {
						if (!params.name) return error("add requires name");
						if (!params.mode) return error("add requires mode");
						if (!params.effort) return error("add requires effort");
						if (!params.focus) return error("add requires focus");
						const input: AddAgentInput = {
							name: params.name,
							mode: params.mode,
							model: params.model,
							effort: params.effort as ThinkingLevel | undefined,
							focus: params.focus,
							after: params.after ?? [],
						};
						const agent = engine.addAgent(deliverableId, input);
						notify(deps, engine);
						return ok(`✓ ${deliverableId}/${agent.name}`, {
							agent,
							plan: engine.get(),
						});
					}
					case "update": {
						if (!params.name) return error("update requires name");
						engine.updateAgent(deliverableId, params.name, {
							mode: params.mode as AgentMode | undefined,
							model: params.model,
							effort: params.effort as ThinkingLevel | undefined,
							focus: params.focus,
							after: params.after,
						});
						notify(deps, engine);
						const g = findDeliverable(engine.get(), deliverableId);
						return ok(`Updated agent ${params.name}.`, {
							agent: g?.agents.find((a) => a.name === params.name) ?? undefined,
							plan: engine.get(),
						});
					}
					case "remove": {
						if (!params.name) return error("remove requires name");
						engine.removeAgent(deliverableId, params.name);
						notify(deps, engine);
						return ok(`Removed agent ${params.name}.`, { plan: engine.get() });
					}
				}
			});
		},
	}) as ToolDefinition;
}

const KnowledgeParams = Type.Object({
	content: Type.String({
		description:
			"The complete codebase reference document. It MUST follow this exact " +
			"skeleton — the leading `# Codebase Reference` header, the " +
			"`> CONTEXT ONLY` framing line, and every `## ` section — or it is " +
			"rejected:\n\n" +
			`${KNOWLEDGE_TEMPLATE}\n\n` +
			"Fill each section with reference material only — where things are and " +
			"how they connect, not full file contents. Keep the section headings " +
			"verbatim.",
	}),
});

export function createKnowledgeTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "knowledge",
		label: "Knowledge",
		description:
			"Write the plan's base-knowledge document — the frozen codebase " +
			"reference every agent forks from. Call this once, at the end of " +
			"planning, distilling your codebase understanding into the template " +
			"sections. Frozen after execution starts (rewrites would invalidate every " +
			"agent's cache prefix).",
		promptSnippet:
			"knowledge — write the shared codebase reference agents fork from.",
		parameters: KnowledgeParams,
		async execute(_id, params): Promise<Result> {
			const engine = deps.engine();
			if (!engine) return error("no plan active — run /plan first");
			const plan = engine.get();
			if (hasExecutionStarted(plan)) {
				return error(
					"execution has started — the knowledge base is frozen (rewriting it would invalidate every agent's cache prefix)",
				);
			}
			const planDir = join(plansRoot(), plan.slug);
			const outPath = join(planDir, "base-knowledge.jsonl");
			// Mechanical: the ref index of on-disk research reports is appended
			// by the system, not authored — agents dig(ref) full reports on
			// demand instead of the doc carrying every deep-dive.
			const researchIndex = renderResearchIndex(researchReportsDir(planDir));
			try {
				buildKnowledgeSession({
					content: params.content,
					repoPath: plan.repoPath,
					outPath,
					...(researchIndex ? { researchIndex } : {}),
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				return error(
					`knowledge document rejected: ${message}\n\nTemplate:\n${KNOWLEDGE_TEMPLATE}`,
				);
			}
			return ok(
				`Knowledge base written to ${outPath}${
					researchIndex ? " (research index auto-appended)" : ""
				}. All agents will fork from it; it freezes when execution starts.`,
				{},
			);
		},
	}) as ToolDefinition;
}

export function createRepoTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "repo",
		label: "Repo",
		description:
			"Manage the plan's repo registry: add, remove, list. Deliverables " +
			"target a registry key via their `repo` field (default: the repo the " +
			"plan started in). A repo may be late-bound (`createdBy` = the " +
			"deliverable that creates it) — its path materializes during execution.",
		promptSnippet:
			"repo — manage the plan's repo registry (add/remove/list); createdBy marks a repo a deliverable will create.",
		parameters: RepoParams,
		async execute(_id, params): Promise<Result> {
			if (!deps.engine() && deps.agentBridge?.()) {
				return error("agents cannot modify the repo registry");
			}
			return withEngine(deps, (engine) => {
				switch (params.action) {
					case "add": {
						if (!params.key || !params.path) {
							return error("add requires key and path");
						}
						engine.registerRepo({
							key: params.key,
							path: params.path,
							...(params.defaultBranch
								? { defaultBranch: params.defaultBranch }
								: {}),
							...(params.createdBy ? { createdBy: params.createdBy } : {}),
						});
						notify(deps, engine);
						return ok(`✓ repo ${params.key} → ${params.path}`, {
							plan: engine.get(),
						});
					}
					case "remove": {
						if (!params.key) return error("remove requires key");
						engine.unregisterRepo(params.key);
						notify(deps, engine);
						return ok(`Removed repo ${params.key}.`, { plan: engine.get() });
					}
					case "list": {
						const plan = engine.get();
						const rows = [
							`- default: ${plan.repoPath}`,
							...(plan.repos ?? []).map(
								(r) =>
									`- ${r.key}: ${r.path}${r.defaultBranch ? ` (${r.defaultBranch})` : ""}${r.createdBy ? ` — created by \`${r.createdBy}\`` : ""}`,
							),
						];
						return ok(rows.join("\n"), { plan });
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
		description: "Read the active plan as markdown, seed text, or JSON.",
		promptSnippet: "plan — read the active plan; does not mutate state.",
		parameters: PlanParams,
		async execute(_id, params): Promise<Result> {
			const engine = deps.engine();
			if (!engine) {
				const bridge = deps.agentBridge?.();
				if (bridge) {
					try {
						const content = await deps.agentBridge?.()?.planRead();
						if (content) return ok(content, {});
					} catch {
						// Fall through to seed
					}
				}
				const seed = deps.seedContent?.();
				if (seed) return ok(seed, {});
				return error("no plan active — run /plan first to start one");
			}
			const plan = engine.get();
			if (params.view === "json") {
				return ok(`\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``, {
					plan,
				});
			}
			// TODO: implement renderPlanMarkdown / renderPlanSeed for deliverable model
			const text = deliverables(plan).length
				? deliverables(plan)
						.map((g) => `- ${g.id}: ${g.status} — ${g.title}`)
						.join("\n")
				: "No deliverables.";
			const workflow = plan.workflow;
			const workflowText = workflow
				? [
						"",
						"## Workflow",
						...workflow.stages.map(
							(stage) =>
								`- ${stage.id} after [${stage.after.join(", ") || "root"}] @ ${stage.inputRevision}: ${stage.assignmentIds.join(", ")} (${stage.barrier} barrier)`,
						),
						...workflow.assignments.map(
							(assignment) =>
								`  - ${assignment.agentId}: ${assignment.kind} · ${assignment.modelId}@${assignment.effort ?? "default"} — ${assignment.focus}`,
						),
					].join("\n")
				: "";
			return ok(`${text}${workflowText}`, { plan });
		},
	}) as ToolDefinition;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
