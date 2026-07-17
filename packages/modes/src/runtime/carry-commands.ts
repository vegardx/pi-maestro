// /distill and /handoff — the carry-forward episode's entry points, sinks,
// and the context-fill threshold ladder (nudge at modes.distill.nudgeAt,
// force at modes.distill.forceAt; force never blocks on an absent human).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { buildTranscriptDigest, type CarrySink } from "../carry-forward.js";
import { buildCompactionMarker } from "../compaction.js";
import { type DistillSettings, readDistillSettings } from "../settings.js";
import type { RuntimeContext } from "./context.js";

// ─── Directives (the message that drives the episode) ────────────────────────

function distillDirective(opts: {
	forced: boolean;
	fillPct?: number;
	planIntent?: string;
}): string {
	const shared =
		"Propose 3-10 candidate NARRATIVE threads worth carrying — decisions " +
		"made and why, open arguments, deferred topics, in-flight intentions. " +
		"Do NOT propose plan/task/status topics; the mechanical state is " +
		'harvested automatically. Call carryforward({action: "propose", ' +
		'topics: [{id, title, oneLiner, source: "recall", rec}]}); then, after ' +
		'selection, carryforward({action: "write", threads: [...]}) — each body ' +
		"self-sufficient (decisions, state, concrete next step). The harness " +
		"then compacts this session down to your curated document; research " +
		"rehydrates via dig(ref) afterwards.";
	if (!opts.forced) {
		return `[/distill episode started. ${shared}]`;
	}
	return (
		`[Context is ${opts.fillPct?.toFixed(0) ?? "?"}% full — FORCED distill (modes.distill.forceAt). ` +
		"SELF-CURATED: your rec-marked topics carry automatically; no question is asked. " +
		"FIRST do a divergence check: compare the recent work against the arc's founding intent" +
		(opts.planIntent ? ` — ${opts.planIntent}` : "") +
		". If clearly diverged, include a rec topic titled 'divergence' stating original intent vs current direction, " +
		"and after the episode finishes, suggest /handoff to the human in one sentence. " +
		`Then: ${shared}]`
	);
}

function handoffDirective(archaeology: string | undefined): string {
	return (
		"[/handoff episode started — this arc is CLOSING. The document seeds a " +
		"NEW planning session with NO active plan: material for forming the " +
		"next plan, not a resume. Propose threads from BOTH sources: your own " +
		'recall (source: "recall" — deferred topics, open arguments, lessons) ' +
		'and the archaeologist\'s transcript findings below (source: "transcript"). ' +
		'carryforward({action: "propose", ...}) → the human multi-selects → ' +
		'carryforward({action: "write", ...}).' +
		(archaeology
			? `\n\nArchaeologist findings (dropped balls from the transcript on disk):\n${archaeology}`
			: "\n\n(The archaeologist was unavailable — propose from recall only.)") +
		"]"
	);
}

// ─── /distill ────────────────────────────────────────────────────────────────

export function beginDistill(
	rt: RuntimeContext,
	ctx: ExtensionContext,
	opts: { forced?: boolean; fillPct?: number } = {},
): void {
	const plan = rt.engine?.get();
	const sink: CarrySink = async (doc, path, toolCtx) => {
		const nonce = randomUUID();
		rt.pendingCompaction = {
			nonce,
			deliverableId: "maestro",
			reason: opts.forced ? "distill-forced" : "distill",
			summaryOverride: doc,
		};
		toolCtx.compact({ customInstructions: buildCompactionMarker(nonce) });
		return (
			`Distilled — the compaction lands now; the summary IS your curated document (audit: ${path}). ` +
			"Continue working; dig(ref) rehydrates research on demand."
		);
	};
	const ok = rt.carryForward.begin({
		kind: "distill",
		selfCurate: Boolean(opts.forced),
		sink,
	});
	if (!ok) {
		ctx.ui.notify("A carry-forward episode is already running.", "warning");
		return;
	}
	const planIntent = plan
		? clipIntent(
				`"${plan.title}"${plan.understanding ? ` — ${plan.understanding}` : ""}`,
			)
		: undefined;
	rt.pi.sendUserMessage(
		distillDirective({
			forced: Boolean(opts.forced),
			fillPct: opts.fillPct,
			planIntent,
		}),
		{ deliverAs: "followUp" },
	);
	if (!opts.forced) {
		ctx.ui.notify(
			"Distill episode started — curate the threads when asked.",
			"info",
		);
	} else {
		ctx.ui.notify(
			"Context threshold reached — forced distill running (self-curated). Audit lands under the plan's handoffs/.",
			"warning",
		);
	}
}

const clipIntent = (s: string): string =>
	s.length > 600 ? `${s.slice(0, 599)}…` : s;

