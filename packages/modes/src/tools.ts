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
	DELIVERABLE_STATUSES,
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
import { getPersona, PERSONA_IDS } from "./personas.js";
import type {
	AgentMode,
	AgentSpec,
	Deliverable,
	Plan,
	SubAgentSpec,
	ThinkingLevel,
	WorkItem,
} from "./schema.js";
import {
	deliverables,
	findDeliverable,
	hasExecutionStarted,
} from "./schema.js";
import { plansRoot } from "./storage.js";

export interface PlanToolDeps {
	readonly engine: () => PlanEngine | undefined;
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
	readonly agent?: AgentSpec;
	readonly subAgent?: SubAgentSpec;
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
	workerMode: Type.Optional(
		Type.Union([Type.Literal("full"), Type.Literal("read-only")]),
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
	deliverableId: Type.Optional(
		Type.String({ description: "Parent deliverable id." }),
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
	activeDeliverableId: Type.Optional(
		Type.String({ description: "Seed focus deliverable id." }),
	),
});

// ─── Tool constructors ───────────────────────────────────────────────────────

export function createPlanTools(deps: PlanToolDeps): ToolDefinition[] {
	return [
		createDeliverableTool(deps),
		createTaskTool(deps),
		createAgentTool(deps),
		createPanelTool(deps),
		createPlanTool(deps),
		createKnowledgeTool(deps),
	];
}

const SubAgentParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("remove"),
		Type.Literal("list"),
	]),
	deliverableId: Type.Optional(Type.String()),
	/** Persona id from the registry (required for add). */
	persona: Type.Optional(
		Type.String({
			description: `Review lens: one of ${PERSONA_IDS.join(", ")}.`,
		}),
	),
	/** Unique instance name; defaults to the persona id. */
	name: Type.Optional(Type.String()),
	focus: Type.Optional(
		Type.String({
			description: "Specialize the persona for this deliverable.",
		}),
	),
	effort: Type.Optional(
		Type.String({
			description: "How hard to look: low (quick sanity) … xhigh (deep audit).",
		}),
	),
	required: Type.Optional(
		Type.Boolean({
			description:
				"Gating: a review persona whose latest verdict must be SHIPPED " +
				"before the deliverable ships.",
		}),
	),
});

export function createPanelTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "panel",
		label: "Panel",
		description:
			"Compose a deliverable's review/helper panel from the persona palette " +
			`(${PERSONA_IDS.join(", ")}): add, remove, list. Reviewers run on the ` +
			"review model; set effort (low…xhigh) for how hard to look and required " +
			"to gate ship. The worker runs the panel.",
		promptSnippet:
			"panel — compose a deliverable's persona review panel (add/remove/list).",
		parameters: SubAgentParams,
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
						return error("cannot modify sub-agents in an active deliverable");
					}
				}
				switch (params.action) {
					case "add": {
						if (!params.persona) return error("add requires persona");
						if (!getPersona(params.persona)) {
							return error(
								`unknown persona "${params.persona}" (have: ${PERSONA_IDS.join(", ")})`,
							);
						}
						const g = findDeliverable(plan, deliverableId);
						const existing = g?.subAgents ?? [];
						const name =
							params.name ??
							uniqueName(
								params.persona,
								existing.map((s) => s.name),
							);
						const spec: SubAgentSpec = {
							name,
							persona: params.persona,
							...(params.focus ? { focus: params.focus } : {}),
							...(params.effort
								? { effort: params.effort as ThinkingLevel }
								: {}),
							...(params.required ? { required: true } : {}),
						};
						const added = engine.addSubAgent(deliverableId, spec);
						notify(deps, engine);
						return ok(
							`✓ ${deliverableId} panel: ${added.name} (${added.persona})`,
							{ subAgent: added, plan: engine.get() },
						);
					}
					case "remove": {
						if (!params.name) return error("remove requires name");
						engine.removeSubAgent(deliverableId, params.name);
						notify(deps, engine);
						return ok(`Removed ${params.name}.`, { plan: engine.get() });
					}
					default: {
						const g = findDeliverable(plan, deliverableId);
						const list = (g?.subAgents ?? [])
							.map(
								(s) =>
									`${s.name} (${s.persona}${s.required ? ", required" : ""})`,
							)
							.join(", ");
						return ok(list || "(no sub-agents)", { plan });
					}
				}
			});
		},
	}) as ToolDefinition;
}

/** persona → persona, persona-2, … avoiding taken names. */
function uniqueName(persona: string, taken: string[]): string {
	if (!taken.includes(persona)) return persona;
	for (let n = 2; ; n++) {
		const candidate = `${persona}-${n}`;
		if (!taken.includes(candidate)) return candidate;
	}
}

export function createDeliverableTool(deps: PlanToolDeps): ToolDefinition {
	return defineTool({
		name: "deliverable",
		label: "Deliverable",
		description:
			"Manage work deliverables in the active plan: add, update, remove, list. One deliverable = one branch = one PR.",
		promptSnippet:
			"deliverable — manage work deliverables (add/update/remove/list). One deliverable = one branch = one PR.",
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
						if (!params.title) return error("add requires title");
						if (!params.workerMode) return error("add requires workerMode");
						const input: AddDeliverableInput = {
							...(params.id ? { id: params.id } : {}),
							title: params.title,
							body: params.body,
							dependsOn: params.dependsOn,
							stacked: params.stacked,
							workerMode: params.workerMode,
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
							workerMode: params.workerMode as AgentMode | undefined,
							workerEffort: params.workerEffort as ThinkingLevel | undefined,
						});
						if (params.status) {
							engine.setDeliverableStatus(params.id, params.status);
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
					const gId = params.deliverableId ?? deps.agentDeliverableId?.() ?? "";
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
						if (!params.title) return error("add requires title");
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
							effort: params.effort as ThinkingLevel,
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
			// TODO: implement renderPlanMarkdown / renderPlanSeed for deliverable model
			const text = deliverables(plan).length
				? deliverables(plan)
						.map((g) => `- ${g.id}: ${g.status} — ${g.title}`)
						.join("\n")
				: "No deliverables.";
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
