// The worker-side `review` tool — the review episode's state machine.
//
//   review()                    → run the persona panel ONCE; mint finding ids
//   review({resolutions})       → file resolutions, then ONE scope-locked
//                                 verifier judges the fixed claims
//   review({action: "repair"})  → re-run only the reviewers that failed
//   review({action: "panel"})   → explicit fresh round (new episode)
//
// The panel is open-scope and runs once; every later run is a closed-scope
// verification of claims, so the loop terminates by construction. The ledger
// (minted ids, resolutions, checks) is reported upward after every run — the
// executor persists it on the plan and gates ship on "blocking ledger empty".
//
// Rounds settle ASYNCHRONOUSLY: a spawning call acknowledges immediately (run
// ids only, no gate claim) and the report is injected as a user message when
// the round settles. Awaiting a whole panel inside execute() wedged the worker
// mid-tool-call for up to PANEL_HARD_TIMEOUT_MS — maestro steers queued behind
// the turn, and interrupting a reviewer stranded the tool call.

import {
	type AgentToolResult,
	defineTool,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { RunId, SubagentsCapabilityV1 } from "@vegardx/pi-contracts";
import {
	applyChecks,
	applyResolutions,
	buildLedger,
	type ClaimCheck,
	type FindingResolution,
	ledgerSummary,
	openBlocking,
	openDisputed,
	type PendingReviewRound,
	parseJsonFindings,
	type ReviewLedger,
	renderFinding,
	renderLedger,
	type StructuredFinding,
} from "./exec/findings.js";
import {
	DEFAULT_TIMEOUT_MS,
	type PanelResult,
	type PanelRunStart,
	panelResultFromRun,
	type RunPanelDeps,
	startReviewPanel,
} from "./panel.js";
import { buildVerifierProfile } from "./personas.js";
import type { SubAgentSpec } from "./schema.js";
import { renderCollapsedResult } from "./tool-render.js";

/** Panel + persisted episode state, fetched live from the maestro. */
export interface PanelState {
	readonly panel: readonly SubAgentSpec[];
	/** Persisted ledger — a respawned worker resumes its episode from this. */
	readonly ledger?: ReviewLedger;
	/** Canonical finding ids the human waived (excluded from the gate). */
	readonly waived?: readonly string[];
}

export interface ReviewToolDeps {
	readonly subagents: () => SubagentsCapabilityV1 | undefined;
	readonly panelState: () => PanelState | Promise<PanelState>;
	/** The worktree the reviewers/verifier read (usually process.cwd()). */
	readonly cwd: () => string;
	/** Resolve reviewer policy; omitted spec is the fixed verifier default. */
	readonly resolveModel?: (
		ctx: ExtensionContext,
		spec?: SubAgentSpec,
	) => Promise<{
		model: string;
		effort?: import("@vegardx/pi-contracts").ThinkingLevel;
	}>;
	/**
	 * Report a run + the resulting ledger upward (ship gate). "round-started"
	 * carries no results — it persists the ledger's `pendingRound` crash
	 * marker before the spawning call returns, so a respawned worker can
	 * reattach to the round instead of duplicating it.
	 */
	readonly report?: (
		roundKind: "panel" | "verification" | "round-started",
		results: readonly PanelResult[],
		ledger: ReviewLedger,
	) => void;
	/**
	 * Deliver a settled round's report to the worker as an injected user
	 * message (pi.sendUserMessage deliverAs:"followUp" — the same channel
	 * maestro steers arrive on). Rounds settle behind the tool call, so this
	 * is the ONLY way findings reach the worker; there is no blocking mode.
	 */
	readonly deliver: (text: string) => void;
	readonly timeoutMs?: () => number;
	/** Poll cadence while a reattached round waits out still-active runs in
	 *  the shared store (test hook; defaults to REATTACH_POLL_MS). */
	readonly reattachPollMs?: () => number;
	readonly now?: () => string;
}

type Result = AgentToolResult<{ gate?: boolean }>;

const ResolutionParam = Type.Object({
	id: Type.String({ description: "Canonical finding id from the ledger" }),
	status: Type.Union([
		Type.Literal("fixed"),
		Type.Literal("unchanged"),
		Type.Literal("disputed"),
		Type.Literal("needs-user"),
		Type.Literal("duplicateOf"),
	]),
	note: Type.String({
		description:
			"fixed: why the fix commit resolves it. unchanged: why an advisory finding remains. disputed/needs-user: evidence-bearing escalation. duplicateOf: why same.",
	}),
	evidence: Type.Optional(Type.Array(Type.String())),
	fixCommit: Type.Optional(
		Type.String({
			description: "fixed only: immutable commit containing the fix",
		}),
	),
	canonical: Type.Optional(
		Type.String({ description: "duplicateOf only: the id it merges into" }),
	),
});

const ReviewParams = Type.Object({
	action: Type.Optional(
		Type.Union(
			[Type.Literal("panel"), Type.Literal("verify"), Type.Literal("repair")],
			{
				description:
					"Usually omitted: first call runs the panel, calls with " +
					"resolutions verify. repair = re-run only failed reviewers.",
			},
		),
	),
	resolutions: Type.Optional(
		Type.Array(ResolutionParam, {
			description:
				"One entry per open blocking finding (minors optional): how you " +
				"resolved it. Triggers the scoped verification run.",
		}),
	),
});

interface Episode {
	ledger: ReviewLedger;
	/** Last panel round's results, for repair (re-run only the failed). */
	lastResults: readonly PanelResult[];
}

export function createReviewTool(deps: ReviewToolDeps): ToolDefinition {
	// One worker owns one deliverable, so one episode. Rehydrated from the
	// persisted ledger (panelState) after a respawn; reset by an explicit
	// action:"panel" (the executor clears the persisted ledger on send-back).
	let episode: Episode | undefined;
	// The round settling behind the last spawning call. While set, review() is
	// a no-op pointer at the pending report — a second round would fork the
	// episode state the background settle is about to write.
	let inFlight: "panel" | "repair" | "verify" | undefined;
	const now = () => (deps.now ? deps.now() : new Date().toISOString());

	return defineTool({
		name: "review",
		label: "Review",
		description:
			"Your review episode. First call (no args) starts the full reviewer " +
			"panel ONCE; the findings report (with canonical ids) arrives as a " +
			"new message that wakes you — after starting it, END YOUR TURN and " +
			"idle. Never poll for it (no sleep loops, no status commands): " +
			"polling burns tokens and delays delivery, since a busy turn queues " +
			"the report instead of receiving it. Then resolve every " +
			"blocking finding (fix+commit / unchanged for minors / dispute or " +
			"needs-user with evidence / duplicateOf) and call again with `resolutions` — a " +
			"scope-locked verifier checks exactly your claims, reporting the " +
			"same way. Ship is blocked until no blocking finding is open. " +
			"Disputes go to the maestro, not another review round.",
		promptSnippet:
			"review — start your review panel once, then END YOUR TURN (the " +
			"report arrives as a message that wakes you; never sleep-poll for " +
			"it), then verify your fixes (resolutions: " +
			"fixed/unchanged/disputed/needs-user/duplicateOf per finding id).",
		parameters: ReviewParams,
		// Panel rounds concatenate full reviewer reports — the WORKER model
		// needs them; the human watching the pane gets a preview + expand.
		renderResult: renderCollapsedResult,
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Result> {
			// Checked before anything else (no RPC, no rehydration): a second
			// spawn-capable call while a round settles must be a pure no-op.
			if (inFlight) {
				return text(
					`A review round (${inFlight}) is already running. END YOUR TURN and idle — the report arrives as a new message that wakes you. Never poll for it (no sleep loops, no status commands); a busy turn queues the report instead of receiving it. Do not re-run review().`,
				);
			}
			const subagents = deps.subagents();
			if (!subagents) {
				return text("review unavailable: subagents not loaded");
			}
			const state = await deps.panelState();
			const panel = state.panel;
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
			// Rehydrate a respawned worker's episode from the persisted ledger.
			if (!episode && state.ledger) {
				episode = { ledger: state.ledger, lastResults: [] };
			}
			const waived = new Set(state.waived ?? []);

			// A round persisted as in-flight by a previous process (its settle
			// continuation died with it): NEVER spawn a duplicate — the round's
			// reviewers ran (or are still running) in the shared store. Reattach
			// to the recorded runs and settle them exactly like a normal round;
			// this call gets the standard in-flight ack.
			const pendingRound = episode?.ledger.pendingRound;
			if (pendingRound) {
				inFlight =
					pendingRound.kind === "verification" ? "verify" : pendingRound.kind;
				settleInBackground(() =>
					reattachRound(subagents, pendingRound, panel, waived),
				);
				return text(
					`A review round (${inFlight}) is already running. END YOUR TURN and idle — the report arrives as a new message that wakes you. Never poll for it (no sleep loops, no status commands); a busy turn queues the report instead of receiving it. Do not re-run review().`,
				);
			}

			const action =
				params.action ??
				(params.resolutions?.length ? "verify" : episode ? undefined : "panel");

			if (action === "panel" || (!episode && !action)) {
				return await startPanelRound(deps, subagents, panel, waived, ctx);
			}
			if (action === "repair") {
				return await startRepairRound(deps, subagents, panel, waived, ctx);
			}
			if (action === "verify") {
				return await startVerification(
					deps,
					subagents,
					params.resolutions ?? [],
					waived,
					ctx,
				);
			}
			// Episode exists, no resolutions, no explicit action: the panel ran —
			// point the worker at the resolution contract instead of silently
			// re-running an open-scope round (panel-once is the invariant).
			const open = openBlocking(episode!.ledger, waived);
			return text(
				open.length === 0
					? `Panel already ran and no blocking findings are open (${ledgerSummary(episode!.ledger, 0).split(" · ")[1]}). Nothing to verify.\n\n${renderLedger(episode!.ledger, waived)}`
					: `The panel already ran — do not re-run it. Resolve every open blocking finding and call review({resolutions: [...]}):\n\n${renderLedger(episode!.ledger, waived)}`,
				open.length === 0,
			);
		},
	}) as ToolDefinition;

	function text(t: string, gate?: boolean): Result {
		return {
			content: [{ type: "text", text: t }],
			details: gate === undefined ? {} : { gate },
		};
	}

	/** RunPanelDeps for one round, with the tool ctx bound into resolveModel. */
	function panelDeps(
		d: ReviewToolDeps,
		subagents: SubagentsCapabilityV1,
		ctx: ExtensionContext,
	): RunPanelDeps {
		return {
			subagents,
			cwd: d.cwd(),
			resolveModel: d.resolveModel
				? (spec) => d.resolveModel!(ctx, spec)
				: undefined,
			timeoutMs: d.timeoutMs?.(),
		};
	}

	/** The immediate acknowledgment for a spawned round — names + run ids,
	 *  never a gate claim (the gate travels with the settled report). */
	function runningText(
		label: string,
		started: ReadonlyArray<Pick<PanelRunStart, "name" | "runId">>,
	) {
		const who = started
			.map((s) => (s.runId ? `${s.name} (${s.runId})` : s.name))
			.join(", ");
		return text(
			`${label} running: ${who}. END YOUR TURN and idle — the report arrives as a new message that wakes you when the round settles. Never poll for it (no sleep loops, no status commands): polling burns tokens and a busy turn queues the report instead of receiving it. Do not re-run review().`,
		);
	}

	/**
	 * Settle a spawned round behind the returned tool result and inject the
	 * report. inFlight clears BEFORE delivery so the worker's reaction to the
	 * report (repair/verify) is never bounced by its own round's guard. A
	 * throw here is a harness bug, not a reviewer failure — the worker gets
	 * told to escalate rather than a silently vanished round. A null report
	 * means the round lost the delivery latch (another settle path already
	 * reported it) — nothing is injected.
	 */
	function settleInBackground(round: () => Promise<string | null>): void {
		void round()
			.catch(
				(err) =>
					`Review round failed to settle: ${err instanceof Error ? err.message : String(err)}. Raise this with the maestro via the ask tool instead of re-running review().`,
			)
			.then((report) => {
				inFlight = undefined;
				if (report !== null) deps.deliver(report);
			});
	}

	/**
	 * Record a round as in-flight ON THE LEDGER and report the marker upward
	 * BEFORE the spawning call returns: the settle continuation lives only in
	 * this process, so the persisted marker is what a respawned worker uses to
	 * reattach instead of spawning a duplicate round. A first panel round has
	 * no episode yet — the marker rides an empty stub ledger.
	 */
	function markRoundPending(
		d: ReviewToolDeps,
		kind: PendingReviewRound["kind"],
		started: ReadonlyArray<Pick<PanelRunStart, "name" | "runId">>,
	): PendingReviewRound {
		const pending: PendingReviewRound = {
			kind,
			// Only runs that actually spawned are reattachable; a spawn that
			// failed before yielding an id settled as failed already.
			runs: started.flatMap((s) =>
				s.runId ? [{ name: s.name, runId: s.runId }] : [],
			),
			startedAt: now(),
		};
		episode = episode
			? { ...episode, ledger: { ...episode.ledger, pendingRound: pending } }
			: {
					ledger: {
						round: 1,
						cycle: 0,
						entries: [],
						pendingRound: pending,
						updatedAt: now(),
					},
					lastResults: [],
				};
		d.report?.("round-started", [], episode.ledger);
		return pending;
	}

	/**
	 * The delivery latch, checked right before a settled round reports: the
	 * persisted `pendingRound` marker is the source of truth for who owns the
	 * round's single report + delivery. If the marker no longer matches ours,
	 * a competing settle path — a respawned worker's reattach, or the original
	 * round racing that reattach — already reported it; adopt the persisted
	 * outcome and deliver nothing. A state without any persisted ledger never
	 * had the marker persisted, so no competitor can exist — claim granted.
	 */
	async function claimSettle(pending: PendingReviewRound): Promise<boolean> {
		let persisted: PanelState;
		try {
			persisted = await deps.panelState();
		} catch {
			// An unreadable store cannot prove a competing settle — the round
			// must not strand undelivered on a transient read failure.
			return true;
		}
		if (!persisted.ledger) return true;
		const marker = persisted.ledger.pendingRound;
		if (marker && sameRound(marker, pending)) return true;
		episode = {
			ledger: persisted.ledger,
			lastResults: episode?.lastResults ?? [],
		};
		return false;
	}

	async function startPanelRound(
		d: ReviewToolDeps,
		subagents: SubagentsCapabilityV1,
		panel: readonly SubAgentSpec[],
		waived: ReadonlySet<string>,
		ctx: ExtensionContext,
	): Promise<Result> {
		// Each reviewer runs exactly once. No inline rerun of failures here —
		// that layer stacked on the panel's own (since removed) retry to run one
		// reviewer up to four times per "single" round. Failed reviewers stay
		// failed in the settled partial panel; only an explicit
		// review({action:"repair"}) retries them, once.
		const started = await startReviewPanel(panel, panelDeps(d, subagents, ctx));
		const pending = markRoundPending(d, "panel", started);
		inFlight = "panel";
		settleInBackground(async () => {
			const results = await Promise.all(started.map((s) => s.settled));
			if (!(await claimSettle(pending))) return null;
			const ledger: ReviewLedger = {
				...buildLedger(
					results
						.filter((r) => r.kind === "review" && r.ok)
						.map((r) => ({ reviewer: r.name, findings: r.structured })),
					now(),
				),
				participants: results
					.filter((r) => r.kind === "review")
					.map((r) => participant(r, 1)),
			};
			episode = { ledger, lastResults: results };
			d.report?.("panel", results, ledger);
			return renderPanelReport(results, ledger, waived);
		});
		return runningText("Review panel", started);
	}

	async function startRepairRound(
		d: ReviewToolDeps,
		subagents: SubagentsCapabilityV1,
		panel: readonly SubAgentSpec[],
		waived: ReadonlySet<string>,
		ctx: ExtensionContext,
	): Promise<Result> {
		if (!episode) {
			return text("Nothing to repair — the panel has not run yet.");
		}
		const ep = episode;
		const okNames = new Set([
			...ep.lastResults.filter((r) => r.ok).map((r) => r.name),
			// After a respawn lastResults is empty — the persisted participants
			// carry which reviewers already reported validly, so repair still
			// re-runs ONLY the failed ones.
			...(ep.ledger.participants ?? []).filter((p) => p.ok).map((p) => p.name),
		]);
		const failedSpecs = panel.filter((s) => !okNames.has(s.name));
		if (failedSpecs.length === 0) {
			return text("Nothing to repair — every reviewer reported.");
		}
		// One new attempt per selected reviewer; successful reviewers are never
		// re-run, and their earlier findings stay in the ledger — the repaired
		// results merge in by reviewer identity.
		const prevAttempt = new Map(
			(ep.ledger.participants ?? []).map((p) => [p.name, p.attempt ?? 1]),
		);
		const started = await startReviewPanel(
			failedSpecs,
			panelDeps(d, subagents, ctx),
		);
		const pending = markRoundPending(d, "repair", started);
		inFlight = "repair";
		settleInBackground(async () => {
			const repaired = await Promise.all(started.map((s) => s.settled));
			if (!(await claimSettle(pending))) return null;
			const merged = [
				...ep.lastResults.filter((r) => okNames.has(r.name)),
				...repaired,
			];
			const attemptOf = (r: PanelResult) =>
				okNames.has(r.name)
					? (prevAttempt.get(r.name) ?? 1)
					: (prevAttempt.get(r.name) ?? 1) + 1;
			const ledger: ReviewLedger = {
				...ep.ledger,
				entries: [
					...ep.ledger.entries,
					...buildLedger(
						repaired
							.filter((r) => r.kind === "review" && r.ok)
							.map((r) => ({ reviewer: r.name, findings: r.structured })),
						now(),
					).entries,
				],
				participants: merged
					.filter((r) => r.kind === "review")
					.map((r) => participant(r, attemptOf(r))),
				updatedAt: now(),
			};
			episode = { ledger, lastResults: merged };
			d.report?.("panel", merged, ledger);
			return renderPanelReport(merged, ledger, waived);
		});
		return runningText("Repair round", started);
	}

	async function startVerification(
		d: ReviewToolDeps,
		subagents: SubagentsCapabilityV1,
		resolutions: readonly FindingResolution[],
		waived: ReadonlySet<string>,
		ctx: ExtensionContext,
	): Promise<Result> {
		if (!episode) {
			return text(
				"No review episode — run review() first to get the panel's findings.",
			);
		}
		if (resolutions.length === 0) {
			return text(
				`verify needs resolutions — one per open blocking finding:\n\n${renderLedger(episode.ledger, waived)}`,
			);
		}
		const applied = applyResolutions(
			episode.ledger,
			resolutions,
			now(),
			waived,
		);
		if (!applied.ok) {
			return text(
				`Resolutions rejected (nothing was applied):\n${applied.errors.map((e) => `- ${e}`).join("\n")}`,
			);
		}
		episode = { ...episode, ledger: applied.ledger };

		// The claims to verify: fixed + not yet verified. Disputes and wont-fix
		// need no verifier — disputes go to triage, minors are decided. No spawn
		// here, so these results stay synchronous (gate detail included).
		const claims = applied.ledger.entries.filter(
			(e) =>
				e.resolution?.status === "fixed" &&
				e.check?.result !== "verified" &&
				!waived.has(e.finding.id),
		);
		if (claims.length === 0) {
			d.report?.("verification", [], applied.ledger);
			const open = openBlocking(applied.ledger, waived);
			const disputed = openDisputed(applied.ledger, waived);
			if (open.length === 0) {
				return text(
					`Nothing to verify and no blocking findings open — the gate is clear.\n\n${renderLedger(applied.ledger, waived)}`,
					true,
				);
			}
			return text(
				`No fixed claims to verify. ${disputed.length} disputed finding(s) await the maestro's triage — you are done with them; finish your remaining work.\n\n${renderLedger(applied.ledger, waived)}`,
				false,
			);
		}

		const verifierName = `verifier-${applied.ledger.cycle + 1}`;
		const resolvedVerifier = await d.resolveModel?.(ctx);
		const profile = buildVerifierProfile({
			cwd: d.cwd(),
			model: resolvedVerifier?.model,
		});
		const prompt = buildVerifierPrompt(
			claims.map((e) => e),
			{
				base: claims[0]?.finding.provenance?.[0]?.commit,
				head: claims[0]?.resolution?.fixCommit,
			},
		);
		const timeoutMs = d.timeoutMs?.() ?? DEFAULT_TIMEOUT_MS;

		// One attempt — a failed/empty verifier is reported back to the worker,
		// which re-invokes verify explicitly. No implicit re-spawn layers.
		const handle = subagents.spawn(prompt, profile);
		const pending = markRoundPending(d, "verification", [
			{
				name: verifierName,
				...(handle.id ? { runId: String(handle.id) } : {}),
			},
		]);
		inFlight = "verify";
		settleInBackground(async () => {
			const run = await settleRun(handle, timeoutMs);
			if (!(await claimSettle(pending))) return null;
			const report = run.summary?.trim() ?? "";
			if (run.status !== "succeeded" || !report) {
				// The round is over even though it produced nothing: report the
				// resolution-carrying ledger upward WITHOUT the marker, so the
				// pending round clears (a lingering marker would make every
				// respawn reattach to this dead run) and the applied resolutions
				// survive a respawn.
				episode = { ...episode!, ledger: applied.ledger };
				d.report?.("verification", [], applied.ledger);
				return `Verifier ${run.status}: ${run.error ?? "no report"} — fix nothing, just run review({action: "verify", resolutions: [...]}) again.`;
			}
			const parsed = parseVerifierReport(report, claims);
			const { ledger: checked, errors } = applyChecks(
				applied.ledger,
				parsed.checks,
				parsed.regressions,
				verifierName,
				now(),
			);
			episode = { ...episode!, ledger: checked };
			d.report?.("verification", [], checked);
			return renderVerificationReport(checked, waived, errors, report);
		});
		return runningText("Verifier", [
			{
				name: verifierName,
				...(handle.id ? { runId: String(handle.id) } : {}),
			},
		]);
	}

	/**
	 * Settle a round a PREVIOUS process left in flight: harvest its recorded
	 * runs from the shared store (waiting out still-active ones, bounded by
	 * the panel deadline measured from the ROUND's original start), push the
	 * stored summaries through the exact same validation as a live settle,
	 * then merge, report, and deliver like a normal round. Never spawns.
	 */
	async function reattachRound(
		subagents: SubagentsCapabilityV1,
		pending: PendingReviewRound,
		panel: readonly SubAgentSpec[],
		waived: ReadonlySet<string>,
	): Promise<string | null> {
		// The rehydrated ledger minus the marker: the base every settled shape
		// (repair merge, verification checks) builds on.
		const { pendingRound: _cleared, ...prior } = episode!.ledger;
		const timeoutMs = deps.timeoutMs?.() ?? DEFAULT_TIMEOUT_MS;
		const startedMs = Date.parse(pending.startedAt);
		// Time that elapsed before the respawn counts: a round near its cap
		// when the process died times out promptly, not a full cap later.
		const deadline =
			(Number.isFinite(startedMs) ? startedMs : Date.now()) + timeoutMs;
		const pollMs = deps.reattachPollMs?.() ?? REATTACH_POLL_MS;

		if (pending.kind === "verification") {
			return reattachVerification(
				subagents,
				pending,
				waived,
				prior,
				deadline,
				pollMs,
			);
		}

		const specByName = new Map(panel.map((s) => [s.name, s]));
		const results = await Promise.all(
			pending.runs.map(async ({ name, runId }) => {
				const spec = specByName.get(name);
				const kind = spec?.kind ?? "review";
				const run = await harvestRun(subagents, runId, deadline, pollMs);
				return panelResultFromRun(
					{
						name,
						persona: spec?.persona ?? name,
						required: Boolean(spec?.required),
						kind,
						runId,
					},
					kind,
					run,
				);
			}),
		);
		// Panel reviewers the marker has no run id for never spawned (or died
		// before an id was recorded) — surface them as failed so the repair
		// path can target them instead of silently dropping a required seat.
		const lost =
			pending.kind === "panel"
				? panel
						.filter(
							(s) =>
								(s.kind ?? "review") === "review" &&
								!pending.runs.some((r) => r.name === s.name),
						)
						.map((s) =>
							panelResultFromRun(
								{
									name: s.name,
									persona: s.persona,
									required: Boolean(s.required),
									kind: "review",
								},
								"review",
								{
									status: "failed",
									error: "run was never recorded (lost at respawn)",
								},
							),
						)
				: [];
		const all = [...results, ...lost];
		if (!(await claimSettle(pending))) return null;

		if (pending.kind === "panel") {
			// A reattached panel settles exactly like a live one: fresh ledger
			// from the validated results, attempt 1 for every participant.
			const ledger: ReviewLedger = {
				...buildLedger(
					all
						.filter((r) => r.kind === "review" && r.ok)
						.map((r) => ({ reviewer: r.name, findings: r.structured })),
					now(),
				),
				participants: all
					.filter((r) => r.kind === "review")
					.map((r) => participant(r, 1)),
			};
			episode = { ledger, lastResults: all };
			deps.report?.("panel", all, ledger);
			return renderPanelReport(all, ledger, waived);
		}
		// Repair: merge the harvested re-runs into the persisted ledger like a
		// live repair — earlier findings stay, prior participants not re-run
		// keep their rows, each re-run reviewer's attempt increments.
		const prevAttempt = new Map(
			(prior.participants ?? []).map((p) => [p.name, p.attempt ?? 1]),
		);
		const reran = new Set(all.map((r) => r.name));
		const ledger: ReviewLedger = {
			...prior,
			entries: [
				...prior.entries,
				...buildLedger(
					all
						.filter((r) => r.kind === "review" && r.ok)
						.map((r) => ({ reviewer: r.name, findings: r.structured })),
					now(),
				).entries,
			],
			participants: [
				...(prior.participants ?? []).filter((p) => !reran.has(p.name)),
				...all
					.filter((r) => r.kind === "review")
					.map((r) => participant(r, (prevAttempt.get(r.name) ?? 1) + 1)),
			],
			updatedAt: now(),
		};
		episode = { ledger, lastResults: all };
		deps.report?.("panel", all, ledger);
		return renderPanelReport(all, ledger, waived);
	}

	/**
	 * Reattach a scoped verification round. The claim scope is recomputed
	 * from the persisted ledger — resolutions were applied and persisted at
	 * round start, so it matches what the verifier was spawned with.
	 */
	async function reattachVerification(
		subagents: SubagentsCapabilityV1,
		pending: PendingReviewRound,
		waived: ReadonlySet<string>,
		prior: ReviewLedger,
		deadline: number,
		pollMs: number,
	): Promise<string | null> {
		const claims = prior.entries.filter(
			(e) =>
				e.resolution?.status === "fixed" &&
				e.check?.result !== "verified" &&
				!waived.has(e.finding.id),
		);
		const runRef = pending.runs[0];
		const verifierName = runRef?.name ?? `verifier-${prior.cycle + 1}`;
		const run: HarvestedRun = runRef
			? await harvestRun(subagents, runRef.runId, deadline, pollMs)
			: {
					status: "failed",
					error: "run was never recorded (lost at respawn)",
				};
		if (!(await claimSettle(pending))) return null;
		const report = run.summary?.trim() ?? "";
		if (run.status !== "succeeded" || !report) {
			// The round is over even without a report: clear the marker upward
			// so respawns stop reattaching to a dead run. Retrying stays the
			// worker's explicit call — same contract as a live failed verifier.
			episode = { ...episode!, ledger: prior };
			deps.report?.("verification", [], prior);
			return `Verifier ${run.status}: ${run.error ?? "no report"} — fix nothing, just run review({action: "verify", resolutions: [...]}) again.`;
		}
		const parsed = parseVerifierReport(report, claims);
		const { ledger: checked, errors } = applyChecks(
			prior,
			parsed.checks,
			parsed.regressions,
			verifierName,
			now(),
		);
		episode = { ...episode!, ledger: checked };
		deps.report?.("verification", [], checked);
		return renderVerificationReport(checked, waived, errors, report);
	}

	function renderPanelReport(
		results: readonly PanelResult[],
		ledger: ReviewLedger,
		waived: ReadonlySet<string>,
	): string {
		const open = openBlocking(ledger, waived);
		const failed = results.filter((r) => !r.ok && r.kind === "review");
		const clean = open.length === 0 && failed.length === 0;
		const head = clean
			? "Panel clean — no blocking findings. You can finish once your work is done."
			: `Panel found ${open.length} blocking finding(s). Resolve EVERY one (fix+commit / wont-fix minors / disputed with rationale / duplicateOf), then call review({resolutions: [...]}).`;
		const sections = [head];
		if (failed.length > 0) {
			sections.push(
				`Reviewers that failed to report: ${failed.map((r) => `${r.name} (${r.status})`).join(", ")} — run review({action: "repair"}) to re-run just them.`,
			);
		}
		sections.push(
			`Ledger:\n${renderLedger(ledger, waived) || "(no findings)"}`,
		);
		sections.push(
			results
				.map((r) => {
					const tag = r.required && r.kind === "review" ? " [required]" : "";
					const status =
						r.kind === "helper" ? "helper" : (GLYPH[r.verdict] ?? "?");
					return `### ${r.name}${tag} — ${status}\n${r.report}`;
				})
				.join("\n\n---\n\n"),
		);
		return sections.join("\n\n");
	}
}

const GLYPH: Record<string, string> = {
	approve: "✓ PASS",
	"request-changes": "✗ CHANGES",
	none: "· no verdict",
};

// ─── Reattach: harvesting a previous process's round from the run store ─────

/** Statuses a stored run can settle in; everything else is still running. */
const TERMINAL_RUN_STATUSES = new Set([
	"succeeded",
	"failed",
	"stopped",
	"canceled",
	"timed-out",
]);

/** Poll cadence while a reattached round waits out still-active runs. Modest
 *  on purpose: reattach is a rare crash-recovery path, and the round is
 *  already bounded by the panel deadline. */
const REATTACH_POLL_MS = 2_000;

/** The terminal outcome harvested from the store for one reattached run. */
interface HarvestedRun {
	status: string;
	summary?: string;
	error?: string;
}

/**
 * Wait for one reattached run to turn terminal in the shared store. Runs
 * already terminal return their stored result immediately; active ones are
 * polled until the ROUND deadline (the same boundary a live round enforces),
 * then stopped and reported timed-out.
 */
async function harvestRun(
	subagents: SubagentsCapabilityV1,
	runId: string,
	deadline: number,
	pollMs: number,
): Promise<HarvestedRun> {
	for (;;) {
		const record = subagents.get(runId as RunId);
		if (!record) {
			// The store no longer knows the run (retention purge, or the spawn
			// never registered) — nothing to wait for, nothing to validate.
			return { status: "failed", error: "run not found in the store" };
		}
		if (TERMINAL_RUN_STATUSES.has(record.status)) {
			return (
				record.result ?? {
					status: record.status,
					error: "run settled without a result",
				}
			);
		}
		if (Date.now() >= deadline) {
			subagents.stop(runId as RunId, "review round deadline (reattach)");
			return {
				status: "timed-out",
				error: "timed out (panel deadline elapsed across a respawn)",
			};
		}
		await sleep(pollMs);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		t.unref?.();
	});
}