// ─── /handoff ────────────────────────────────────────────────────────────────

/** Workers still working/summarizing — a handoff would abandon them. */
export function liveWorkers(rt: RuntimeContext): string[] {
	const snap = rt.execution?.snapshot();
	if (!snap) return [];
	return [...snap.agents.entries()]
		.filter(([, a]) => a.status === "working" || a.status === "summarizing")
		.map(([key]) => key);
}

export async function beginHandoff(
	rt: RuntimeContext,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const live = liveWorkers(rt);
	if (live.length > 0) {
		ctx.ui.notify(
			`Handoff refused — ${live.length} agent(s) mid-flight (${live.join(", ")}). ` +
				"Let them finish, or /quit stops the fleet (resumable later with /recover).",
			"warning",
		);
		return;
	}

	const archaeology = await runArchaeologist(rt, ctx);

	const sink: CarrySink = async (_doc, path, toolCtx) => {
		// Close out this arc's runtime before switching sessions.
		if (rt.execution) {
			try {
				await rt.execution.destroy();
			} catch {
				// Dead executors must not block the handoff.
			}
			rt.execution = undefined;
		}
		// The seed is NOT sent from here: this sink runs mid-turn, and a
		// message sent across the session switch gets orphaned in the old
		// turn's follow-up queue — the user landed in a blank session once.
		// Instead the marker rides modes state; session_start (or the
		// belt-and-braces schedule below) delivers when the agent is idle.
		rt.state = { ...rt.state, pendingHandoffSeedPath: path };
		const result = await ctx.newSession();
		if (result.cancelled) {
			rt.state = { ...rt.state, pendingHandoffSeedPath: undefined };
			return `Handoff document written to ${path}, but the new session was cancelled — /new manually; the seed is on disk.`;
		}
		// We are IN the new session now: no active plan, plan mode, seeded.
		rt.engine = undefined;
		rt.state = { ...rt.state, activePlanSlug: undefined };
		rt.persist();
		rt.setMode("plan", toolCtx);
		scheduleHandoffArrival(rt, toolCtx);
		return `Arc closed — seed written to ${path}; the new planning session is opening.`;
	};

	const ok = rt.carryForward.begin({
		kind: "handoff",
		selfCurate: false,
		sink,
	});
	if (!ok) {
		ctx.ui.notify("A carry-forward episode is already running.", "warning");
		return;
	}
	rt.pi.sendUserMessage(handoffDirective(archaeology), {
		deliverAs: "followUp",
	});
	ctx.ui.notify(
		"Handoff episode started — the archaeologist's findings feed the proposal; curate when asked.",
		"info",
	);
}

// ─── Handoff arrival (the NEW session's side) ────────────────────────────────

/** Custom-message type of the arrival card; also the delivered-once marker. */
export const HANDOFF_ARRIVAL_ENTRY = "maestro.handoff.arrival";

const ARRIVAL_POLL_MS = 400;
/** ~20s of idle-polling, then deliver as a follow-up rather than never. */
const ARRIVAL_MAX_POLLS = 50;

/**
 * The handoff seed as a system-prompt block for the plan-mode preamble.
 * Rides EVERY plan-mode turn while no plan is active — the doc is the raw
 * material for the next plan, and it's cache-stable (constant per session).
 * Retires automatically once a plan exists.
 */
export function handoffSeedPromptBlock(rt: RuntimeContext): string | undefined {
	const path = rt.state.pendingHandoffSeedPath;
	if (!path) return undefined;
	// A draft engine is auto-opened the moment plan mode starts — the seed
	// must survive that. It retires once a REAL plan is formed.
	if (rt.engine && !rt.engine.isDraft()) return undefined;
	try {
		const doc = readFileSync(path, "utf8");
		return `## Handoff seed (previous arc — raw material for the next plan, context only)\n${doc}`;
	} catch {
		return undefined;
	}
}

/**
 * Deliver the arrival experience in the post-handoff session: the extension-
 * owned card (exists even if the model never speaks) and the orientation
 * prompt (fires a model turn). Deferred + idle-gated because the sink runs
 * mid-turn: a message sent across the session switch lands in the DYING
 * turn's follow-up queue and is orphaned — the blank-session bug.
 *
 * Idempotent: the card entry doubles as the delivered-once marker, so the
 * sink and session_start can both call this (and a reopened session won't
 * re-orient).
 */
