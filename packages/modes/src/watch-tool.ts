// The `watch` tool: goal-driven eyes on anything external (design §The
// watcher). The agent states a goal in prose; the watcher compiles a
// read-only probe + TypeScript canonicalizer via its skills, the harness
// ticks it deterministically, and raises arrive as messages in THIS session.

import {
	type AgentToolResult,
	defineTool,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { WatchManager } from "./watcher.js";

const WatchParams = Type.Object({
	action: Type.Union(
		[Type.Literal("start"), Type.Literal("list"), Type.Literal("cancel")],
		{
			description: "start a new watch, list live watches, or cancel one by id.",
		},
	),
	goal: Type.Optional(
		Type.String({
			description:
				"start: what to watch and when to raise, in plain words — e.g. " +
				'"watch PR #271\'s CI and raise when it completes or fails". ' +
				"Include identifiers (PR number, run id, URL); the watcher " +
				"compiles the probe itself.",
		}),
	),
	lifetime: Type.Optional(
		Type.Union([Type.Literal("one-shot"), Type.Literal("until-condition")], {
			description:
				"one-shot (default): raise once when the condition is met, then " +
				"end. until-condition: raise on each relevant change until the " +
				"condition closes the watch.",
		}),
	),
	minutes: Type.Optional(
		Type.Number({
			description: "Maximum watch duration in minutes (default 60).",
		}),
	),
	id: Type.Optional(
		Type.String({ description: "cancel: the watch id to cancel." }),
	),
});

type Result = AgentToolResult<{ error?: string }>;

function ok(text: string): Result {
	return { content: [{ type: "text", text }], details: {} };
}

function error(text: string): Result {
	return { content: [{ type: "text", text }], details: { error: text } };
}

export function createWatchTool(
	getManager: () => WatchManager,
): ToolDefinition {
	return defineTool({
		name: "watch",
		label: "Watch",
		description:
			"Post goal-driven eyes on anything external — a CI run, a PR, an " +
			"endpoint — and keep working; a message arrives in this session " +
			"when the goal-relevant state change happens (or the probe fails " +
			"or the watch expires — silence is never success). The watcher " +
			"compiles a read-only probe itself and only wakes a model on real " +
			"state changes.",
		promptSnippet:
			"watch — set a goal-driven monitor on external state; raises arrive " +
			"as messages.",
		parameters: WatchParams,
		async execute(
			_id,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		): Promise<Result> {
			const manager = getManager();
			if (params.action === "list") {
				const rows = manager.list();
				if (rows.length === 0) return ok("No watches this session.");
				return ok(
					rows
						.map(
							(w) =>
								`${w.id} [${w.status}] ${w.goal} — probe every ${Math.round(
									w.probe.intervalMs / 1000,
								)}s, ${w.raises} raise(s), ${w.refinements.length} refinement(s)${
									w.endReason ? `, ended: ${w.endReason}` : ""
								}`,
						)
						.join("\n"),
				);
			}
			if (params.action === "cancel") {
				if (!params.id) return error("cancel requires the watch id");
				return manager.cancel(params.id)
					? ok(`Cancelled ${params.id}.`)
					: error(`No active watch ${params.id}.`);
			}
			if (!params.goal?.trim())
				return error("start requires a goal — what to watch, in plain words");
			const result = await manager.create(ctx, {
				goal: params.goal,
				...(params.lifetime ? { lifetime: params.lifetime } : {}),
				...(params.minutes
					? { caps: { maxDurationMs: Math.round(params.minutes * 60_000) } }
					: {}),
			});
			if (!result.ok) return error(result.error);
			const record = result.record;
			return ok(
				[
					`Watch ${record.id} armed (${record.lifetime}, ` +
						`${Math.round(record.caps.maxDurationMs / 60_000)}m budget).`,
					`Probe every ${Math.round(record.probe.intervalMs / 1000)}s: ${record.probe.command}`,
					"Keep working — a message arrives on the goal-relevant change, " +
						"a probe failure, or expiry.",
				].join("\n"),
			);
		},
	}) as ToolDefinition;
}
