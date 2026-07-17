// The recon/plan research loop: the `research` tool fans out headless
// subagents (codebase / web / advisor / consult) through the subagents.v1
// capability. Each agent writes a full report to `<planDir>/research/` —
// the durable, curated location every downstream consumer (knowledge doc,
// carry-forward harvest, execution workers) reads — and the tool delivers
// only a bounded digest per question; `dig(ref)` returns a report's full
// text on demand, in the maestro AND in worker agents (via
// PI_MAESTRO_PLAN_DIR). The `readiness` tool is the phase gate — it presents
// the maestro's summarized understanding and, on user confirmation, flips
// the plan from `exploring` to `structuring`.
//
// Parallelism note: one `research` call takes a BATCH of questions and runs
// them concurrently (bounded by the subagents semaphore). Batching inside one
// call guarantees the fan-out regardless of how the host executes tool calls.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentToolResult,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type {
	AgentsCapabilityV1,
	AskCapabilityV1,
	ModelRole,
	RunResult,
	SubagentsCapabilityV1,
	ThinkingLevel,
} from "@vegardx/pi-contracts";
import { getModelMeta } from "@vegardx/pi-models";
import type { PlanEngine } from "./engine.js";
import { panelTopologyGaps } from "./personas.js";
import { type Plan, slugify } from "./schema.js";
import type { ResearchWatchdogSettings } from "./settings.js";
import { renderCollapsedResult } from "./tool-render.js";

// ─── Public types ────────────────────────────────────────────────────────────

export const RESEARCH_KINDS = [
	"codebase",
	"web",
	"advisor",
	"consult",
] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

/** Kinds a run VIEW can carry — research kinds plus /verify's verifiers,
 *  which reuse the research widget rows and chat cards. */
export type ResearchDisplayKind = ResearchKind | "verify";

/** Live view of one research run — feeds the agent table and cards. */
export interface ResearchRunView {
	readonly id: string;
	readonly question: string;
	/** Short slug shown in the AGENT column. */
	readonly label: string;
	readonly kind: ResearchDisplayKind;
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
	/** Agent API used for ordinary research assignments. */
	readonly agents?: () => AgentsCapabilityV1 | undefined;
	/** @deprecated Test/compatibility seam; wrapped as ordinary assignments. */
	readonly subagents?: () => SubagentsCapabilityV1 | undefined;
	readonly ask: () => AskCapabilityV1 | undefined;
	/** @deprecated Kinds own extension composition in agents.v1. */
	readonly researchToolsPath?: () => string;
	/** @deprecated Exact model resolution is owned by agents.v1. */
	readonly resolveRoleModel?: (
		ctx: ExtensionContext,
		role: Extract<ModelRole, "research" | "advisor">,
		choice?: { model?: string; effort?: ThinkingLevel },
	) => Promise<{
		model: string;
		effort?: ThinkingLevel;
		allowedModels?: readonly string[];
		allowedEfforts?: readonly ThinkingLevel[];
	}>;
	/** Materialize a draft plan (force) and return its plan directory. */
	readonly ensurePlanDir: (ctx: ExtensionContext) => string;
	/** Run lifecycle callbacks (widget rows + chat cards). */
	readonly onRunStarted?: (run: ResearchRunView, ctx: ExtensionContext) => void;
	readonly onRunSettled?: (
		run: ResearchRunView,
		report: { text: string; path: string } | undefined,
		ctx: ExtensionContext,
	) => void;
	/** Side effects after a phase flip (applyTools + footer refresh). */
	readonly onPhaseChanged?: (ctx: ExtensionContext) => void;
	/**
	 * Watchdog thresholds (stall/soft-steer/hard-cap) for research children,
	 * enforced by the subagents runner. Defaults: 120s/240s/600s.
	 */
	readonly watchdog?: (ctx: ExtensionContext) => ResearchWatchdogSettings;
	/**
	 * Deliver a completed round's combined report to the model as a follow-up
	 * message (non-blocking research). When absent, the tool falls back to
	 * blocking (awaits the round and returns it inline).
	 */
	readonly deliver?: (text: string) => void;
}

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
	return [
		createResearchTool(deps),
		createReadinessTool(deps),
		createDigTool(deps),
	];
}

