// The plan-mode research loop: the `research` tool fans out headless
// subagents (codebase / web / advisor) through the subagents.v1 capability
// and persists their reports under <planDir>/research/; the `readiness` tool
// is the phase gate — it presents the maestro's summarized understanding and,
// on user confirmation, flips the plan from `exploring` to `structuring`.
//
// Parallelism note: one `research` call takes a BATCH of questions and runs
// them concurrently (bounded by the subagents semaphore). Batching inside one
// call guarantees the fan-out regardless of how the host executes tool calls.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentToolResult,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type {
	AskCapabilityV1,
	RunHandle,
	RunResult,
	SpawnProfile,
	SubagentsCapabilityV1,
} from "@vegardx/pi-contracts";
import { getModelMeta } from "@vegardx/pi-models";
import type { PlanEngine } from "./engine.js";
import { type Plan, slugify } from "./schema.js";

// ─── Public types ────────────────────────────────────────────────────────────

export const RESEARCH_KINDS = [
	"codebase",
	"web",
	"advisor",
	"consult",
] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

/** Kinds that run on the different-bias alternate model at high effort. */
const ALTERNATE_MODEL_KINDS = new Set<ResearchKind>(["advisor", "consult"]);

/** Live view of one research run — feeds the agent table and cards. */
export interface ResearchRunView {
	readonly id: string;
	readonly question: string;
	/** Short slug shown in the AGENT column. */
	readonly label: string;
	readonly kind: ResearchKind;
	status: "running" | "succeeded" | "failed" | "stopped";
	readonly startedAt: number;
	/** Last-turn token usage, fed from run progress events. */
	tokensIn?: number;
	tokensOut?: number;
	/** First-turn cacheRead/(cacheRead+input) — cache-prefix hit efficiency. */
	cacheRatio?: number;
	/** Resolved display metadata (Phase 2), for telemetry. */
	model?: string;
	effort?: string;
	adaptive?: boolean;
	/** Last tool the child ran ("websearch", "read", …). */
	activity?: string;
}

export interface ResearchDeps {
	readonly engine: () => PlanEngine | undefined;
	readonly subagents: () => SubagentsCapabilityV1 | undefined;
	readonly ask: () => AskCapabilityV1 | undefined;
	/** Materialize a draft plan (force) and return its plan directory. */
	readonly ensurePlanDir: (ctx: ExtensionContext) => string;
	/** Absolute path to the research-tools extension entry (-e for children). */
	readonly researchToolsPath: () => string;
	/** Advisor model (alternate slot); undefined ⇒ session default. */
	readonly resolveAdvisorModel?: (
		ctx: ExtensionContext,
	) => Promise<string | undefined>;
	/** Run lifecycle callbacks (widget rows + chat cards). */
	readonly onRunStarted?: (run: ResearchRunView, ctx: ExtensionContext) => void;
	readonly onRunSettled?: (
		run: ResearchRunView,
		report: { text: string; path: string } | undefined,
		ctx: ExtensionContext,
	) => void;
	/** Side effects after a phase flip (applyTools + footer refresh). */
	readonly onPhaseChanged?: (ctx: ExtensionContext) => void;
	/** Per-question wall-clock cap. Default 180s. */
	readonly timeoutMs?: () => number;
	/**
	 * Deliver a completed round's combined report to the model as a follow-up
	 * message (non-blocking research). When absent, the tool falls back to
	 * blocking (awaits the round and returns it inline).
	 */
	readonly deliver?: (text: string) => void;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
const WEB_TOOLS = ["websearch", "webfetch", "context7"] as const;

// ─── Tool constructors ───────────────────────────────────────────────────────

type Result = AgentToolResult<{ error?: string }>;

function ok(text: string): Result {
	return { content: [{ type: "text", text }], details: {} };
}

function error(message: string): Result {
	return {
		content: [{ type: "text", text: message }],
		details: { error: message },
	};
}

export function createResearchTools(deps: ResearchDeps): ToolDefinition[] {
	return [createResearchTool(deps), createReadinessTool(deps)];
}

const ResearchParams = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({
				description:
					"One focused research question. Specific beats broad — ask " +
					"several narrow questions rather than one sweeping one.",
			}),
			kind: Type.Optional(
				Type.Union(
					RESEARCH_KINDS.map((k) => Type.Literal(k)),
					{
						description:
							"codebase (default): read/grep this repo. web: internet " +
							"research (Exa search, page fetch, Context7 library docs). " +
							"advisor: a different model reviews the draft plan. consult: " +
							"a different model makes an unbiased call on a specific fork — " +
							"put the options in the question and WITHHOLD your own " +
							"preference (use this for an escalated decision).",
					},
				),
			),
			context: Type.Optional(
				Type.String({
					description:
						"Extra context the researcher needs (paths, constraints, URLs).",
				}),
			),
		}),
		{ minItems: 1 },
	),
});

