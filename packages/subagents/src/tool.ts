// The main agent's delegate surface: one `subagent` tool with spawn / status /
// steer / stop actions. spawn resolves a named agent to its spawn profile;
// foreground waits for the result inline, background returns the run id and
// lets the run outlive the turn. Backed by the subagents.v1 capability.

import {
	type AgentToolResult,
	defineTool,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
	/** Resolve exact/default choices against the delegate role pool. */
	readonly resolveDelegate?: (choice?: {
		model?: string;
		effort?: ThinkingLevel;
	}) => Promise<{
		model: string;
		effort?: ThinkingLevel;
		models: readonly DelegableModel[];
		allowedEfforts: readonly ThinkingLevel[];
	}>;
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
				"Model for this spawn — must be in the active delegate role pool " +
				"(action: models shows ordered defaults and capability facts). Omit " +
				"to use the first available configured model.",
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

async function formatModels(
	resolveDelegate: SubagentToolDeps["resolveDelegate"],
): Promise<string> {
	if (!resolveDelegate) return "Delegate role policy is unavailable.";
	try {
		const policy = await resolveDelegate();
		const lines = policy.models.map((m) => {
			const tags = [
				m.default ? "default" : "alternate",
				m.available ? "available" : "unavailable",
				m.facts,
				m.efforts.length > 0 ? `efforts: ${m.efforts.join("|")}` : undefined,
			].filter(Boolean);
			return `- ${m.id} (${tags.join(" · ")})${m.note ? ` — ${m.note}` : ""}`;
		});
		return (
			`Delegate role pool (ordered; exact choices only):\n${lines.join("\n")}\n` +
			`Allowed efforts: ${policy.allowedEfforts.join(", ") || "model-supported defaults"}. ` +
			"Prefer raising effort before selecting a more expensive alternate model."
		);
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/**
 * Collapsed result rendering: a foreground review/general run returns its
 * whole report as the tool result — pi's fallback renderer would dump ALL of
 * it into the dialog (custom tools have no built-in preview). Display-only;
 * the model always receives the full text. (Duplicated from modes'
 * tool-render.ts — extension packages must not import each other.)
 */
const PREVIEW_LINES = 8;
function renderCollapsedResult(
	result: { content: ReadonlyArray<{ type: string; text?: string }> },
	options: { expanded: boolean },
	theme: Theme,
): Text {
	const full = result.content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text)
		.join("\n")
		.trimEnd();
	const lines = full.split("\n");
	if (options.expanded || lines.length <= PREVIEW_LINES + 2) {
		return new Text(theme.fg("toolOutput", full), 0, 0);
	}
	const preview = lines.slice(0, PREVIEW_LINES).join("\n");
	const tail = `(+${lines.length - PREVIEW_LINES} more lines — expand to read)`;
	return new Text(
		`${theme.fg("toolOutput", preview)}\n${theme.fg("dim", tail)}`,
		0,
		0,
	);
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
			"agent, foreground or background), models (the ordered delegate role " +
			"pool with defaults, availability, capability facts, and effort envelope), " +
			"status, steer, stop. The `general` agent handles any read-only task with " +
			"no specialized agent. Exact choices must remain inside policy; omit them " +
			"for defaults and prefer effort before a costlier alternate.",
		promptSnippet:
			"subagent — delegate a focused task; general uses exact choices from the delegate role pool (models lists policy).",
		parameters: SubagentParams,
		renderResult: renderCollapsedResult,
		async execute(_id, params): Promise<AgentToolResult<SubagentDetails>> {
			const cap = deps.capability();
			if (!cap) {
				return { ...text("Subagents are not available."), details: {} };
			}

			switch (params.action) {
				case "models": {
					return {
						...text(await formatModels(deps.resolveDelegate)),
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

					try {
						const selected = await deps.resolveDelegate?.({
							model: params.model ?? def.model,
							effort: params.effort as ThinkingLevel | undefined,
						});
						if (!selected)
							throw new Error("Delegate role policy is unavailable.");
						const model = selected.model;
						const effort = selected.effort;

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
					} catch (err) {
						return {
							...text(
								`${err instanceof Error ? err.message : String(err)}\n\n${await formatModels(deps.resolveDelegate)}`,
							),
							details: {},
						};
					}
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