/** Same round identity: the marker names exactly the runs we spawned. */
function sameRound(a: PendingReviewRound, b: PendingReviewRound): boolean {
	return (
		a.kind === b.kind &&
		a.startedAt === b.startedAt &&
		a.runs.length === b.runs.length &&
		a.runs.every(
			(r, i) => r.name === b.runs[i].name && r.runId === b.runs[i].runId,
		)
	);
}

/** The worker-facing report for a settled verification round — shared by the
 *  live settle path and the reattach path so both read identically. */
function renderVerificationReport(
	checked: ReviewLedger,
	waived: ReadonlySet<string>,
	errors: readonly string[],
	report: string,
): string {
	const open = openBlocking(checked, waived);
	const disputed = openDisputed(checked, waived);
	const lines = [
		open.length === 0
			? "All blocking findings are settled — the gate is clear (finish up and stop)."
			: `${open.length} blocking finding(s) still open after verification — fix and verify again.`,
		"",
		renderLedger(checked, waived),
	];
	if (disputed.length > 0) {
		lines.push(
			"",
			`${disputed.length} disputed finding(s) go to the maestro's triage — do not fix or re-dispute them.`,
		);
	}
	if (errors.length > 0) {
		lines.push("", `Verifier protocol notes: ${errors.join("; ")}`);
	}
	lines.push("", `Verifier report:\n${report}`);
	return lines.join("\n");
}