export function createResearchTool(deps: ResearchDeps): ToolDefinition {
	// Serialize: one active research round at a time (exploring). A second
	// call while a round is in flight is refused so rounds never interleave.
	let roundActive = false;
	return defineTool({
		name: "research",
		label: "Research",
		description:
			"Fan out parallel research agents and get their reports back. Batch " +
			"ALL questions for this round into ONE call — they run concurrently. " +
			"Each agent is read-only; web agents can search (Exa), fetch pages, " +
			"and pull library docs (Context7). Reports persist in the plan " +
			"directory and are returned here.",
		promptSnippet:
			"research — fan out parallel research agents (codebase/web/advisor); batch questions into one call.",
		parameters: ResearchParams,
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Result> {
			const engine = deps.engine();
			if (!engine) return error("no plan active — run /plan first");
			const capability = deps.subagents();
			if (!capability) {
				return error(
					"research unavailable: the subagents extension is not loaded",
				);
			}
			if (roundActive) {
				return ok(
					"A research round is already running — its reports arrive as a " +
						"follow-up message when the whole round settles. Wait for it " +
						"(and evaluate all of it) before starting another round.",
				);
			}

			const planDir = deps.ensurePlanDir(ctx);
			const researchDir = join(planDir, "research");
			mkdirSync(researchDir, { recursive: true });

			const timeoutMs = deps.timeoutMs?.() ?? DEFAULT_TIMEOUT_MS;
			const plan = engine.get();

			const spawned = await Promise.all(
				params.questions.map(async (q) => {
					const kind = (q.kind ?? "codebase") as ResearchKind;
					const profile = await buildResearchProfile(deps, ctx, plan, kind);
					const prompt = buildResearchPrompt(plan, kind, q.question, q.context);
					try {
						const handle = capability.spawn(prompt, profile);
						// Display metadata: the child's effective model is the profile's
						// (advisor's alternate) or, when unset, the session model.
						const sessionModel = ctx.model
							? `${ctx.model.provider}/${ctx.model.id}`
							: undefined;
						const modelId = profile.model ?? sessionModel;
						const meta = modelId ? getModelMeta(ctx, modelId) : undefined;
						const view: ResearchRunView = {
							id: handle.id,
							question: q.question,
							label: researchLabel(q.question),
							kind,
							status: "running",
							startedAt: Date.now(),
							...(meta
								? { model: meta.shortName, adaptive: meta.adaptive }
								: {}),
							...(profile.thinking ? { effort: profile.thinking } : {}),
						};
						deps.onRunStarted?.(view, ctx);
						return { view, handle };
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						return {
							spawnError: `spawn failed: ${message}`,
							question: q.question,
						};
					}
				}),
			);

			// Settle the whole round, then compose ONE combined report. Each
			// agent's card/widget row still updates per-agent (onRunSettled),
			// but the MODEL sees the round atomically — never a per-agent trickle.
			const settleRound = async (): Promise<string> => {
				const sections = await Promise.all(
					spawned.map(async (entry) => {
						if ("spawnError" in entry) {
							return `## ${entry.question}\n\n(${entry.spawnError})`;
						}
						const { view, handle } = entry;
						const result = await settleWithTimeout(handle, timeoutMs);
						view.status =
							result.status === "succeeded" ? "succeeded" : "failed";
						const report = result.summary?.trim();
						if (!report) {
							deps.onRunSettled?.(view, undefined, ctx);
							return (
								`## ${view.question}\n\n` +
								`(research agent ${result.status}: ${result.error ?? "no report produced"})`
							);
						}
						const path = persistReport(researchDir, view, report);
						deps.onRunSettled?.(view, { text: report, path }, ctx);
						return `## ${view.question}\n(report: ${path})\n\n${report}`;
					}),
				);
				return (
					`${sections.join("\n\n---\n\n")}\n\n` +
					"Evaluate: do these answers settle your open questions, or open " +
					"new ones? Ask the user / research further, or call `readiness` " +
					"when the convergence criteria are met."
				);
			};

			// Non-blocking (deliver wired): spawn-and-return; the whole round is
			// delivered as one follow-up when it settles. Fallback (tests, no
			// deliver): block and return the report inline.
			if (!deps.deliver) return ok(await settleRound());

			roundActive = true;
			void settleRound()
				.then((text) => deps.deliver?.(`Research round complete.\n\n${text}`))
				.catch((err) =>
					deps.deliver?.(
						`Research round failed: ${err instanceof Error ? err.message : String(err)}`,
					),
				)
				.finally(() => {
					roundActive = false;
				});

			const labels = spawned
				.map((e) => ("spawnError" in e ? e.question : e.view.label))
				.join(", ");
			return ok(
				`Started ${spawned.length} research agent(s) [${labels}]. They run in ` +
					"parallel; the whole round's reports arrive as ONE follow-up " +
					"message when every agent settles. Do NOT wait or re-run — continue " +
					"with independent work or end the turn. When the round lands, " +
					"evaluate ALL of it before asking the user anything.",
			);
		},
	}) as ToolDefinition;
}