export function scheduleHandoffArrival(
	rt: RuntimeContext,
	ctx: ExtensionContext,
): void {
	const path = rt.state.pendingHandoffSeedPath;
	if (!path || rt.handoffArrivalScheduled) return;
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	if (hasArrivalCard(entries)) return;
	rt.handoffArrivalScheduled = true;
	let polls = 0;
	const attempt = () => {
		if (rt.state.pendingHandoffSeedPath !== path) {
			rt.handoffArrivalScheduled = false;
			return;
		}
		if (!ctx.isIdle?.() && polls < ARRIVAL_MAX_POLLS) {
			polls += 1;
			const t = setTimeout(attempt, ARRIVAL_POLL_MS);
			t.unref?.();
			return;
		}
		rt.handoffArrivalScheduled = false;
		deliverArrival(rt, ctx, path);
	};
	attempt();
}

function deliverArrival(
	rt: RuntimeContext,
	ctx: ExtensionContext,
	path: string,
): void {
	let doc = "";
	try {
		doc = readFileSync(path, "utf8");
	} catch {
		// Card still renders with the path; the seed block will be absent too.
	}
	rt.pi.sendMessage(
		{
			customType: HANDOFF_ARRIVAL_ENTRY,
			content: buildArrivalCard(path, doc),
			display: true,
		},
		{ triggerTurn: false },
	);
	ctx.ui?.notify?.("New arc — continuing from a handoff.", "info");
	rt.pi.sendUserMessage(
		"[New arc from a /handoff. The full handoff seed is in your system " +
			"context under '## Handoff seed' — CONTEXT ONLY, raw material for " +
			"the NEXT plan. Open with ONE short orientation paragraph (where " +
			"things stand, your suggested first arc) and then WAIT for the " +
			"human. Do not start research or form a plan until asked.]",
		{ deliverAs: "followUp" },
	);
}

