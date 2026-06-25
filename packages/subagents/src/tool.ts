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
	SpawnProfile,
	SubagentsCapabilityV1,
} from "@vegardx/pi-contracts";
import type { AgentDefinition } from "./agents.js";

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
}

const SubagentParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("spawn"),
			Type.Literal("status"),
			Type.Literal("steer"),
			Type.Literal("stop"),
		],
		{ description: "What to do." },
	),
	agent: Type.Optional(
		Type.String({
			description: "Agent name for spawn (e.g. explore, worker).",
		}),
	),
	prompt: Type.Optional(
		Type.String({ description: "Task for the spawned agent." }),
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

function profileFor(def: AgentDefinition): SpawnProfile {
	return {
		profile: def.profile,
		model: def.model,
		appendSystemPrompt: def.appendSystemPrompt,
	};
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
			"agent, foreground or background), status, steer, stop.",
		promptSnippet:
			"subagent — delegate a focused task to explore/plan/review/worker.",
		parameters: SubagentParams,
		async execute(_id, params): Promise<AgentToolResult<SubagentDetails>> {
			const cap = deps.capability();
			if (!cap) {
				return { ...text("Subagents are not available."), details: {} };
			}

			switch (params.action) {
				case "spawn": {
					const name = params.agent ?? "explore";
					const def = deps.agents()[name];
					if (!def) {
						return { ...text(`Unknown agent: ${name}`), details: {} };
					}
					if (!params.prompt) {
						return { ...text("spawn requires a prompt."), details: {} };
					}
					const handle = cap.spawn(params.prompt, profileFor(def));
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