function compatibilityAgents(
	deps: ResearchDeps,
	ctx: ExtensionContext,
): AgentsCapabilityV1 | undefined {
	const subagents = deps.subagents?.();
	if (!subagents) return undefined;
	return {
		run: async (request) => {
			const researchKind = String(
				request.meta?.researchKind ?? "codebase",
			) as ResearchKind;
			const role =
				researchKind === "advisor" || researchKind === "consult"
					? "advisor"
					: "research";
			const resolved = await deps.resolveRoleModel?.(ctx, role, {
				model: request.model,
				effort: request.effort,
			});
			const tools =
				researchKind === "web"
					? ["read", "grep", "find", "ls", "websearch", "webfetch", "context7"]
					: ["read", "grep", "find", "ls"];
			const watchdog = deps.watchdog?.(ctx) ?? {
				stallMs: 120_000,
				softMs: 240_000,
				hardMs: 600_000,
			};
			const handle = subagents.spawn(request.prompt, {
				profile: "research",
				cwd: request.cwd,
				model: resolved?.model ?? request.model,
				thinking:
					resolved?.effort ??
					request.effort ??
					(role === "advisor" ? "high" : "low"),
				role,
				displayName: request.displayName,
				tools: { allow: tools },
				watchdog: { ...watchdog, wrapUpSteer: WRAP_UP_STEER },
				...(deps.researchToolsPath
					? { extraExtensions: [deps.researchToolsPath()] }
					: {}),
				appendSystemPrompt:
					researchKind === "consult"
						? "The maestro deliberately WITHHELD its preference. Make an unbiased recommendation."
						: "Return a factual research report ending with a ## Digest block.",
				meta: request.meta,
			});
			return {
				runId: handle.id,
				handle,
				assignment: {
					agentId: handle.id,
					kind: request.kind,
					presetId: "compatibility",
					modelSetId: "compatibility",
					optionId: "compatibility",
					modelId: resolved?.model ?? request.model ?? "session",
					effort:
						resolved?.effort ??
						request.effort ??
						(role === "advisor" ? "high" : "low"),
					runtime: {
						mode: "read-only",
						transport: "tmux",
						tools: {},
						session: "ephemeral",
						isolation: "strong",
					},
					resolvedAt: new Date().toISOString(),
					source: "session",
				},
			};
		},
		batch: async (requests) => {
			const agent = compatibilityAgents(deps, ctx);
			if (!agent) return [];
			return Promise.all(requests.map((request) => agent.run(request)));
		},
		list: () => subagents.list(),
		status: (runId) => subagents.get(runId),
		steer: (runId, guidance) => subagents.steer(runId, guidance),
		interrupt: async (runId, reason) => {
			if (subagents.interrupt) await subagents.interrupt(runId, reason);
			else subagents.stop(runId, reason);
		},
		capture: async (runId, lines) => subagents.capture?.(runId, lines),
		result: async (runId) => subagents.get(runId)?.result,
		kinds: () => [],
	};
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
			model: Type.Optional(
				Type.String({
					description:
						"Exact provider/model id from the active research/advisor pool. Omit for the first available default.",
				}),
			),
			effort: Type.Optional(
				Type.Union(
					["off", "minimal", "low", "medium", "high", "xhigh"].map((level) =>
						Type.Literal(level),
					),
					{
						description:
							"Exact effort from the role pool and selected model's supported levels. Prefer raising effort before selecting a costlier alternate model.",
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
			"codebase/web choices are constrained by the active research role pool; " +
			"advisor/consult use the advisor pool. Omit model/effort for the first " +
			"available defaults; explicit exact choices are rejected unless allowed, " +
			"available, and mutually compatible. Prefer effort before a costlier " +
			"alternate. Each agent is read-only; web agents can search (Exa), fetch " +
			"pages, and pull library docs (Context7). You get back a bounded digest " +
			"per question; call `dig(ref)` for a report's full analysis if needed.",
		promptSnippet:
			"research — fan out parallel research agents (codebase/web/advisor); batch questions into one call.",
		parameters: ResearchParams,
		renderResult: renderCollapsedResult,
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Result> {
			const engine = deps.engine();
			if (!engine) return error("no plan active — run /plan first");
			const capability = deps.agents?.() ?? compatibilityAgents(deps, ctx);
			if (!capability) {
				return error("research unavailable: agents.v1 is not loaded");
			}
			if (roundActive) {
				return ok(
					"A research round is already running — its reports arrive as a " +
						"follow-up message when the whole round settles. Wait for it " +
						"(and evaluate all of it) before starting another round.",
				);
			}

			// Full reports persist to <planDir>/research/ (durable — the knowledge
			// index, carry-forward harvest, and execution workers all read it);
			// only the bounded digest reaches the model.
			const researchDir = researchReportsDir(deps.ensurePlanDir(ctx));
			mkdirSync(researchDir, { recursive: true });

			const plan = engine.get();

			const spawned = await capability
				.batch(
					params.questions.map((q) => {
						const kind = (q.kind ?? "codebase") as ResearchKind;
						return {
							kind: assignmentKind(kind),
							prompt: buildResearchPrompt(plan, kind, q.question, q.context),
							...(q.model ? { model: q.model } : {}),
							...(q.effort ? { effort: q.effort as ThinkingLevel } : {}),
							cwd: plan.repoPath,
							displayName: `${kind}-research`,
							meta: {
								question: q.question,
								researchKind: kind,
							},
						};
					}),
				)
				.then((runs) =>
					runs.map((run, index) => {
						const q = params.questions[index];
						const kind = (q.kind ?? "codebase") as ResearchKind;
						const meta = getModelMeta(ctx, run.assignment.modelId);
						const view: ResearchRunView = {
							id: run.runId,
							question: q.question,
							label: researchLabel(q.question),
							kind,
							status: "running",
							startedAt: Date.now(),
							model: meta.shortName,
							adaptive: meta.adaptive,
							effort: run.assignment.effort,
						};
						deps.onRunStarted?.(view, ctx);
						return { view, handle: run.handle };
					}),
				)
				.catch((cause) =>
					params.questions.map((q) => ({
						spawnError: `spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`,
						question: q.question,
					})),
				);

			// Settle the whole round, then compose ONE combined report. Each
			// agent's card/widget row still updates per-agent (onRunSettled),
			// but the MODEL sees the round atomically — never a per-agent trickle.
			const settleRound = async (): Promise<string> => {
				const sections = await Promise.all(
					spawned.map(async (entry) => {
						if ("spawnError" in entry) {
							return `### ${entry.question}\n(${entry.spawnError})`;
						}
						const { view, handle } = entry;
						const result: RunResult = await handle.result().catch((err) => ({
							status: "failed" as const,
							error: err instanceof Error ? err.message : String(err),
						}));
						view.status =
							result.status === "succeeded" ? "succeeded" : "failed";
						// A watchdog-stopped run carries salvaged partial findings in
						// summary — deliver them with a caveat instead of empty-handed
						// failure.
						const report = result.summary?.trim();
						if (!report) {
							deps.onRunSettled?.(view, undefined, ctx);
							return (
								`### ${view.question}\n` +
								`(research agent ${result.status}: ${result.error ?? "no report produced"})`
							);
						}
						// Persist the FULL report to scratch; deliver only the digest
						// plus a dig ref. The maestro reasons on the digest and calls
						// dig(ref) if it needs the full analysis.
						const ref = uniqueRef(researchDir, view.question);
						const path = persistReport(researchDir, view, report, ref);
						deps.onRunSettled?.(view, { text: report, path }, ctx);
						const digest = extractDigest(report);
						const caveat =
							result.status === "succeeded"
								? ""
								: `\n(${result.error ?? result.status} — partial findings salvaged; treat as incomplete)`;
						return `### ${view.question}\n[ref: ${ref}]${caveat}\n${digest}`;
					}),
				);
				return (
					`${sections.join("\n\n")}\n\n` +
					'Each entry is a self-sufficient digest; call `dig("<ref>")` for a ' +
					"report's full analysis if you need more. Evaluate: do these settle " +
					"your open questions, or open new ones? Research further, or call " +
					"`readiness` when the convergence criteria are met."
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
			"Your summarized understanding, ALWAYS in this exact structure (it is " +
			"rendered with headings and bullets for the user to scan — never one " +
			"long paragraph):\n\n" +
			"A one- or two-sentence summary of what will be built.\n\n" +
			"**Key decisions**\n" +
			"- <the decision> — <why it's the choice / what research or answer " +
			"backs it>\n" +
			"- <the decision> — <why>\n\n" +
			"Write it FORWARD-ONLY: state what WILL be done and why. Do NOT " +
			"enumerate rejected alternatives or 'we could have'. Lead each bullet " +
			"with the decision, not the rationale; keep it to one line's idea. " +
			"Scale the number of bullets to the work — a trivial request may have " +
			"one.",
	}),
	open_risks: Type.Optional(
		Type.String({
			description:
				"Risks or open questions you propose to ACCEPT (not resolve), as " +
				"`- ` bullets, one per risk. Omit entirely if there are none — the " +
				"tool then records 'Open risks: none'. Always shown as its own " +
				"section so the user sees what is being waived.",
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

			// The template is fixed: understanding + Key decisions, then an Open
			// risks section that is ALWAYS present ("none" when there are none) so
			// the user always sees what is being waived.
			const risks = params.open_risks?.trim() || "- none";
			const context = `${params.understanding}\n\n**Open risks:**\n${risks}`;
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

const DigParams = Type.Object({
	ref: Type.String({
		description: "The [ref: …] shown beside a research digest to expand.",
	}),
});

export function createDigTool(deps: ResearchDeps): ToolDefinition {
	return defineTool({
		name: "dig",
		label: "Dig",
		description:
			"Return the full analysis behind a research digest. Pass the [ref: …] " +
			"printed beside a digest and you get that report's complete text (the " +
			"digest is a summary of it). Use only when the digest isn't enough.",
		promptSnippet:
			"dig — expand a research digest to its full report (by ref).",
		parameters: DigParams,
		// Full reports are for the MODEL; the human gets a preview + expand.
		renderResult: renderCollapsedResult,
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Result> {
			// Workers have no engine — they resolve the plan dir from the env
			// their spawner set. The maestro resolves through the active plan.
			const envPlanDir = process.env.PI_MAESTRO_PLAN_DIR;
			let dir: string;
			if (envPlanDir) {
				dir = researchReportsDir(envPlanDir);
			} else {
				const engine = deps.engine();
				if (!engine) return error("no plan active");
				dir = researchReportsDir(deps.ensurePlanDir(ctx));
			}
			// Sanitize: refs are slugs, so a path-traversal attempt can't escape.
			const safe = params.ref.replace(/[^a-z0-9-]/gi, "").toLowerCase();
			const path = join(dir, `${safe}.md`);
			if (!safe || !existsSync(path)) {
				const avail = existsSync(dir)
					? readdirSync(dir)
							.filter((f) => f.endsWith(".md"))
							.map((f) => f.slice(0, -3))
					: [];
				return error(
					`no research report "${params.ref}". Available refs: ${avail.join(", ") || "(none)"}`,
				);
			}
			return ok(readFileSync(path, "utf8"));
		},
	}) as ToolDefinition;
}

// ─── Spawn assembly ──────────────────────────────────────────────────────────

function assignmentKind(
	kind: ResearchKind,
): "codebase-research" | "web-research" | "plan-review" | "consult" {
	switch (kind) {
		case "codebase":
			return "codebase-research";
		case "web":
			return "web-research";
		case "advisor":
			return "plan-review";
		case "consult":
			return "consult";
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
		const gaps = panelTopologyGaps(plan.deliverables);
		if (gaps.length) {
			lines.push(
				"",
				"## Automated Panel-Topology Gaps",
				"These were found mechanically — confirm them and look for what the check can't judge (sensitivity, missing multi-model escalation):",
				...gaps.map((g) => `- ${g}`),
			);
		}
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
		if (g.subAgents?.length) {
			const panel = g.subAgents
				.map((s) => {
					const flags = [
						s.required ? "required" : "advisory",
						(s.kind ?? "review") === "helper" ? "helper" : "review",
						s.effort ?? null,
					].filter(Boolean);
					return `${s.persona} (${flags.join(", ")})`;
				})
				.join("; ");
			lines.push(`  panel: ${panel}`);
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
	ref: string,
): string {
	const path = join(researchDir, `${ref}.md`);
	const frontmatter = [
		"---",
		`question: ${JSON.stringify(run.question)}`,
		`kind: ${run.kind}`,
		`ref: ${ref}`,
		`createdAt: ${new Date(run.startedAt).toISOString()}`,
		"---",
		"",
	].join("\n");
	writeFileSync(path, `${frontmatter}${report}\n`);
	return path;
}

/**
 * The durable home of a plan's full research reports: `<planDir>/research/`.
 * This is the location the structuring preamble, /implement guidance, and
 * carry-forward harvest have always pointed at; reports live and die with
 * the plan directory (no separate wipe).
 */
export function researchReportsDir(planDir: string): string {
	return join(planDir, "research");
}

export interface ResearchReportMeta {
	readonly ref: string;
	readonly question: string;
	readonly kind: string;
}

/**
 * List the reports in a research dir, sorted by ref (deterministic). The
 * question/kind come from the report frontmatter; files without parseable
 * frontmatter fall back to the ref.
 */
export function listResearchReports(dir: string): ResearchReportMeta[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.map((file) => {
			const ref = file.slice(0, -3);
			let question = ref;
			let kind = "research";
			try {
				const head = readFileSync(join(dir, file), "utf8").slice(0, 2000);
				const q = head.match(/^question: (.+)$/m);
				if (q) question = String(JSON.parse(q[1]));
				const k = head.match(/^kind: (.+)$/m);
				if (k) kind = k[1].trim();
			} catch {
				// Unreadable/odd frontmatter — the ref alone is still useful.
			}
			return { ref, question, kind };
		});
}

export const RESEARCH_INDEX_HEADER = "## Research Index";

/**
 * Render the mechanical Research Index appended to the frozen knowledge doc:
 * one line per on-disk report so any agent can `dig(ref)` the full text on
 * demand instead of carrying every deep-dive in its context. Returns
 * undefined when there are no reports.
 */
export function renderResearchIndex(dir: string): string | undefined {
	const reports = listResearchReports(dir);
	if (reports.length === 0) return undefined;
	const lines = reports.map(
		(r) => `- [ref: ${r.ref}] ${r.question} (${r.kind})`,
	);
	return [
		RESEARCH_INDEX_HEADER,
		"Full research reports are on disk. Expand any of them with `dig(ref)` " +
			"when your work touches that area — do not guess at details a report " +
			"already settles.",
		lines.join("\n"),
	].join("\n\n");
}

/** Extract the set of `[ref: …]` markers present in a text. */
export function refsInText(text: string): Set<string> {
	const refs = new Set<string>();
	for (const match of text.matchAll(/\[ref: ([a-z0-9-]+)\]/g)) {
		refs.add(match[1]);
	}
	return refs;
}

/**
 * Reports NOT covered by the given text's `[ref: …]` markers — i.e. the
 * research that landed after the frozen knowledge doc (and its Research
 * Index) was written. Seeds list these so later-spawned workers see the
 * expanding picture without the frozen base ever changing.
 */
export function reportsNotInText(
	dir: string,
	text: string | undefined,
): ResearchReportMeta[] {
	const covered = text ? refsInText(text) : new Set<string>();
	return listResearchReports(dir).filter((r) => !covered.has(r.ref));
}

/** A stable, filesystem-safe ref for a question, de-duped within the dir. */
function uniqueRef(dir: string, question: string): string {
	const root = slugify(question).slice(0, 48) || "research";
	if (!existsSync(join(dir, `${root}.md`))) return root;
	for (let n = 2; ; n++) {
		if (!existsSync(join(dir, `${root}-${n}.md`))) return `${root}-${n}`;
	}
}

/**
 * Extract the deliverable digest: the `## Digest` block if the researcher
 * emitted one, else the first paragraph as a fallback. Hard-capped so a
 * run-on can't blow up the transcript.
 */
export function extractDigest(report: string): string {
	const m = report.match(/##\s*Digest\s*\n([\s\S]+?)(?:\n##\s|\s*$)/i);
	let digest = (m ? m[1] : report.split(/\n\s*\n/)[0]).trim();
	if (digest.length > 500) digest = `${digest.slice(0, 499).trimEnd()}…`;
	return digest;
}

// ─── Settle helpers ──────────────────────────────────────────────────────────

/**
 * The one steer a slow-but-productive child gets at the soft deadline. A fresh
 * user message also tends to break tool loops, which liveness can't detect.
 */
const WRAP_UP_STEER =
	"Time budget nearly exhausted. Stop researching NOW and write your final " +
	"report from what you already have: full findings with evidence, then the " +
	"`## Digest` block. State explicitly what you did not get to.";
