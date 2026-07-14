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

import {
	type AgentToolResult,
	defineTool,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { SubagentsCapabilityV1 } from "@vegardx/pi-contracts";
import {
	applyChecks,
	applyResolutions,
	buildLedger,
	type ClaimCheck,
	type FindingResolution,
	ledgerSummary,
	openBlocking,
	openDisputed,
	parseJsonFindings,
	type ReviewLedger,
	renderFinding,
	renderLedger,
	type StructuredFinding,
} from "./exec/findings.js";
import {
	DEFAULT_TIMEOUT_MS,
	type PanelResult,
	runReviewPanel,
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
	/** Report a completed run + the resulting ledger upward (ship gate). */
	readonly report?: (
		roundKind: "panel" | "verification",
		results: readonly PanelResult[],
		ledger: ReviewLedger,
	) => void;
	readonly timeoutMs?: () => number;
	readonly now?: () => string;
}

type Result = AgentToolResult<{ gate?: boolean }>;

const ResolutionParam = Type.Object({
	id: Type.String({ description: "Canonical finding id from the ledger" }),
	status: Type.Union([
		Type.Literal("fixed"),
		Type.Literal("wont-fix"),
		Type.Literal("disputed"),
		Type.Literal("duplicateOf"),
	]),
	note: Type.String({
		description:
			"fixed: the commit. wont-fix (minors only): why. disputed (blocking " +
			"only, once): your code-referencing rationale. duplicateOf: why same.",
	}),
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
	const now = () => (deps.now ? deps.now() : new Date().toISOString());

	return defineTool({
		name: "review",
		label: "Review",
		description:
			"Your review episode. First call (no args) runs the full reviewer " +
			"panel ONCE and returns findings with canonical ids. Then resolve " +
			"every blocking finding (fix+commit / wont-fix minors / dispute with " +
			"rationale / duplicateOf) and call again with `resolutions` — a " +
			"scope-locked verifier checks exactly your claims. Ship is blocked " +
			"until no blocking finding is open. Disputes go to the maestro, not " +
			"another review round.",
		promptSnippet:
			"review — run your review panel once, then verify your fixes " +
			"(resolutions: fixed/wont-fix/disputed/duplicateOf per finding id).",
		parameters: ReviewParams,
		// Panel rounds concatenate full reviewer reports — the WORKER model
		// needs them; the human watching the pane gets a preview + expand.
		renderResult: renderCollapsedResult,
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<Result> {
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

			const action =
				params.action ??
				(params.resolutions?.length ? "verify" : episode ? undefined : "panel");

			if (action === "panel" || (!episode && !action)) {
				return await runPanelRound(deps, subagents, panel, waived, ctx);
			}
			if (action === "repair") {
				return await repairRound(deps, subagents, panel, waived, ctx);
			}
			if (action === "verify") {
				return await verifyClaims(
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

	async function runPanelRound(
		d: ReviewToolDeps,
		subagents: SubagentsCapabilityV1,
		panel: readonly SubAgentSpec[],
		waived: ReadonlySet<string>,
		ctx: ExtensionContext,
	): Promise<Result> {
		const firstPass = await runReviewPanel(panel, {
			subagents,
			cwd: d.cwd(),
			resolveModel: d.resolveModel
				? (spec) => d.resolveModel!(ctx, spec)
				: undefined,
			timeoutMs: d.timeoutMs?.(),
		});
		// Partial-round repair, inline: a failed reviewer must not force the
		// worker to re-run the WHOLE panel (that would reopen open-scope
		// re-review through the back door). One targeted re-run, then report.
		const results = await rerunFailed(d, subagents, panel, firstPass, ctx);

		const ledger: ReviewLedger = {
			...buildLedger(
				results
					.filter((r) => r.kind === "review" && r.ok)
					.map((r) => ({ reviewer: r.name, findings: r.structured })),
				now(),
			),
			participants: results
				.filter((r) => r.kind === "review")
				.map((r) => ({ name: r.name, ok: r.ok })),
		};
		episode = { ledger, lastResults: results };
		d.report?.("panel", results, ledger);
		return renderPanelResult(results, ledger, waived);
	}

	async function repairRound(
		d: ReviewToolDeps,
		subagents: SubagentsCapabilityV1,
		panel: readonly SubAgentSpec[],
		waived: ReadonlySet<string>,
		ctx: ExtensionContext,
	): Promise<Result> {
		if (!episode) {
			return text("Nothing to repair — the panel has not run yet.");
		}
		const okNames = new Set(
			episode.lastResults.filter((r) => r.ok).map((r) => r.name),
		);
		const failedSpecs = panel.filter((s) => !okNames.has(s.name));
		if (failedSpecs.length === 0) {
			return text("Nothing to repair — every reviewer reported.");
		}
		const repaired = await runReviewPanel(failedSpecs, {
			subagents,
			cwd: d.cwd(),
			resolveModel: d.resolveModel
				? (spec) => d.resolveModel!(ctx, spec)
				: undefined,
			timeoutMs: d.timeoutMs?.(),
		});
		const merged = [
			...episode.lastResults.filter((r) => okNames.has(r.name)),
			...repaired,
		];
		const ledger: ReviewLedger = {
			...episode.ledger,
			entries: [
				...episode.ledger.entries,
				...buildLedger(
					repaired
						.filter((r) => r.kind === "review" && r.ok)
						.map((r) => ({ reviewer: r.name, findings: r.structured })),
					now(),
				).entries,
			],
			participants: merged
				.filter((r) => r.kind === "review")
				.map((r) => ({ name: r.name, ok: r.ok })),
			updatedAt: now(),
		};
		episode = { ledger, lastResults: merged };
		deps.report?.("panel", merged, ledger);
		return renderPanelResult(merged, ledger, waived);
	}

	async function verifyClaims(
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
		// need no verifier — disputes go to triage, minors are decided.
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
		const prompt = buildVerifierPrompt(claims.map((e) => e));
		const timeoutMs = d.timeoutMs?.() ?? DEFAULT_TIMEOUT_MS;

		let run = await settleRun(subagents.spawn(prompt, profile), timeoutMs);
		let report = run.summary?.trim() ?? "";
		if (run.status === "succeeded" && !report) {
			run = await settleRun(subagents.spawn(prompt, profile), timeoutMs);
			report = run.summary?.trim() ?? "";
		}
		if (run.status !== "succeeded" || !report) {
			return text(
				`Verifier ${run.status}: ${run.error ?? "no report"} — fix nothing, just run review({action: "verify", resolutions: [...]}) again.`,
			);
		}
		const parsed = parseVerifierReport(report, claims);
		const { ledger: checked, errors } = applyChecks(
			applied.ledger,
			parsed.checks,
			parsed.regressions,
			verifierName,
			now(),
		);
		episode = { ...episode, ledger: checked };
		d.report?.("verification", [], checked);

		const open = openBlocking(checked, waived);
		const disputed = openDisputed(checked, waived);
		const gate = open.length === 0;
		const lines = [
			gate
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
		return text(lines.join("\n"), gate);
	}

	function renderPanelResult(
		results: readonly PanelResult[],
		ledger: ReviewLedger,
		waived: ReadonlySet<string>,
	): Result {
		const open = openBlocking(ledger, waived);
		const failed = results.filter((r) => !r.ok && r.kind === "review");
		const gate = open.length === 0 && failed.length === 0;
		const head = gate
			? "Panel clean — no blocking findings. You can finish once your work is done."
			: `Panel found ${open.length} blocking finding(s). Resolve EVERY one (fix+commit / wont-fix minors / disputed with rationale / duplicateOf), then call review({resolutions: [...]}).`;
		const sections = [head];
		if (failed.length > 0) {
			sections.push(
				`Reviewers that failed to report: ${failed.map((r) => r.name).join(", ")} — run review({action: "repair"}) to re-run just them.`,
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
		return {
			content: [{ type: "text", text: sections.join("\n\n") }],
			details: { gate },
		};
	}
}

const GLYPH: Record<string, string> = {
	approve: "✓ PASS",
	"request-changes": "✗ CHANGES",
	none: "· no verdict",
};

/** The verifier's prompt: the closed claim list with the worker's notes. */
export function buildVerifierPrompt(
	claims: ReadonlyArray<{
		finding: StructuredFinding;
		resolution?: { note: string };
	}>,
): string {
	const list = claims
		.map(
			(c) =>
				`- ${c.finding.id} [${c.finding.severity}] ${renderFinding(c.finding)}\n  worker's fix note: ${c.resolution?.note ?? "(none)"}`,
		)
		.join("\n");
	return `Verify these claimed fixes in the current worktree (git diff against the base, read the code, cite evidence per claim):\n\n${list}\n\nEvery id above must appear in your "checks" array exactly once.`;
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

/** Re-run reviewers that failed (spawn error / no report) once, targeted. */
async function rerunFailed(
	d: ReviewToolDeps,
	subagents: SubagentsCapabilityV1,
	panel: readonly SubAgentSpec[],
	results: readonly PanelResult[],
	ctx: ExtensionContext,
): Promise<readonly PanelResult[]> {
	const failedNames = new Set(results.filter((r) => !r.ok).map((r) => r.name));
	if (failedNames.size === 0) return results;
	const failedSpecs = panel.filter((s) => failedNames.has(s.name));
	const repaired = await runReviewPanel(failedSpecs, {
		subagents,
		cwd: d.cwd(),
		resolveModel: d.resolveModel
				? (spec) => d.resolveModel!(ctx, spec)
				: undefined,
		timeoutMs: d.timeoutMs?.(),
	});
	const byName = new Map(repaired.map((r) => [r.name, r]));
	return results.map((r) => byName.get(r.name) ?? r);
}