const ReadinessParams = Type.Object({
	understanding: Type.String({
		description:
			"Your summarized understanding: what will be built, the key design " +
			"decisions made (and why), and what research/answers back them.",
	}),
	open_risks: Type.Optional(
		Type.String({
			description: "Known risks or open questions you propose to accept.",
		}),
	),
});

export function createReadinessTool(deps: ResearchDeps): ToolDefinition {
	return defineTool({
		name: "readiness",
		label: "Readiness",
		description:
			"Declare you have enough information to form the plan. Presents your " +
			"understanding to the user for confirmation; approval unlocks the " +
			"structure tools (deliverable/task/agent/knowledge). Call this as soon as " +
			"the convergence criteria are met — or immediately for trivial " +
			"requests.",
		promptSnippet:
			"readiness — propose forming the plan (user confirms; unlocks structure tools).",
		parameters: ReadinessParams,
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Result> {
			const engine = deps.engine();
			if (!engine) return error("no plan active — run /plan first");
			const ask = deps.ask();
			if (!ask) {
				// No dialog surface — treat the declaration itself as the gate.
				engine.setPhase("structuring", params.understanding);
				deps.onPhaseChanged?.(ctx);
				return ok("Readiness accepted (no ask surface) — structure the plan.");
			}

			const context = params.open_risks
				? `${params.understanding}\n\n**Open risks:** ${params.open_risks}`
				: params.understanding;
			const answers = await ask.ask([
				{
					id: "readiness",
					header: "Readiness",
					question: "Ready to form the plan?",
					context,
					options: [
						{
							label: "Form the plan",
							value: "form",
							description: "Understanding looks right — structure it now.",
						},
						{
							label: "Keep exploring",
							value: "explore",
							description: "Not converged — give guidance on what's missing.",
						},
					],
					recommendation: "form",
					allowFreeText: true,
				},
			]);
			const answer = answers[0];
			const note = answer?.note ? ` Note: ${answer.note}` : "";
			if (answer?.value === "form") {
				engine.setPhase("structuring", params.understanding);
				deps.onPhaseChanged?.(ctx);
				return ok(
					`Readiness confirmed — structure tools unlocked.${note} ` +
						"Create deliverables and tasks now, then the knowledge doc " +
						"(distill it from the research reports in the plan directory).",
				);
			}
			return ok(
				`User chose to keep exploring: "${answer?.value ?? ""}".${note} ` +
					"Address this, then call readiness again.",
			);
		},
	}) as ToolDefinition;
}

// ─── Spawn assembly ──────────────────────────────────────────────────────────

async function buildResearchProfile(
	deps: ResearchDeps,
	ctx: ExtensionContext,
	plan: Plan,
	kind: ResearchKind,
): Promise<SpawnProfile> {
	const tools =
		kind === "web" ? [...READ_TOOLS, ...WEB_TOOLS] : [...READ_TOOLS];
	const model = ALTERNATE_MODEL_KINDS.has(kind)
		? await deps.resolveAdvisorModel?.(ctx)
		: undefined;
	return {
		profile: "research",
		cwd: plan.repoPath,
		tools: { allow: tools },
		thinking: ALTERNATE_MODEL_KINDS.has(kind) ? "high" : "low",
		...(model ? { model } : {}),
		extraExtensions: [deps.researchToolsPath()],
		appendSystemPrompt: researcherPreamble(kind),
	};
}