function buildArrivalCard(path: string, doc: string): string {
	const threads = (doc.match(/^### /gm) ?? []).length;
	const radarSection = doc.split(/^## Also on the radar$/m)[1];
	const radar = radarSection ? (radarSection.match(/^- /gm) ?? []).length : 0;
	const facts = [
		`${threads} thread(s) carried`,
		`${radar} radar item(s)`,
		...(/^## Divergence note$/m.test(doc) ? ["divergence noted"] : []),
	];
	const prevPlan = doc.match(/via \/plan ([^\s.]+)/)?.[1];
	const lines = [
		"⇄ New arc — continuing from a handoff",
		doc ? `Carried: ${facts.join(" · ")}` : "(seed document unreadable)",
		`Seed: ${path}`,
	];
	if (prevPlan) lines.push(`Previous arc: /plan ${prevPlan} reopens it`);
	return lines.join("\n");
}

function hasArrivalCard(entries: readonly unknown[]): boolean {
	return entries.some((entry) => {
		const e = entry as { type?: string; customType?: string };
		return (
			(e.type === "custom_message" || e.type === "custom") &&
			e.customType === HANDOFF_ARRIVAL_ENTRY
		);
	});
}

/**
 * The transcript archaeologist: a read-only subagent over a mechanical digest
 * of THIS session's entries, hunting dropped balls the in-context maestro is
 * blind to. Soft-fails to undefined — a handoff never blocks on it.
 */
async function runArchaeologist(
	rt: RuntimeContext,
	ctx: ExtensionContext,
): Promise<string | undefined> {
	const subagents = rt.maestro.capabilities.get(CAPABILITIES.subagents);
	const entries = ctx.sessionManager?.getEntries?.();
	if (!subagents || !entries?.length) return undefined;
	const digest = buildTranscriptDigest(entries as never[]);
	if (!digest) return undefined;
	try {
		ctx.ui.notify("Archaeologist reading the transcript…", "info");
		const handle = subagents.spawn(
			"Analyze this session digest for DROPPED BALLS. Report at most 6 findings, " +
				"each ONE line: `- <short title>: <what was dropped and where>`. Hunt exactly three patterns: " +
				"(1) user questions or requests that never got an answer or action; " +
				"(2) stated intentions ('we'll do X', 'later') with no visible follow-through; " +
				"(3) direction changes that silently orphaned a thread of work. " +
				"Nothing else — no summary, no advice. If nothing was dropped, reply `- (clean)`.\n\n" +
				digest,
			{
				profile: "research",
				cwd: ctx.cwd,
				tools: { allow: ["read", "grep", "find", "ls"] },
				thinking: "medium",
				session: false,
				isolateExtensions: true,
			},
		);
		// The timer MUST be cleared once the run settles: a stale timeout that
		// fires stop() on a finished run detonated as an uncaught exception in
		// the post-handoff session once (RpcClient throws "Client not started").
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<{ status: string; summary?: string }>(
			(resolve) => {
				timer = setTimeout(() => {
					try {
						handle.stop("timeout");
					} catch {
						// Completion raced the timeout — nothing to stop.
					}
					resolve({ status: "failed" });
				}, 3 * 60_000);
				timer.unref?.();
			},
		);
		let result: { status: string; summary?: string };
		try {
			result = await Promise.race([handle.result(), timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		const report = result.summary?.trim();
		return result.status === "succeeded" && report ? report : undefined;
	} catch {
		return undefined;
	}
}

// ─── The context-fill ladder ─────────────────────────────────────────────────

/**
 * Warn/nudge/force as the maestro's context fills. Ladder (high → low):
 * 90% error, 70% warning, forceAt (default 50%) self-curated distill,
 * nudgeAt (default 30%) non-blocking question. One firing per step per fill
 * cycle; everything re-arms when usage drops back down (a distill does that).
 */
export function contextFillLadder(
	rt: RuntimeContext,
	ctx: ExtensionContext,
): void {
	const usage = ctx.getContextUsage?.();
	const pct = usage?.percent;
	if (typeof pct !== "number") return;
	let settings: DistillSettings;
	try {
		settings = readDistillSettings(ctx.cwd);
	} catch {
		settings = { nudgeAt: 0.3, forceAt: 0.5 };
	}
	const nudge =
		settings.nudgeAt > 0 ? settings.nudgeAt * 100 : Number.POSITIVE_INFINITY;
	const force =
		settings.forceAt > 0 ? settings.forceAt * 100 : Number.POSITIVE_INFINITY;
	const lowest = Math.min(nudge, force, 70);
	if (pct < lowest - 5) {
		rt.contextWarnedAt = 0;
		return;
	}

	const detail =
		usage && usage.tokens !== null && usage.contextWindow
			? ` (${Math.round((usage.tokens ?? 0) / 1000)}k/${Math.round(usage.contextWindow / 1000)}k)`
			: "";

	type Step = { at: number; run: () => void };
	const steps: Step[] = [
		{
			at: 90,
			run: () =>
				ctx.ui.notify(
					`Maestro context ${pct.toFixed(0)}% full${detail} — deep in the dumb zone. /distill NOW or /handoff.`,
					"error",
				),
		},
		{
			at: 70,
			run: () =>
				ctx.ui.notify(
					`Maestro context ${pct.toFixed(0)}% full${detail} — /distill (in place) or /handoff (new arc).`,
					"warning",
				),
		},
		{
			at: force,
			run: () => {
				if (rt.carryForward.get()) return; // an episode is already running
				// turn_end fires BETWEEN the round-trips of an agentic run, so
				// firing here would inject the forced-distill directive into the
				// middle of ongoing work. Arm instead; agent_settled (the session
				// truly idle) fires it via firePendingForcedDistill.
				rt.pendingForcedDistill = { fillPct: pct };
				ctx.ui.notify(
					`Maestro context ${pct.toFixed(0)}% full${detail} — forced /distill queued for when the current work settles.`,
					"warning",
				);
			},
		},
		{
			at: nudge,
			run: () => nudgeDistill(rt, ctx, pct, detail),
		},
	].sort((a, b) => b.at - a.at);

	for (const step of steps) {
		if (pct >= step.at && rt.contextWarnedAt < step.at) {
			rt.contextWarnedAt = step.at;
			step.run();
			break;
		}
	}
}

/**
 * Fire an armed forced distill now that the run has actually finished
 * (agent_settled). No-op when nothing is armed or an episode is already live.
 */
export function firePendingForcedDistill(
	rt: RuntimeContext,
	ctx: ExtensionContext,
): void {
	const armed = rt.pendingForcedDistill;
	if (!armed) return;
	rt.pendingForcedDistill = undefined;
	if (rt.carryForward.get()) return;
	beginDistill(rt, ctx, { forced: true, fillPct: armed.fillPct });
}

function nudgeDistill(
	rt: RuntimeContext,
	ctx: ExtensionContext,
	pct: number,
	detail: string,
): void {
	const ask = rt.maestro?.capabilities?.get(CAPABILITIES.ask);
	if (!ask) {
		ctx.ui.notify(
			`Maestro context ${pct.toFixed(0)}%${detail} — a /distill now keeps the session sharp.`,
			"info",
		);
		return;
	}
	void ask
		.ask([
			{
				id: "distill:nudge",
				question: `Context ${pct.toFixed(0)}% full${detail} — distill now, while the session is still sharp?`,
				header: "distill",
				options: [
					{
						value: "distill",
						label: "Distill now — curated compaction, same session",
					},
					{
						value: "later",
						label:
							"Not now (a self-curated distill runs at the force threshold)",
					},
				],
				recommendation: "distill",
			},
		])
		.then((answers) => {
			const a = answers.find((x) => x.questionId === "distill:nudge");
			if (a?.value === "distill" && !rt.carryForward.get()) {
				beginDistill(rt, ctx, {});
			}
		})
		.catch(() => {
			// Ask surface failure — the force threshold still backstops.
		});
}