/** The verifier's prompt: the closed claim list with the worker's notes. */
export function buildVerifierPrompt(
	claims: ReadonlyArray<{
		finding: StructuredFinding;
		resolution?: { note: string; fixCommit?: string };
	}>,
	range?: { base?: string; head?: string },
): string {
	const list = claims
		.map(
			(c) =>
				`- ${c.finding.id} [${c.finding.severity}] ${renderFinding(c.finding)}\n  worker's fix note: ${c.resolution?.note ?? "(none)"}`,
		)
		.join("\n");
	const scope =
		range?.base && range.head
			? `\nOriginal review commit: ${range.base}\nFix commit: ${range.head}\nFix range: ${range.base}..${range.head}\n`
			: "";
	return `Verify these claimed fixes in the current worktree. Inspect the original evidence and ONLY the explicit fix range; do not issue an open-ended reviewer verdict.${scope}\n${list}\n\nEvery id above must appear in your "checks" array exactly once.`;
}

/** Parse the verifier's JSON block; tolerate a missing block by failing every claim open. */
export function parseVerifierReport(
	report: string,
	claims: ReadonlyArray<{ finding: StructuredFinding }>,
): { checks: ClaimCheck[]; regressions: StructuredFinding[] } {
	const block = [...report.matchAll(/```json\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
	if (block) {
		try {
			const parsed = JSON.parse(block) as {
				checks?: Array<Record<string, unknown>>;
				regressions?: Array<Record<string, unknown>>;
			};
			const known = new Set(claims.map((c) => c.finding.id));
			const checks: ClaimCheck[] = [];
			for (const c of parsed.checks ?? []) {
				const id = typeof c.id === "string" ? c.id : "";
				if (!known.has(id)) continue;
				checks.push({
					id,
					result: c.result === "verified" ? "verified" : "still-open",
					...(typeof c.note === "string" && c.note ? { note: c.note } : {}),
				});
			}
			// A claim the verifier skipped stays unverified — conservative.
			for (const c of claims) {
				if (!checks.some((k) => k.id === c.finding.id)) {
					checks.push({
						id: c.finding.id,
						result: "still-open",
						note: "verifier did not report on this claim",
					});
				}
			}
			const regressions = parseJsonFindings(
				`\`\`\`json\n${JSON.stringify({ findings: parsed.regressions ?? [] })}\`\`\``,
			);
			return { checks, regressions: regressions ?? [] };
		} catch {
			// fall through
		}
	}
	return {
		checks: claims.map((c) => ({
			id: c.finding.id,
			result: "still-open" as const,
			note: "verifier returned no parseable checks",
		})),
		regressions: [],
	};
}

interface HandleLike {
	result(): Promise<{ status: string; summary?: string; error?: string }>;
	stop(reason?: string): void;
}

async function settleRun(
	handle: HandleLike,
	timeoutMs: number,
): Promise<{ status: string; summary?: string; error?: string }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<{ status: string; error: string }>((resolve) => {
		timer = setTimeout(() => {
			handle.stop("timeout");
			resolve({ status: "failed", error: "timed out" });
		}, timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([handle.result(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Persisted participant state for one reviewer's latest attempt. */
function participant(
	r: PanelResult,
	attempt: number,
): NonNullable<ReviewLedger["participants"]>[number] {
	return {
		name: r.name,
		ok: r.ok,
		status: r.status,
		attempt,
		...(r.runId ? { runId: r.runId } : {}),
		...(r.ok ? {} : { error: r.report.split("\n")[0] }),
	};
}
