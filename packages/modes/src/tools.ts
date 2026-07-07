// Plan tools: group, task, agent — flat-parameter tools for the group-based
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
	GROUP_STATUSES,
	WORK_ITEM_KINDS,
	type WorkItemKind,
} from "@vegardx/pi-contracts";
import type { AgentBridge } from "./agent-bridge.js";
import type {
	AddAgentInput,
	AddGroupInput,
	AddWorkItemInput,
	PlanEngine,
} from "./engine.js";
import { buildKnowledgeSession, KNOWLEDGE_TEMPLATE } from "./exec/knowledge.js";
import type {
	AgentMode,
	AgentSpec,
	ModelSlot,
	Plan,
	ThinkingLevel,
	WorkGroup,
	WorkItem,
} from "./schema.js";
import { findGroup, groups, hasExecutionStarted } from "./schema.js";
import { plansRoot } from "./storage.js";

export interface PlanToolDeps {
	readonly engine: () => PlanEngine | undefined;
	readonly onPlanChanged?: (plan: Plan) => void;
	readonly mode?: () => string;
	readonly steerAgent?: (groupId: string, guidance: string) => void;
	readonly onTaskToggle?: (groupId: string, taskId: string) => void;
	readonly seedContent?: () => string | undefined;
	readonly agentBridge?: () => AgentBridge | undefined;
	readonly agentGroupId?: () => string | undefined;
}

interface ToolDetails {
	readonly error?: string;
	readonly plan?: Plan;
	readonly group?: WorkGroup;
	readonly groups?: readonly WorkGroup[];
	readonly workItem?: WorkItem;
	readonly agent?: AgentSpec;
	readonly done?: boolean;
}

type Result = AgentToolResult<ToolDetails>;

// ─── Parameter schemas ───────────────────────────────────────────────────────

const GroupParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("update"),
		Type.Literal("remove"),
		Type.Literal("list"),
	]),
	id: Type.Optional(Type.String({ description: "Group id." })),
	title: Type.Optional(Type.String({ description: "Group title." })),
	body: Type.Optional(
		Type.String({ description: "What ships when this merges." }),
	),
	status: Type.Optional(Type.Union(GROUP_STATUSES.map((s) => Type.Literal(s)))),
	dependsOn: Type.Optional(
		Type.Array(Type.String(), { description: "Group ids this one waits on." }),
	),
	stacked: Type.Optional(
		Type.Boolean({
			description: "Branch from predecessor tip (default true).",
		}),
	),
	workerMode: Type.Optional(
		Type.Union([Type.Literal("full"), Type.Literal("read-only")]),
	),
	workerSlot: Type.Optional(
		Type.Union([Type.Literal("default"), Type.Literal("alternate")]),
	),
	workerEffort: Type.Optional(
		Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
		]),
	),
});

const TaskParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("update"),
		Type.Literal("toggle"),
		Type.Literal("remove"),
	]),
	groupId: Type.Optional(Type.String({ description: "Parent group id." })),
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
});

const AgentParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("update"),
		Type.Literal("remove"),
	]),
	groupId: Type.Optional(Type.String({ description: "Parent group id." })),
	name: Type.Optional(
		Type.String({ description: "Agent name (unique within group)." }),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("full"), Type.Literal("read-only")]),
	),
	slot: Type.Optional(
		Type.Union([Type.Literal("default"), Type.Literal("alternate")]),
	),
	effort: Type.Optional(
		Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
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

const PlanParams = Type.Object({
	view: Type.Optional(
		Type.Union([
			Type.Literal("markdown"),
			Type.Literal("seed"),
			Type.Literal("json"),
		]),
	),
	activeGroupId: Type.Optional(
		Type.String({ description: "Seed focus group id." }),
	),
});

// ─── Tool constructors ───────────────────────────────────────────────────────

export function createPlanTools(deps: PlanToolDeps): ToolDefinition[] {
	return [
		createGroupTool(deps),
		createTaskTool(deps),
		createAgentTool(deps),
		createPlanTool(deps),
		createKnowledgeTool(deps),
	];
}

export function createGroupTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "group",
		label: "Group",
		description:
			"Manage work groups in the active plan: add, update, remove, list. One group = one branch = one PR.",
		promptSnippet:
			"group — manage work groups (add/update/remove/list). One group = one branch = one PR.",
		parameters: GroupParams,
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
						const target = findGroup(plan, params.id);
						if (target && target.status !== "planned") {
							if (params.action === "remove") {
								return error("cannot remove an active group");
							}
							if (params.action === "update" && (params.title || params.body)) {
								return error("cannot update title/body of an active group");
							}
						}
					}
				}

				switch (params.action) {
					case "add": {
						if (!params.title) return error("add requires title");
						if (!params.workerMode) return error("add requires workerMode");
						const input: AddGroupInput = {
							title: params.title,
							body: params.body,
							dependsOn: params.dependsOn,
							stacked: params.stacked,
							workerMode: params.workerMode,
							workerSlot: params.workerSlot as ModelSlot | undefined,
							workerEffort: params.workerEffort as ThinkingLevel | undefined,
						};
						const group = engine.addGroup(input);
						notify(deps, engine);
						return ok(`✓ ${group.id}`, { group, plan: engine.get() });
					}
					case "update": {
						if (!params.id) return error("update requires id");
						engine.updateGroup(params.id, {
							title: params.title,
							body: params.body,
							dependsOn: params.dependsOn,
							stacked: params.stacked,
							workerMode: params.workerMode as AgentMode | undefined,
							workerSlot: params.workerSlot as ModelSlot | undefined,
							workerEffort: params.workerEffort as ThinkingLevel | undefined,
						});
						if (params.status) {
							engine.setGroupStatus(params.id, params.status);
						}
						notify(deps, engine);
						return ok(`Updated group ${params.id}.`, {
							group: findGroup(engine.get(), params.id) ?? undefined,
							plan: engine.get(),
						});
					}
					case "remove": {
						if (!params.id) return error("remove requires id");
						engine.removeGroup(params.id);
						notify(deps, engine);
						return ok(`Removed group ${params.id}.`, { plan: engine.get() });
					}
					case "list": {
						const rows = groups(engine.get());
						const text = rows.length
							? rows
									.map((g) => `- ${g.id}: ${g.status} — ${g.title}`)
									.join("\n")
							: "No groups.";
						return ok(text, { groups: rows, plan: engine.get() });
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
		description: "Manage work items in a group: add, update, toggle, remove.",
		promptSnippet:
			"task — manage work items within a group (add/update/toggle/remove).",
		parameters: TaskParams,
		async execute(_id, params): Promise<Result> {
			// Agent mode: forward toggle over RPC
			if (!deps.engine()) {
				if (params.action === "toggle" && deps.onTaskToggle) {
					if (!params.taskId) return error("toggle requires taskId");
					const gId = params.groupId ?? deps.agentGroupId?.() ?? "";
					deps.onTaskToggle(gId, params.taskId);
					return ok(`${params.taskId} marked done.`, { done: true });
				}
				const bridge = deps.agentBridge?.();
				if (bridge) {
					const gId = params.groupId ?? deps.agentGroupId?.() ?? "";
					switch (params.action) {
						case "add": {
							if (!params.title) return error("add requires title");
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
				const groupId = params.groupId;
				if (!groupId) return error("groupId is required");

				const plan = engine.get();
				if (hasExecutionStarted(plan)) {
					const g = findGroup(plan, groupId);
					if (g && g.status !== "planned" && params.action === "remove") {
						return error("cannot remove tasks from an active group");
					}
				}

				switch (params.action) {
					case "add": {
						if (!params.title) return error("add requires title");
						const input: AddWorkItemInput = {
							title: params.title,
							body: params.body,
							kind: params.kind as WorkItemKind | undefined,
							position: params.position,
						};
						const item = engine.addWorkItem(groupId, input);
						notify(deps, engine);
						deps.steerAgent?.(
							groupId,
							`New task: "${item.title}". ${item.body ?? ""}`.trim(),
						);
						return ok(`✓ ${item.id}`, { workItem: item, plan: engine.get() });
					}
					case "update": {
						if (!params.taskId) return error("update requires taskId");
						engine.updateWorkItem(groupId, params.taskId, {
							title: params.title,
							body: params.body,
							kind: params.kind as WorkItemKind | undefined,
							answer: params.answer,
						});
						notify(deps, engine);
						const g = findGroup(engine.get(), groupId);
						return ok(`Updated task ${params.taskId}.`, {
							workItem: g
								? (findGroup(engine.get(), groupId)?.tasks.find(
										(t) => t.id === params.taskId,
									) ?? undefined)
								: undefined,
							plan: engine.get(),
						});
					}
					case "toggle": {
						if (!params.taskId) return error("toggle requires taskId");
						const done = engine.toggleWorkItem(groupId, params.taskId);
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
						engine.removeWorkItem(groupId, params.taskId);
						notify(deps, engine);
						return ok(`Removed task ${params.taskId}.`, { plan: engine.get() });
					}
				}
			});
		},
	}) as ToolDefinition;
}

export function createAgentTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "agent",
		label: "Agent",
		description: "Manage support agents within a group: add, update, remove.",
		promptSnippet:
			"agent — manage support agents in a group (add/update/remove).",
		parameters: AgentParams,
		async execute(_id, params): Promise<Result> {
			if (!deps.engine() && deps.agentBridge?.()) {
				return error("agents cannot modify plan structure");
			}
			return withEngine(deps, (engine) => {
				const plan = engine.get();
				const groupId = params.groupId;
				if (!groupId) return error("groupId is required");

				if (hasExecutionStarted(plan)) {
					const g = findGroup(plan, groupId);
					if (g && g.status !== "planned") {
						return error("cannot modify agents in an active group");
					}
				}

				switch (params.action) {
					case "add": {
						if (!params.name) return error("add requires name");
						if (!params.mode) return error("add requires mode");
						if (!params.slot) return error("add requires slot");
						if (!params.effort) return error("add requires effort");
						if (!params.focus) return error("add requires focus");
						const input: AddAgentInput = {
							name: params.name,
							mode: params.mode,
							slot: params.slot as ModelSlot,
							effort: params.effort as ThinkingLevel,
							focus: params.focus,
							after: params.after ?? [],
						};
						const agent = engine.addAgent(groupId, input);
						notify(deps, engine);
						return ok(`✓ ${groupId}/${agent.name}`, {
							agent,
							plan: engine.get(),
						});
					}
					case "update": {
						if (!params.name) return error("update requires name");
						engine.updateAgent(groupId, params.name, {
							mode: params.mode as AgentMode | undefined,
							slot: params.slot as ModelSlot | undefined,
							effort: params.effort as ThinkingLevel | undefined,
							focus: params.focus,
							after: params.after,
						});
						notify(deps, engine);
						const g = findGroup(engine.get(), groupId);
						return ok(`Updated agent ${params.name}.`, {
							agent: g?.agents.find((a) => a.name === params.name) ?? undefined,
							plan: engine.get(),
						});
					}
					case "remove": {
						if (!params.name) return error("remove requires name");
						engine.removeAgent(groupId, params.name);
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
			"The complete codebase reference document. Required sections: " +
			"Project Structure, Key Patterns, Conventions, Key Interfaces. " +
			"Reference material only — where things are and how they connect, " +
			"not full file contents.",
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
			"sections. Frozen after /implement (rewrites would invalidate every " +
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
			const outPath = join(plansRoot(), plan.slug, "base-knowledge.jsonl");
			try {
				buildKnowledgeSession({
					content: params.content,
					repoPath: plan.repoPath,
					outPath,
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				return error(
					`knowledge document rejected: ${message}\n\nTemplate:\n${KNOWLEDGE_TEMPLATE}`,
				);
			}
			return ok(
				`Knowledge base written to ${outPath}. All agents will fork from it; it freezes when /implement runs.`,
				{},
			);
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
			// TODO: implement renderPlanMarkdown / renderPlanSeed for group model
			const text = groups(plan).length
				? groups(plan)
						.map((g) => `- ${g.id}: ${g.status} — ${g.title}`)
						.join("\n")
				: "No groups.";
			return ok(text, { plan });
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
