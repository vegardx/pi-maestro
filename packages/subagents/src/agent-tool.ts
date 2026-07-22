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
import {
	type AgentAssignmentRequest,
	type AgentKind,
	type AgentKindDefinition,
	type AgentPlanningOptions,
	type AgentRun,
	type AgentRunRequest,
	type AgentsCapabilityV1,
	type ExactModelCandidateFact,
	type ReaderResult,
	type ReaderSpawnRequest,
	type ReaderWorkspace,
	type ResolvedAgentAssignment,
	type RunHandle,
	type RunId,
	type RunRecord,
	type RunResult,
	type SpawnProfile,
	type SubagentsCapabilityV1,
	type ThinkingLevel,
	TIER_IDS,
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
		choice: { model?: string; tier?: string; effort?: ThinkingLevel },
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
		...(kind.standby ? { standby: true } : {}),
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
			tier: request.tier,
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
			tier: request.tier,
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

	const spawnReaders = async (
		requests: readonly ReaderSpawnRequest[],
		opts: { workspace: ReaderWorkspace },
	): Promise<readonly ReaderResult[]> => {
		const transport = deps.subagents();
		if (!transport) throw new Error("Subagents are not available.");
		// Validate + resolve every request BEFORE spawning any, so one writer in
		// the batch rejects the whole call without leaving readers half-spawned.
		const prepared = await Promise.all(
			requests.map(async (request) => {
				if (request.kind === "host")
					throw new Error("The host kind cannot be spawned as a reader.");
				const kind = deps.registries.kinds.require(request.kind);
				const runtime = resolveRuntimePolicy(
					deps.registries.runtime,
					kind.runtimePolicy,
				);
				if (runtime.mode !== "read-only")
					throw new Error(
						`spawn is read-only fan-out; ${request.kind} is a writer — use the ensemble node path instead.`,
					);
				const assignment = await resolve({
					agentId: `assignment:${crypto.randomUUID()}`,
					kind: request.kind,
					focus: request.prompt,
					rationale: "Resolved for a blocking reader spawn.",
					inputContracts: [],
					model: request.model,
					tier: request.tier,
					effort: request.effort,
				});
				const base = profileFor(
					kind,
					{
						kind: request.kind,
						prompt: request.prompt,
						displayName: request.displayName,
					},
					assignment,
					deps,
				);
				const profile: SpawnProfile = {
					...base,
					meta: { ...base.meta, workspace: opts.workspace },
				};
				return { request, assignment, profile, kind: request.kind };
			}),
		);
		// Spawn all so they run concurrently; the caller's model idles while
		// blocked on the joined results below.
		const spawned = prepared.map((entry) => {
			const handle = transport.spawn(entry.request.prompt, entry.profile);
			handles.set(handle.id, handle);
			assignments.set(handle.id, entry.assignment);
			return { handle, assignment: entry.assignment, kind: entry.kind };
		});
		// Block until every reader settles, then hand back all results together.
		const results = await Promise.all(
			spawned.map((entry) => entry.handle.result()),
		);
		return spawned.map((entry, index) => ({
			runId: entry.handle.id,
			kind: entry.kind,
			modelId: entry.assignment.modelId,
			result: results[index],
		}));
	};

	return {
		resolve,
		options,
		run,
		batch: (requests) => Promise.all(requests.map(run)),
		spawnReaders,
		list: () => deps.subagents()?.list() ?? [],
		status: (runId) => deps.subagents()?.get(runId),
		steer: (runId, guidance) => {
			const cap = deps.subagents();
			if (!cap) throw new Error("Subagents are not available.");
			cap.steer(runId, guidance);
		},
		ask: async (runId, message) => {
			const cap = deps.subagents();
			if (!cap) throw new Error("Subagents are not available.");
			if (!cap.ask) return undefined;
			return cap.ask(runId, message);
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
	tier: Type.Optional(
		Type.Union(
			TIER_IDS.map((id) => Type.Literal(id)),
			{
				description:
					"Deliberate tier — resolves to a concrete model from this agent's allowlist. Prefer this over `model`: omit both to inherit the session model (right when this agent will itself drive subagents), set a tier for a leaf task on a cheaper model.",
			},
		),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Pin one exact model id (must be in the agent's tier allowlist). Rarely needed — prefer `tier`. Wins over `tier` if both are set.",
		}),
	),
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
			Type.Literal("spawn"),
			Type.Literal("list"),
			Type.Literal("status"),
			Type.Literal("steer"),
			Type.Literal("ask"),
			Type.Literal("interrupt"),
			Type.Literal("capture"),
			Type.Literal("result"),
		],
		{
			description:
				"run/batch start assignments; spawn blocks on a read-only reader fan-out and returns all findings; list/status inspect; steer/ask/interrupt control; capture/result retrieve output. ask drives a persistent (standby) child and blocks for its reply.",
		},
	),
	kind: Type.Optional(Type.String()),
	prompt: Type.Optional(Type.String()),
	tier: Type.Optional(
		Type.Union(
			TIER_IDS.map((id) => Type.Literal(id)),
			{
				description:
					"Deliberate tier — resolves to a concrete model from the agent's allowlist. Prefer over `model`; omit both to inherit the session model.",
			},
		),
	),
	model: Type.Optional(Type.String()),
	effort: Type.Optional(
		Type.Union(EFFORTS.map((effort) => Type.Literal(effort))),
	),
	cwd: Type.Optional(Type.String()),
	displayName: Type.Optional(Type.String()),
	assignments: Type.Optional(Type.Array(Request, { minItems: 1 })),
	workspace: Type.Optional(
		Type.Union([Type.Literal("shared-ro"), Type.Literal("none")], {
			description:
				"spawn only: read-only fan-out workspace — shared-ro reads the caller's tree (default), none is pure-reasoning.",
		}),
	),
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
			"Run and control ordinary typed agents. Use run for one assignment or batch for independent parallel assignments. Every run resolves and persists one exact model/effort pair. list/status inspect durable runs; steer and interrupt control live runs; ask drives a persistent standby child and blocks for its reply; capture and result retrieve output. Available kinds are included by list.",
		promptSnippet:
			"agent — run/batch typed agents and list/status/steer/ask/interrupt/capture/result them.",
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
							tier: params.tier,
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
					case "spawn": {
						if (!params.assignments?.length)
							return response("spawn requires assignments.");
						const workspace: ReaderWorkspace = params.workspace ?? "shared-ro";
						const readers: ReaderSpawnRequest[] = params.assignments.map(
							(request) => ({
								...request,
								kind: request.kind as AgentKind,
								effort: request.effort as ThinkingLevel | undefined,
							}),
						);
						const results = await cap.spawnReaders(readers, { workspace });
						return response(results.map(formatReader).join("\n\n"), {
							runIds: results.map((reader) => reader.runId),
						});
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
					case "ask": {
						if (!params.runId || !params.prompt)
							return response("ask requires runId and prompt.");
						const reply = await cap.ask(params.runId as RunId, params.prompt);
						if (reply === undefined)
							return response(
								`${params.runId} cannot be asked (not a persistent standby run).`,
							);
						return response(reply, { runId: params.runId as RunId });
					}
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

function formatReader(reader: ReaderResult): string {
	const body = reader.result.summary ?? reader.result.error ?? "(no output)";
	return `## ${reader.kind} — ${reader.runId} (${reader.result.status})\n${body}`;
}
