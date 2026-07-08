// The worker-side `review` tool. A worker (its own pi process, running in the
// deliverable's worktree) calls this to run its review panel: spawn every
// persona reviewer as a headless nested subagent, collect verdicts, and get
// the reports back to reason over. It also reports the verdicts upward (so the
// executor can gate ship on the required ones) via an injected sink.

import {
	type AgentToolResult,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { SubagentsCapabilityV1 } from "@vegardx/pi-contracts";
import {
	type PanelResult,
	panelGateSatisfied,
	runReviewPanel,
} from "./panel.js";
import type { SubAgentSpec } from "./schema.js";

export interface ReviewToolDeps {
	readonly subagents: () => SubagentsCapabilityV1 | undefined;
	/** This worker's review panel (from the deliverable's subAgents). */
	readonly panel: () => readonly SubAgentSpec[];
	/** The worktree the reviewers read (usually process.cwd()). */
	readonly cwd: () => string;
	/** Resolve a spec's model id (spec.model, or spec.slot via presets). */
	readonly resolveModel?: (spec: SubAgentSpec) => Promise<string | undefined>;
	/** Report the round's verdicts upward for the executor ship-gate. */
	readonly reportVerdicts?: (results: readonly PanelResult[]) => void;
	readonly timeoutMs?: () => number;
}

type Result = AgentToolResult<{ gate?: boolean }>;

const ReviewParams = Type.Object({});

export function createReviewTool(deps: ReviewToolDeps): ToolDefinition {
	return defineTool({
		name: "review",
		label: "Review",
		description:
			"Run your review panel over the current change: spawns every reviewer " +
			"(security, correctness, tests, …) in parallel and returns their " +
			"findings and verdicts. Run it after you have committed a coherent " +
			"change; address the findings and run it again for another pass. Ship " +
			"is blocked until every REQUIRED reviewer's latest verdict is PASS.",
		promptSnippet:
			"review — run your review panel (reviewers report findings + verdicts).",
		parameters: ReviewParams,
		async execute(): Promise<Result> {
			const subagents = deps.subagents();
			if (!subagents) {
				return {
					content: [
						{ type: "text", text: "review unavailable: subagents not loaded" },
					],
					details: {},
				};
			}
			const panel = deps.panel();
			if (panel.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No review panel is configured for this deliverable — nothing to run.",
						},
					],
					details: { gate: true },
				};
			}

			const results = await runReviewPanel(panel, {
				subagents,
				cwd: deps.cwd(),
				resolveModel: deps.resolveModel,
				timeoutMs: deps.timeoutMs?.(),
			});
			deps.reportVerdicts?.(results);

			const gate = panelGateSatisfied(results);
			return {
				content: [{ type: "text", text: renderPanel(results, gate) }],
				details: { gate },
			};
		},
	}) as ToolDefinition;
}

const GLYPH: Record<string, string> = {
	approve: "✓ PASS",
	"request-changes": "✗ CHANGES",
	none: "· no verdict",
};

/** Compose the panel results into a report the worker reasons over. */
export function renderPanel(
	results: readonly PanelResult[],
	gate: boolean,
): string {
	const header = gate
		? "All required reviewers PASS — the deliverable can ship (once you're satisfied)."
		: "Ship is BLOCKED — resolve the required reviewers' findings and run `review` again.";
	const blocks = results.map((r) => {
		const tag = r.required && r.kind === "review" ? " [required]" : "";
		const status = r.kind === "helper" ? "helper" : (GLYPH[r.verdict] ?? "?");
		return `### ${r.persona}${tag} — ${status}\n${r.report}`;
	});
	return `${header}\n\n${blocks.join("\n\n---\n\n")}`;
}
