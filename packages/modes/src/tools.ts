// Plan tools: deliverable, task, agent — flat-parameter tools for the deliverable-based
// execution model, ported onto PlanEngineV2 (v1→v2 flip, S3). The tool names and
// external parameter names are UNCHANGED for wire compat: "deliverable" manages
// ROOT NODES of the v2 tree, "task" manages a node's tasks, "agent" manages
// CHILD NODES (v1 support agents became first-class nodes). The session/mode
// layer owns which plan is active; these tools perform mutations/reads and
// return readable markdown.

import {
	type AgentToolResult,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	type AgentsCapabilityV1,
	DELIVERABLE_STATUSES,
	type DeliveryFailure,
	type NodeAgentType,
	type NodeTaskKind,
	WORK_ITEM_KINDS,
	type WorkItemKind,
} from "@vegardx/pi-contracts";
import type { AgentBridge } from "./agent-bridge.js";
import type { NodeInput, PlanEngineV2 } from "./plan/engine.js";
// slugify still lives in the v1 schema module; it moves to plan/schema.ts in S8.
import {
	defaultBranchForNode,
	findNodeV2,
	isBranchOwner,
	type NodeTask,
	PARENT_AFTER_TOKEN,
	type PlanNode,
	type PlanV2,
	slugify,
	walkNodes,
} from "./plan/schema.js";

export interface PlanToolDeps {
	readonly engine: () => PlanEngineV2 | undefined;
	/** Legacy workflow capability — unused since the workflow tool retired
	 *  with v1's AgentWorkflow; kept so existing wiring keeps compiling until
	 *  the runtime sweep drops it. */
	readonly agents?: () => AgentsCapabilityV1 | undefined;
	readonly onPlanChanged?: (plan: PlanV2) => void;
	readonly mode?: () => string;
	readonly steerAgent?: (deliverableId: string, guidance: string) => void;
	readonly onTaskToggle?: (deliverableId: string, taskId: string) => void;
	readonly seedContent?: () => string | undefined;
	readonly agentBridge?: () => AgentBridge | undefined;
	readonly agentDeliverableId?: () => string | undefined;
}

interface ToolDetails {
	readonly error?: string;
	readonly plan?: PlanV2;
	readonly deliverable?: PlanNode;
	readonly deliverables?: readonly PlanNode[];
	readonly workItem?: NodeTask;
	readonly workItems?: readonly NodeTask[];
	readonly agent?: PlanNode;
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
	summary: Type.Optional(
		Type.String({
			description:
				"Toggle of the postflight task only: the deliverable's downstream " +
				"handoff — concise (under 500 words), covering what was built, public " +
				"interfaces, key decisions, invariants, and gotchas for dependents.",
		}),
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
		Type.Literal("ensemble"),
	]),
	deliverableId: Type.Optional(
		Type.String({ description: "Parent deliverable id." }),
	),
	candidates: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String({ description: "Candidate title." }),
				focus: Type.String({
					description: "What this candidate should implement.",
				}),
			}),
			{
				minItems: 2,
				description:
					"ensemble only: the competing candidate implementations (≥2).",
			},
		),
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
		createPlanTool(deps),
		createRepoTool(deps),
	];
}

/** Root-node creation shared by single and batch add: mint the node, then
 *  give repo-workspace nodes their branch (+ base for stacked:false) in a
 *  second patch — the branch name derives from the MINTED id. `after` is
 *  applied by the caller (batch resolves sibling handles in a second pass). */
function addRootNode(
	engine: PlanEngineV2,
	input: {
		id?: string;
		title: string;
		body?: string;
		workspace?: "repo" | "scratch";
		stacked?: boolean;
		repo?: string;
	},
): PlanNode {
	const preferred = preferredNodeId(engine.get(), input.id);
	const node = engine.addNode(null, {
		...(preferred ? { id: preferred } : {}),
		agent: "worker",
		persona: "coder",
		title: input.title,
		...(input.body ? { body: input.body } : {}),
		...(input.repo ? { repo: input.repo } : {}),
	});
	if (input.workspace !== "scratch") {
		// v1 workspace=repo: the node owns a branch and ships one PR from it.
		// stacked:false → base "default-branch" (fork from main, not the chain).
		engine.updateNode(node.id, {
			branch: defaultBranchForNode(node),
			...(input.stacked === false ? { base: "default-branch" } : {}),
		});
	}
	return findNodeV2(engine.get(), node.id) ?? node;
}

