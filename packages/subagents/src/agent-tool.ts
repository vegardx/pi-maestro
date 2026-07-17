// Unified agent API and model-facing `agent` tool. Semantic kinds resolve to
// one immutable exact model/effort assignment plus independently composed
// runtime policy before the subagents.v1 transport sees a spawn.

import {
	type AgentToolResult,
	defineTool,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import type {
	AgentAssignmentRequest,
	AgentKind,
	AgentKindDefinition,
	AgentPlanningOptions,
	AgentRun,
	AgentRunRequest,
	AgentsCapabilityV1,
	ExactModelCandidateFact,
	ResolvedAgentAssignment,
	RunHandle,
	RunId,
	RunRecord,
	RunResult,
	SpawnProfile,
	SubagentsCapabilityV1,
	ThinkingLevel,
} from "@vegardx/pi-contracts";
import type { AgentRegistries } from "./registry.js";
import { resolveRuntimePolicy } from "./registry.js";

export interface ExactAgentSelection {
	readonly presetId: string;
	readonly modelSetId: string;
	readonly optionId: string;
	readonly modelId: string;
	readonly effort: ThinkingLevel;
	readonly source: ResolvedAgentAssignment["source"];
	readonly candidates?: readonly ExactModelCandidateFact[];
}

export interface UnifiedAgentDeps {
	readonly subagents: () => SubagentsCapabilityV1 | undefined;
	readonly registries: AgentRegistries;
	readonly resolveModel: (
		kind: AgentKindDefinition,
		choice: { model?: string; effort?: ThinkingLevel },
	) => Promise<ExactAgentSelection>;
	readonly researchToolsPath?: () => string;
	readonly now?: () => Date;
}

function profileFor(
	kind: AgentKindDefinition,
	request: AgentRunRequest,
	assignment: ResolvedAgentAssignment,
	deps: UnifiedAgentDeps,
): SpawnProfile {
	const permissions = deps.registries.runtime.permissions.require(
		deps.registries.runtime.policies.require(kind.runtimePolicy).permissions,
	);
	const runtime = assignment.runtime;
	const extension = permissions.extraExtensions?.includes("research-tools")
		? deps.researchToolsPath?.()
		: undefined;
	return {
		profile: runtime.mode === "full" ? "deliverable-agent" : "general",
		role: kind.id,
		displayName: request.displayName ?? kind.id,
		model: assignment.modelId,
		thinking: assignment.effort,
		mode: runtime.mode === "full" ? "auto" : "plan",
		tools: runtime.tools,
		session: runtime.session === "persistent",
		transport: runtime.transport === "host" ? "tmux" : runtime.transport,
		isolateExtensions: runtime.mode === "read-only",
		...(extension ? { extraExtensions: [extension] } : {}),
		appendSystemPrompt: kind.prompt,
		watchdog: kind.watchdog,
		...(request.cwd ? { cwd: request.cwd } : {}),
		...(request.parent ? { parent: request.parent } : {}),
		...(request.rootTurnId ? { rootTurnId: request.rootTurnId } : {}),
		meta: {
			...request.meta,
			kind: kind.id,
			assignment,
			contracts: kind.contracts.map((contract) => contract.id),
			reducer: kind.reducer,
		},
	};
}

export function createAgentsCapability(
	deps: UnifiedAgentDeps,
): AgentsCapabilityV1 {
	const handles = new Map<RunId, RunHandle>();
	const assignments = new Map<RunId, ResolvedAgentAssignment>();

	const resolve = async (
		request: AgentAssignmentRequest,
	): Promise<ResolvedAgentAssignment> => {
		if (request.kind === "host")
			throw new Error(
				"The host kind represents the current session and cannot be assigned.",
			);
		const kind = deps.registries.kinds.require(request.kind);
		const outputContracts =
			request.outputContracts ?? kind.contracts.map((c) => c.id);
		const supported = new Set(kind.contracts.map((contract) => contract.id));
		for (const contract of outputContracts) {
			if (!supported.has(contract))
				throw new Error(
					`Agent kind ${kind.id} does not publish output contract ${contract}`,
				);
		}
		const selected = await deps.resolveModel(kind, {
			model: request.model,
			effort: request.effort,
		});
		const resolvedAt = (deps.now?.() ?? new Date()).toISOString();
		return {
			agentId: request.agentId,
			kind: request.kind,
			presetId: selected.presetId,
			modelSetId: selected.modelSetId,
			optionId: selected.optionId,
			modelId: selected.modelId,
			effort: selected.effort,
			runtime: resolveRuntimePolicy(
				deps.registries.runtime,
				kind.runtimePolicy,
			),
			focus: request.focus,
			rationale: request.rationale,
			inputContracts: [...request.inputContracts],
			outputContracts: [...outputContracts],
			provenance: {
				source: selected.source,
				presetId: selected.presetId,
				modelSetId: selected.modelSetId,
				optionId: selected.optionId,
				resolvedAt,
			},
			resolvedAt,
			source: selected.source,
		};
	};

	const options = async (kindId: AgentKind): Promise<AgentPlanningOptions> => {
		const kind = deps.registries.kinds.require(kindId);
		const selected = await deps.resolveModel(kind, {});
		return { kind, candidates: selected.candidates ?? [] };
	};

	const run = async (request: AgentRunRequest): Promise<AgentRun> => {
		const transport = deps.subagents();
		if (!transport) throw new Error("Subagents are not available.");
		if (request.kind === "host")
			throw new Error(
				"The host kind represents the current session and cannot run.",
			);
		const assignment = await resolve({
			agentId: `assignment:${crypto.randomUUID()}`,
			kind: request.kind,
			focus: request.prompt,
			rationale: "Resolved for an immediate agents.v1 run.",
			inputContracts: [],
			model: request.model,
			effort: request.effort,
		});
		const kind = deps.registries.kinds.require(request.kind);
		const handle = transport.spawn(
			request.prompt,
			profileFor(kind, request, assignment, deps),
		);
		handles.set(handle.id, handle);
		assignments.set(handle.id, assignment);
		return { runId: handle.id, assignment, handle };
	};

	return {
		resolve,
		options,
		run,
		batch: (requests) => Promise.all(requests.map(run)),
		list: () => deps.subagents()?.list() ?? [],
		status: (runId) => deps.subagents()?.get(runId),
		steer: (runId, guidance) => {
			const cap = deps.subagents();
			if (!cap) throw new Error("Subagents are not available.");
			cap.steer(runId, guidance);
		},
		interrupt: async (runId, reason) => {
			const cap = deps.subagents();
			if (!cap) throw new Error("Subagents are not available.");
			if (cap.interrupt) await cap.interrupt(runId, reason);
			else cap.stop(runId, reason);
		},
		capture: async (runId, lines) => deps.subagents()?.capture?.(runId, lines),
		result: async (runId) => {
			const live = handles.get(runId);
			if (live) return live.result();
			return deps.subagents()?.get(runId)?.result;
		},
		kinds: () => deps.registries.kinds.list(),
	};
}

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const Request = Type.Object({
	kind: Type.String({ description: "Registered semantic agent kind." }),
	prompt: Type.String({ description: "Focused assignment for the agent." }),
	model: Type.Optional(Type.String({ description: "Exact allowed model id." })),
	effort: Type.Optional(
		Type.Union(EFFORTS.map((effort) => Type.Literal(effort))),
	),
	cwd: Type.Optional(Type.String()),
	displayName: Type.Optional(Type.String()),
});
const Params = Type.Object({
	action: Type.Union(
		[
			Type.Literal("run"),
			Type.Literal("batch"),
			Type.Literal("list"),
			Type.Literal("status"),
			Type.Literal("steer"),
			Type.Literal("interrupt"),
			Type.Literal("capture"),
			Type.Literal("result"),
		],
		{
			description:
				"run/batch start assignments; list/status inspect; steer/interrupt control; capture/result retrieve output.",
		},
	),
	kind: Type.Optional(Type.String()),
	prompt: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	effort: Type.Optional(
		Type.Union(EFFORTS.map((effort) => Type.Literal(effort))),
	),
	cwd: Type.Optional(Type.String()),
	displayName: Type.Optional(Type.String()),
	assignments: Type.Optional(Type.Array(Request, { minItems: 1 })),
	runId: Type.Optional(Type.String()),
	guidance: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
	lines: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
});

interface Details {
	runId?: RunId;
	runIds?: readonly RunId[];
	run?: RunRecord;
	runs?: readonly RunRecord[];
	result?: RunResult;
	assignment?: ResolvedAgentAssignment;
}

function collapsed(
	result: { content: ReadonlyArray<{ type: string; text?: string }> },
	options: { expanded: boolean },
	theme: Theme,
): Text {
	const full = result.content
		.filter((part) => part.type === "text" && part.text)
		.map((part) => part.text)
		.join("\n")
		.trimEnd();
	const lines = full.split("\n");
	if (options.expanded || lines.length <= 10)
		return new Text(theme.fg("toolOutput", full), 0, 0);
	return new Text(
		`${theme.fg("toolOutput", lines.slice(0, 8).join("\n"))}\n${theme.fg("dim", `(+${lines.length - 8} more lines — expand to read)`)}`,
		0,
		0,
	);
}

export function createAgentTool(
	capability: () => AgentsCapabilityV1 | undefined,
): ToolDefinition {
	const response = (text: string, details: Details = {}) => ({
		content: [{ type: "text" as const, text }],
		details,
	});
	return defineTool({
		name: "agent",
		label: "Agent",
		description:
			"Run and control ordinary typed agents. Use run for one assignment or batch for independent parallel assignments. Every run resolves and persists one exact model/effort pair. list/status inspect durable runs; steer and interrupt control live runs; capture and result retrieve output. Available kinds are included by list.",
		promptSnippet:
			"agent — run/batch typed agents and list/status/steer/interrupt/capture/result them.",
		parameters: Params,
		renderResult: collapsed,
		async execute(_id, params): Promise<AgentToolResult<Details>> {
			const cap = capability();
			if (!cap) return response("Agents are not available.");
			try {
				switch (params.action) {
					case "run": {
						if (!params.kind || !params.prompt)
							return response("run requires kind and prompt.");
						const spawned = await cap.run({
							kind: params.kind as AgentKind,
							prompt: params.prompt,
							model: params.model,
							effort: params.effort as ThinkingLevel | undefined,
							cwd: params.cwd,
							displayName: params.displayName,
						});
						return response(
							`Started ${params.kind} as ${spawned.runId} (${spawned.assignment.modelId} @ ${spawned.assignment.effort}).`,
							{
								runId: spawned.runId,
								assignment: spawned.assignment,
							},
						);
					}
					case "batch": {
						if (!params.assignments?.length)
							return response("batch requires assignments.");
						const spawned = await cap.batch(
							params.assignments.map((request) => ({
								...request,
								kind: request.kind as AgentKind,
								effort: request.effort as ThinkingLevel | undefined,
							})),
						);
						return response(
							`Started ${spawned.length} agents in parallel:\n${spawned.map((run) => `- ${run.runId}: ${run.assignment.kind} (${run.assignment.modelId} @ ${run.assignment.effort})`).join("\n")}`,
							{ runIds: spawned.map((run) => run.runId) },
						);
					}
					case "list": {
						const runs = cap.list();
						const kinds = cap
							.kinds()
							.filter((kind) => kind.id !== "host")
							.map((kind) => `- ${kind.id}: ${kind.routingSummary}`)
							.join("\n");
						return response(
							`Kinds:\n${kinds}\n\nRuns:\n${runs.map(formatRun).join("\n") || "(none)"}`,
							{ runs },
						);
					}
					case "status": {
						if (!params.runId) return response("status requires runId.");
						const run = cap.status(params.runId as RunId);
						return run
							? response(formatRun(run), { run })
							: response(`No such run: ${params.runId}`);
					}
					case "steer":
						if (!params.runId || !params.guidance)
							return response("steer requires runId and guidance.");
						cap.steer(params.runId as RunId, params.guidance);
						return response(`Steered ${params.runId}.`);
					case "interrupt":
						if (!params.runId) return response("interrupt requires runId.");
						await cap.interrupt(params.runId as RunId, params.reason);
						return response(`Interrupted ${params.runId}.`);
					case "capture": {
						if (!params.runId) return response("capture requires runId.");
						const text = await cap.capture(params.runId as RunId, params.lines);
						return response(
							text ?? `No capture available for ${params.runId}.`,
						);
					}
					case "result": {
						if (!params.runId) return response("result requires runId.");
						const result = await cap.result(params.runId as RunId);
						if (!result)
							return response(`No result available for ${params.runId}.`);
						return response(
							`${params.runId} ${result.status}.\n\n${result.summary ?? result.error ?? ""}`,
							{ result },
						);
					}
				}
			} catch (cause) {
				return response(cause instanceof Error ? cause.message : String(cause));
			}
		},
	}) as ToolDefinition;
}

function formatRun(run: RunRecord): string {
	return `- ${run.id}: ${run.status} (${String(run.profile.meta?.kind ?? run.profile.profile)})`;
}