function researcherPreamble(kind: ResearchKind): string {
	const shared =
		"You are a research agent working for a planning maestro. Answer the " +
		"research brief you are given — nothing else. You are read-only: never " +
		"modify files. Your ENTIRE final message is the report; it is consumed " +
		"programmatically.\n\n" +
		"Report format: start with a one-paragraph answer/summary, then " +
		"supporting detail. Cite evidence — file:line for code claims, URLs for " +
		"web claims. State what you could NOT determine explicitly. Be dense " +
		"and factual; no preamble, no offers to help further.";
	switch (kind) {
		case "codebase":
			return `${shared}\n\nScope: THIS repository. Use read/grep/find/ls to establish facts (existing patterns, types, seams, tests).`;
		case "web":
			return (
				`${shared}\n\nScope: the public internet plus this repository. ` +
				"Use websearch (pick the tier: fast/auto for lookups, deep tiers " +
				"for hard questions), webfetch to read sources, and context7 for " +
				"library documentation. Prefer primary sources; include dates for " +
				"time-sensitive facts."
			);
		case "advisor":
			return (
				`${shared}\n\nRole: second-opinion advisor. You are a DIFFERENT ` +
				"model reviewing the maestro's draft plan. Challenge assumptions, " +
				"find gaps and risks, and say what you would change — concretely. " +
				"Verify claims against the repository where possible."
			);
		case "consult":
			return (
				`${shared}\n\nRole: unbiased advisor deciding a specific question. ` +
				"You are a DIFFERENT model; the maestro has DELIBERATELY WITHHELD " +
				"its own preference so your recommendation is unbiased — do not try " +
				"to guess what it wants. Weigh the options given (and propose a " +
				"better one if you see it) against the goal and constraints, verify " +
				"the relevant facts in the repository, and commit to a single clear " +
				"recommendation with your reasoning and the key trade-off you're " +
				"accepting. End with a line `RECOMMENDATION: <the option>`."
			);
	}
}

function buildResearchPrompt(
	plan: Plan,
	kind: ResearchKind,
	question: string,
	context?: string,
): string {
	const lines: string[] = ["# Research Brief", "", question];
	if (context) lines.push("", "## Context", context);
	if (kind === "advisor") {
		lines.push("", "## Draft Plan Under Review", renderPlanOutline(plan));
	} else if (kind === "consult") {
		// The advisor decides a specific fork; the whole-plan view is the context
		// the maestro holds and is consulting on its behalf.
		lines.push("", "## Plan Context", renderPlanOutline(plan));
	}
	return lines.join("\n");
}

/** Compact plan outline for the advisor — title, phase, deliverables, tasks. */
export function renderPlanOutline(plan: Plan): string {
	const lines = [`Plan: ${plan.title} (${plan.slug})`];
	if (plan.understanding) lines.push("", plan.understanding);
	for (const g of plan.deliverables) {
		lines.push(
			"",
			`## deliverable ${g.id} [${g.status}]${g.dependsOn?.length ? ` dependsOn: ${g.dependsOn.join(", ")}` : ""}`,
			g.title,
		);
		if (g.body) lines.push(g.body);
		for (const t of g.tasks) {
			lines.push(
				`- [${t.done ? "x" : " "}] ${t.title}${t.body ? ` — ${t.body}` : ""}`,
			);
		}
	}
	if (plan.deliverables.length === 0) lines.push("", "(no deliverables yet)");
	return lines.join("\n");
}

// ─── Report persistence ──────────────────────────────────────────────────────

/** "how do competing TUI libs handle resize?" → "how-do-competing-tui" */
export function researchLabel(question: string): string {
	return slugify(question).split("-").slice(0, 4).join("-") || "research";
}

function persistReport(
	researchDir: string,
	run: ResearchRunView,
	report: string,
): string {
	const existing = existsSync(researchDir)
		? readdirSync(researchDir).filter((f) => /^\d{2}-.*\.md$/.test(f)).length
		: 0;
	const name = `${String(existing + 1).padStart(2, "0")}-${slugify(run.question).slice(0, 48)}.md`;
	const path = join(researchDir, name);
	const frontmatter = [
		"---",
		`question: ${JSON.stringify(run.question)}`,
		`kind: ${run.kind}`,
		`run: ${run.id}`,
		`createdAt: ${new Date(run.startedAt).toISOString()}`,
		"---",
		"",
	].join("\n");
	writeFileSync(path, `${frontmatter}${report}\n`);
	return path;
}

// ─── Settle helpers ──────────────────────────────────────────────────────────

async function settleWithTimeout(
	handle: RunHandle,
	timeoutMs: number,
): Promise<RunResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<RunResult>((resolve) => {
		timer = setTimeout(() => {
			handle.stop("research timeout");
			resolve({
				status: "stopped",
				error: `timed out after ${Math.round(timeoutMs / 1000)}s`,
			});
		}, timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([handle.result(), timeout]);
	} catch (err) {
		return {
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}