/** v1 addDeliverable slugified + de-duped a preferred id; v2 addNode takes
 *  ids verbatim. Slugify here, and fall back to engine minting (from the
 *  title) when the slug is empty or already taken. */
function preferredNodeId(
	plan: PlanV2,
	raw: string | undefined,
): string | undefined {
	const id = raw ? slugify(raw) : "";
	if (!id) return undefined;
	for (const { node } of walkNodes(plan)) if (node.id === id) return undefined;
	return id;
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
								const d = addRootNode(engine, {
									...(i.id?.trim() ? { id: i.id } : {}),
									title: i.title,
									body: i.body,
									stacked: i.stacked,
									workspace: i.workspace,
									repo: i.repo,
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
									engine.updateNode(created[n].id, {
										after: i.dependsOn.map((d) => idMap.get(d) ?? d),
									});
								}
							});
							notify(deps, engine);
							const fresh = created.map(
								(d) => findNodeV2(engine.get(), d.id) ?? d,
							);
							return ok(
								`✓ ${created.length} deliverables: ${created.map((d) => d.id).join(", ")}`,
								{ deliverables: fresh, plan: engine.get() },
							);
						}
						if (!params.title) return error("add requires title or items");
						const node = addRootNode(engine, {
							...(params.id ? { id: params.id } : {}),
							title: params.title,
							body: params.body,
							stacked: params.stacked,
							workspace: params.workspace,
							repo: params.repo,
						});
						if (params.dependsOn && params.dependsOn.length > 0) {
							engine.updateNode(node.id, { after: [...params.dependsOn] });
						}
						notify(deps, engine);
						return ok(`✓ ${node.id}`, {
							deliverable: findNodeV2(engine.get(), node.id) ?? node,
							plan: engine.get(),
						});
					}
					case "update": {
						if (!params.id) return error("update requires id");
						const current = findNodeV2(engine.get(), params.id);
						if (!current) return error(`unknown deliverable: ${params.id}`);
						if (params.workspace === "scratch" && isBranchOwner(current)) {
							return error(
								"cannot change workspace after add — remove and re-add the deliverable",
							);
						}
						engine.updateNode(params.id, {
							title: params.title,
							body: params.body,
							after: params.dependsOn,
							repo: params.repo,
							...(params.stacked === false ? { base: "default-branch" } : {}),
							...(params.workspace === "repo" && !isBranchOwner(current)
								? { branch: defaultBranchForNode(current) }
								: {}),
						});
						if (params.status) {
							engine.setNodeStatus(
								params.id,
								params.status,
								params.failure as DeliveryFailure | undefined,
							);
						}
						notify(deps, engine);
						return ok(`Updated deliverable ${params.id}.`, {
							deliverable: findNodeV2(engine.get(), params.id) ?? undefined,
							plan: engine.get(),
						});
					}
					case "remove": {
						if (!params.id) return error("remove requires id");
						engine.removeNode(params.id);
						notify(deps, engine);
						return ok(`Removed deliverable ${params.id}.`, {
							plan: engine.get(),
						});
					}
					case "list": {
						const plan = engine.get();
						const text = renderNodeTree(plan);
						return ok(text, { deliverables: plan.nodes, plan });
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
			// Lifecycle kinds are harness-injected at activation; authoring or
			// re-kinding them by hand would corrupt the handoff protocol.
			const authoredKinds = [
				params.kind,
				...(params.items ?? []).map((i) => i.kind),
			];
			if (
				(params.action === "add" || params.action === "update") &&
				authoredKinds.some((k) => k === "preflight" || k === "postflight")
			) {
				return error(
					"preflight/postflight are harness-managed lifecycle tasks and cannot be authored",
				);
			}
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
								summary: params.summary,
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

				switch (params.action) {
					case "add": {
						// Batch: create many items in one call, all-or-nothing.
						if (params.items && params.items.length > 0) {
							if (params.items.some((i) => !i.title?.trim())) {
								return error("every batch item requires a title");
							}
							const created = params.items.map((i) =>
								engine.addTask(deliverableId, {
									title: i.title,
									...(i.body !== undefined ? { body: i.body } : {}),
									...(i.kind ? { kind: i.kind as NodeTaskKind } : {}),
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
						const item = engine.addTask(deliverableId, {
							title: params.title,
							...(params.body !== undefined ? { body: params.body } : {}),
							...(params.kind ? { kind: params.kind as NodeTaskKind } : {}),
						});
						notify(deps, engine);
						deps.steerAgent?.(
							deliverableId,
							`New task: "${item.title}". ${item.body ?? ""}`.trim(),
						);
						return ok(`✓ ${item.id}`, { workItem: item, plan: engine.get() });
					}
					case "update": {
						if (!params.taskId) return error("update requires taskId");
						engine.updateTask(deliverableId, params.taskId, {
							title: params.title,
							body: params.body,
							answer: params.answer,
						});
						notify(deps, engine);
						return ok(`Updated task ${params.taskId}.`, {
							workItem:
								findNodeV2(engine.get(), deliverableId)?.tasks.find(
									(t) => t.id === params.taskId,
								) ?? undefined,
							plan: engine.get(),
						});
					}
					case "toggle": {
						if (!params.taskId) return error("toggle requires taskId");
						engine.toggleTask(
							deliverableId,
							params.taskId,
							params.summary,
							params.answer,
						);
						notify(deps, engine);
						const done =
							findNodeV2(engine.get(), deliverableId)?.tasks.find(
								(t) => t.id === params.taskId,
							)?.done ?? false;
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
						engine.removeTask(deliverableId, params.taskId);
						notify(deps, engine);
						return ok(`Removed task ${params.taskId}.`, { plan: engine.get() });
					}
				}
			});
		},
	}) as ToolDefinition;
}

