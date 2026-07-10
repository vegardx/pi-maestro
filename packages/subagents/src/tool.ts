// The main agent's delegate surface: one `subagent` tool with spawn / status /
// steer / stop actions. spawn resolves a named agent to its spawn profile;
// foreground waits for the result inline, background returns the run id and
// lets the run outlive the turn. Backed by the subagents.v1 capability.

import {
	type AgentToolResult,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type {
	RunId,
	RunRecord,
	RunResult,
	RunWatchdogConfig,
	SpawnProfile,
	SubagentsCapabilityV1,
	ThinkingLevel,
} from "@vegardx/pi-contracts";
import type { AgentDefinition } from "./agents.js";
import type { DelegableModel } from "./catalog.js";

interface SubagentDetails {
	runId?: RunId;
	background?: boolean;
	result?: RunResult;
	run?: RunRecord;
	runs?: readonly RunRecord[];
}

export interface SubagentToolDeps {
	/** The live subagents.v1 capability, or undefined if unavailable. */
	readonly capability: () => SubagentsCapabilityV1 | undefined;
	/** Resolve the available agent definitions by name. */
	readonly agents: () => Record<string, AgentDefinition>;
	/** The delegable-model whitelist with guidance (action: models). */
	readonly delegable?: () => DelegableModel[];
	/** Default model/effort when a spawn names none: the WORK tier. */
	readonly defaultSpawn?: () => { model?: string; effort?: ThinkingLevel };
	/** research-tools extension path for web-enabled spawns. */
	readonly researchToolsPath?: () => string;
	/** Liveness watchdog applied to every spawn from this tool. */
	readonly watchdog?: () => RunWatchdogConfig;
}

const EFFORT_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

const SubagentParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("spawn"),
			Type.Literal("models"),
			Type.Literal("status"),
			Type.Literal("steer"),
			Type.Literal("stop"),
		],
		{
			description:
				"What to do. models lists the delegable-model whitelist with " +
				"guidance on what each is good at.",
		},
	),
	agent: Type.Optional(
		Type.String({
			description: "Agent name for spawn (e.g. general, explore, agent).",
		}),
	),
	prompt: Type.Optional(
		Type.String({ description: "Task for the spawned agent." }),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Model for this spawn — must be on the whitelist (action: models " +
				"shows it with guidance). Omit to use the work tier.",
		}),
	),
	effort: Type.Optional(
		Type.Union(
			EFFORT_LEVELS.map((l) => Type.Literal(l)),
			{ description: "Thinking effort for this spawn." },
		),
	),
	web: Type.Optional(
		Type.Boolean({
			description: "Give the agent web tools (websearch/webfetch/context7).",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description: "Spawn in the background and return immediately.",
		}),
	),
	runId: Type.Optional(
		Type.String({ description: "Target run for status/steer/stop." }),
	),
	guidance: Type.Optional(
		Type.String({ description: "Steering guidance for an active run." }),
	),
	reason: Type.Optional(Type.String({ description: "Reason for stop." })),
});

const WEB_TOOLS = ["websearch", "webfetch", "context7"] as const;

function formatModels(models: DelegableModel[]): string {
	if (models.length === 0)
		return "No delegable models configured — spawns use the work tier. Add entries under extensionConfig.modes.catalog ({model, note}).";
	const lines = models.map(
		(m) => `- ${m.id} (${m.facts})${m.note ? ` — ${m.note}` : ""}`,
	);
	return `Delegable models (pick per task):\n${lines.join("\n")}`;
}

export function createSubagentTool(deps: SubagentToolDeps): ToolDefinition {
	const text = (t: string) => ({
		content: [{ type: "text" as const, text: t }],
	});

	return defineTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate work to a focused subagent. Actions: spawn (run a named " +
			"agent, foreground or background), models (the delegable-model " +
			"whitelist with guidance), status, steer, stop. The `general` agent " +
			"handles any read-only task with no specialized agent — pick model " +
			"and effort per call; it defaults to the work tier.",
		promptSnippet:
			"subagent — delegate a focused task (general/explore/plan/review/agent); general takes any whitelisted model + effort.",
		parameters: SubagentParams,
		async execute(_id, params): Promise<AgentToolResult<SubagentDetails>> {
			const cap = deps.capability();
			if (!cap) {
				return { ...text("Subagents are not available."), details: {} };
			}

			switch (params.action) {
				case "models": {
					return {
						...text(formatModels(deps.delegable?.() ?? [])),
						details: {},
					};
				}

				case "spawn": {
					const name = params.agent ?? "explore";
					const def = deps.agents()[name];
					if (!def) {
						return { ...text(`Unknown agent: ${name}`), details: {} };
					}
					if (!params.prompt) {
						return { ...text("spawn requires a prompt."), details: {} };
					}

					// Model: explicit (whitelisted) > agent definition > work tier.
					const whitelist = deps.delegable?.() ?? [];
					if (
						params.model &&
						whitelist.length > 0 &&
						!whitelist.some((m) => m.id === params.model)
					) {
						return {
							...text(
								`Model ${params.model} is not on the whitelist.\n\n${formatModels(whitelist)}`,
							),
							details: {},
						};
					}
					const defaults = deps.defaultSpawn?.() ?? {};
					const model = params.model ?? def.model ?? defaults.model;
					const effort =
						(params.effort as ThinkingLevel | undefined) ?? defaults.effort;

					let profile: SpawnProfile = {
						profile: def.profile,
						...(model ? { model } : {}),
						...(effort ? { thinking: effort } : {}),
						appendSystemPrompt: def.appendSystemPrompt,
						...(deps.watchdog ? { watchdog: deps.watchdog() } : {}),
					};
					if (params.web) {
						const researchTools = deps.researchToolsPath?.();
						profile = {
							...profile,
							tools: { allow: ["read", "grep", "find", "ls", ...WEB_TOOLS] },
							...(researchTools ? { extraExtensions: [researchTools] } : {}),
						};
					}

					const handle = cap.spawn(params.prompt, profile);
					if (params.background) {
						return {
							...text(`Spawned ${name} in background as ${handle.id}.`),
							details: { runId: handle.id, background: true },
						};
					}
					const result = await handle.result();
					return {
						content: [
							{
								type: "text",
								text:
									`${name} (${handle.id}) ${result.status}.\n\n` +
									(result.summary ?? result.error ?? ""),
							},
						],
						details: { runId: handle.id, result },
					};
				}

				case "status": {
					if (params.runId) {
						const run = cap.get(params.runId as RunId);
						if (!run) {
							return { ...text(`No such run: ${params.runId}`), details: {} };
						}
						return {
							...text(`${run.id}: ${run.status} (${run.profile.profile})`),
							details: { run },
						};
					}
					const runs = cap.list();
					const lines = runs.map(
						(r) => `- ${r.id}: ${r.status} (${r.profile.profile})`,
					);
					return {
						...text(runs.length ? lines.join("\n") : "No runs."),
						details: { runs },
					};
				}

				case "steer": {
					if (!params.runId || !params.guidance) {
						return {
							...text("steer requires runId and guidance."),
							details: {},
						};
					}
					cap.steer(params.runId as RunId, params.guidance);
					return { ...text(`Steered ${params.runId}.`), details: {} };
				}

				case "stop": {
					if (!params.runId) {
						return { ...text("stop requires runId."), details: {} };
					}
					cap.stop(params.runId as RunId, params.reason);
					return { ...text(`Stopped ${params.runId}.`), details: {} };
				}
			}
		},
	}) as ToolDefinition;
}