/** Focus text that reads as research → explorer; anything review-ish (the
 *  default) → reviewer. Both are read agents, matching v1 mode:read-only. */
function inferSupportAgentType(name: string, focus: string): NodeAgentType {
	const text = `${name} ${focus}`;
	return /\b(research|explor\w*|investigat\w*|survey|spike|benchmark|map out|understand)\b/i.test(
		text,
	)
		? "explorer"
		: "reviewer";
}

/** Resolve a v1-style agent name to a child node: minted id, slug of the
 *  name, or title match (add uses the name as the child's title). */
function findSupportAgent(parent: PlanNode, name: string): PlanNode | null {
	return (
		(parent.children ?? []).find(
			(c) => c.id === name || c.id === slugify(name) || c.title === name,
		) ?? null
	);
}

/** v1 agent `after` referenced "worker" (the deliverable's own worker) or
 *  sibling agent names; v2 children order on siblings + the "parent" token. */
function mapAgentAfter(parent: PlanNode, after: readonly string[]): string[] {
	return after.map((ref) => {
		if (ref === "worker") return PARENT_AFTER_TOKEN;
		const sibling = findSupportAgent(parent, ref);
		return sibling ? sibling.id : ref;
	});
}

export function createAgentTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "agent",
		label: "Agent",
		description:
			"Manage support agents within a deliverable: add, update, remove. ensemble authors N competing worker candidates under a branch-owning deliverable (a bake-off) and makes the parent their integrator.",
		promptSnippet:
			"agent — manage support agents (add/update/remove) or ensemble (author competing worker candidates) in a deliverable.",
		parameters: AgentParams,
		async execute(_id, params): Promise<Result> {
			if (!deps.engine() && deps.agentBridge?.()) {
				return error("agents cannot modify plan structure");
			}
			return withEngine(deps, (engine) => {
				const deliverableId = params.deliverableId;
				if (!deliverableId) return error("deliverableId is required");
				const parent = findNodeV2(engine.get(), deliverableId);
				if (!parent) return error(`unknown deliverable: ${deliverableId}`);

				switch (params.action) {
					case "add": {
						if (!params.name) return error("add requires name");
						if (!params.focus) return error("add requires focus");
						const agent = inferSupportAgentType(params.name, params.focus);
						const input: NodeInput = {
							agent,
							persona: agent === "explorer" ? "researcher" : "reviewer",
							title: params.name,
							tasks: [params.focus],
							...(params.after && params.after.length > 0
								? { after: mapAgentAfter(parent, params.after) }
								: {}),
						};
						// Pre-start: normal authoring. Post-start: the ONE dynamic
						// structure operation (write-ahead append).
						const child = engine.hasExecutionStarted()
							? engine.appendChild(deliverableId, input, "plan")
							: engine.addNode(deliverableId, input);
						notify(deps, engine);
						return ok(`✓ ${deliverableId}/${child.id}`, {
							agent: child,
							plan: engine.get(),
						});
					}
					case "update": {
						if (!params.name) return error("update requires name");
						const child = findSupportAgent(parent, params.name);
						if (!child) {
							return error(`unknown agent: ${deliverableId}/${params.name}`);
						}
						if (params.after) {
							engine.updateNode(child.id, {
								after: mapAgentAfter(parent, params.after),
							});
						}
						if (params.focus) {
							const first = child.tasks[0];
							if (first) {
								engine.updateTask(child.id, first.id, {
									title: params.focus,
								});
							} else {
								engine.addTask(child.id, { title: params.focus });
							}
						}
						notify(deps, engine);
						return ok(`Updated agent ${params.name}.`, {
							agent: findNodeV2(engine.get(), child.id) ?? undefined,
							plan: engine.get(),
						});
					}
					case "remove": {
						if (!params.name) return error("remove requires name");
						const child = findSupportAgent(parent, params.name);
						if (!child) {
							return error(`unknown agent: ${deliverableId}/${params.name}`);
						}
						engine.removeNode(child.id);
						notify(deps, engine);
						return ok(`Removed agent ${params.name}.`, { plan: engine.get() });
					}
					case "ensemble": {
						// A competitive bake-off: N branchless worker children under a
						// branch-owning worker deliverable. The executor provisions each
						// as a candidate (cand/<parent>/<id>) forked from the parent's
						// branch tip; candidates NEVER ship (isCandidateBranch). The
						// parent becomes the INTEGRATOR — it waits for the candidate
						// diffs, cherry-picks the strongest, and ships the one PR.
						// (docs/design/multi-model-agents.md §5.)
						if (engine.hasExecutionStarted())
							return error(
								"ensemble candidates must be authored before execution starts",
							);
						if (parent.agent !== "worker" || !isBranchOwner(parent))
							return error(
								`ensemble parent ${deliverableId} must be a branch-owning worker deliverable — it integrates the candidates and ships the one PR`,
							);
						const candidates = params.candidates ?? [];
						if (candidates.length < 2)
							return error("ensemble requires at least two candidates");
						// The parent integrates the candidates rather than implementing.
						engine.updateNode(deliverableId, { persona: "integrator" });
						const created = candidates.map((candidate) =>
							engine.addNode(deliverableId, {
								agent: "worker",
								persona: "coder",
								title: candidate.name,
								tasks: [candidate.focus],
							}),
						);
						notify(deps, engine);
						return ok(
							`✓ ensemble under ${deliverableId}: ${created.length} candidates (${created
								.map((child) => child.id)
								.join(", ")}); parent is the integrator.`,
							{ plan: engine.get() },
						);
					}
				}
			});
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
						// v2 PlanRepoV2 has no defaultBranch field — the default branch
						// is detected from the repo at derivation time. The param is
						// accepted for wire compat and ignored.
						engine.registerRepo({
							key: params.key,
							path: params.path,
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
									`- ${r.key}: ${r.path}${r.createdBy ? ` — created by \`${r.createdBy}\`` : ""}`,
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
			// TODO: implement renderPlanMarkdown / renderPlanSeed for the node tree
			return ok(renderNodeTree(plan), { plan });
		},
	}) as ToolDefinition;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Depth-indented tree listing; roots are v1's deliverables. */
function renderNodeTree(plan: PlanV2): string {
	const rows = [...walkNodes(plan)].map(
		({ node, depth }) =>
			`${"  ".repeat(depth - 1)}- ${node.id}: ${node.status} — ${node.title ?? node.persona}`,
	);
	return rows.length ? rows.join("\n") : "No deliverables.";
}

function withEngine(
	deps: PlanToolDeps,
	fn: (engine: PlanEngineV2) => Result,
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

function notify(deps: PlanToolDeps, engine: PlanEngineV2): void {
	deps.onPlanChanged?.(engine.get());
}
