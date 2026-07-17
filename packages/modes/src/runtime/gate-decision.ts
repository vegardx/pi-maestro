// The ship-gate disagreement question: when a deliverable transitions into a
// ship-gate block (worker done, required verdicts unsatisfied), the HUMAN gets
// a decision question instead of having to discover a command. The override
// route executes here, in extension code, on the human's answer — deliberately
// out of reach of any model tool, so an auto-mode maestro can never talk
// itself through its own gate.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Answers, AskCapabilityV1, Question } from "@vegardx/pi-contracts";
import type { ExecutionHandle } from "../exec/index.js";
import { parseVerdict } from "../exec/verdicts.js";

export interface GateDecisionDeps {
	readonly ask: () => AskCapabilityV1 | undefined;
	readonly execution: () => ExecutionHandle | undefined;
	readonly pi: Pick<ExtensionAPI, "sendUserMessage">;
	readonly notify: (message: string, level: "info" | "warning") => void;
}

export const GATE_OPTION_SEND_BACK = "Send back with guidance";
export const GATE_OPTION_OVERRIDE = "Override and ship";
export const GATE_OPTION_PARK = "Leave parked";
export const GATE_OPTION_DISCUSS = "Discuss / research first";

/** The maestro's triage recommendation, rendered at the top of the question. */
export interface GateRecommendation {
	/** The concrete action it would take — orders that option first. */
	readonly action?: "send-back" | "override" | "park";
	readonly text: string;
	readonly why?: string;
}

export interface GateDecisionOpts {
	readonly recommendation?: GateRecommendation;
	/** A one-line banner above everything (e.g. "maestro already sent back once"). */
	readonly banner?: string;
}

export interface ReviewerFinding {
	readonly name: string;
	readonly verdict: string;
	readonly required: boolean;
	readonly report?: string;
}

/** Findings shown inline before the full reports — enough to decide fast. */
const MAX_TOP_FINDINGS = 6;

const verdictIcon = (v: string): string =>
	v === "approve" ? "✓" : v === "request-changes" ? "✗" : "–";

/**
 * The findings that justify the decision, as question context. The human is
 * choosing to override or send back — they must see WHAT they'd be
 * overriding, not just which reviewer is holding. Layout is glance-first:
 * a one-line-per-reviewer scoreboard, the top finding bullets, then the
 * full reports for whoever wants the detail.
 */
export function renderFindings(
	findings: readonly ReviewerFinding[],
): string | undefined {
	const relevant = findings.filter((f) => f.verdict !== "approve" || f.report);
	if (relevant.length === 0) return undefined;

	const parsed = new Map(
		relevant.map((f) => [
			f.name,
			f.report ? parseVerdict(f.report) : { verdict: "none", findings: [] },
		]),
	);
	const scoreboard = relevant.map((f) => {
		const n = parsed.get(f.name)?.findings.length ?? 0;
		const count = n > 0 ? ` (${n} finding${n === 1 ? "" : "s"})` : "";
		return `${verdictIcon(f.verdict)} ${f.name}${f.required ? " [required]" : ""} — ${f.verdict}${count}`;
	});

	const top: string[] = [];
	let overflow = 0;
	for (const f of relevant) {
		if (f.verdict === "approve") continue;
		for (const bullet of parsed.get(f.name)?.findings ?? []) {
			if (top.length < MAX_TOP_FINDINGS) {
				top.push(`${top.length + 1}. (${f.name}) ${bullet}`);
			} else {
				overflow++;
			}
		}
	}

	const reports = relevant.map(
		(f) =>
			`### ${f.name}${f.required ? " [required]" : ""} — ${verdictIcon(f.verdict)} ${f.verdict}\n${f.report ?? "(no report received from this reviewer)"}`,
	);

	const sections = [scoreboard.join("\n")];
	if (top.length > 0) {
		sections.push(
			`Top findings:\n${top.join("\n")}${overflow > 0 ? `\n(+${overflow} more in the full reports)` : ""}`,
		);
	}
	sections.push(`── Full reports ──\n\n${reports.join("\n\n")}`);
	return sections.join("\n\n");
}

/** Build the decision question for one blocked deliverable. Pure. */
export function buildGateQuestion(
	deliverableId: string,
	reason: string,
	failing: readonly string[],
	findings: readonly ReviewerFinding[] = [],
	opts: GateDecisionOpts = {},
): Question {
	const holders = failing.length ? failing.join(", ") : "required reviewers";
	const sections: string[] = [];
	if (opts.banner) sections.push(opts.banner);
	if (opts.recommendation) {
		sections.push(
			`Maestro recommends: ${opts.recommendation.text}${opts.recommendation.why ? `\nWhy: ${opts.recommendation.why}` : ""}`,
		);
	}
	const findingsText = renderFindings(findings);
	if (findingsText) sections.push(findingsText);
	const context = sections.join("\n\n");

	const options = [
		{
			label: GATE_OPTION_SEND_BACK,
			description:
				"Reopen the deliverable and respawn its worker with the findings " +
				"and your guidance (add a note) — it fixes, re-runs the panel, " +
				"and the gate re-evaluates.",
		},
		{
			label: GATE_OPTION_OVERRIDE,
			description:
				`Record YOUR approval as the latest verdict for ${holders}. ` +
				"REQUIRES a reason: press `n` on this option to attach the note " +
				"BEFORE committing — it is recorded as a waiver on the " +
				"deliverable and attributed in the PR body.",
		},
		{
			label: GATE_OPTION_PARK,
			description:
				"Decide later. The deliverable stays blocked and visible; a new " +
				"review verdict or an explicit send-back re-opens the question.",
		},
		{
			label: GATE_OPTION_DISCUSS,
			description:
				"Not ready to decide — open a conversation with the maestro (it " +
				"has read everything and can run research on request). The " +
				"question re-appears with an updated recommendation when you're " +
				"ready.",
		},
	];
	// The recommended action leads — the human reads the recommendation first
	// and its option is the first thing under their cursor.
	const lead =
		opts.recommendation?.action === "send-back"
			? GATE_OPTION_SEND_BACK
			: opts.recommendation?.action === "override"
				? GATE_OPTION_OVERRIDE
				: opts.recommendation?.action === "park"
					? GATE_OPTION_PARK
					: undefined;
	if (lead) {
		options.sort((a, b) => (a.label === lead ? -1 : b.label === lead ? 1 : 0));
	}
	return {
		id: `ship-gate:${deliverableId}`,
		question: `${reason} — "${deliverableId}" is parked. How should this resolve?`,
		...(context ? { context } : {}),
		options,
	};
}

/**
 * The worker kickoff for a send-back — one composition for both authors (the
 * human's gate answer and the maestro's triage), so the rework episode starts
 * identically regardless of who ordered it.
 */
export function buildSendBackKickoff(
	reason: string,
	failing: readonly string[],
	guidance: string,
	failingFindings?: string,
	author: "human" | "maestro" = "human",
): string {
	return (
		`Your deliverable was held at the ship gate: ${reason}. ` +
		`The ${author} sent it back to you (${failing.join(", ") || "required reviewers"} holding). ` +
		`Guidance: ${guidance || "(none given — address the reviewers' findings)"}. ` +
		(failingFindings
			? `\n\nThe holding findings:\n\n${failingFindings}\n\n`
			: "") +
		"Fix the findings, commit, and verify the fixes with review({resolutions: [...]}), then finish again."
	);
}

/**
 * Present the gate question and execute the human's decision. Fire-and-forget
 * from the block transition; any error degrades to the blocked card that
 * already exists.
 */
export async function presentGateDecision(
	deps: GateDecisionDeps,
	deliverableId: string,
	reason: string,
	opts: GateDecisionOpts = {},
): Promise<void> {
	const ask = deps.ask();
	const execution = deps.execution();
	if (!ask || !execution) return; // blocked card remains the fallback surface
	const failing = execution.failingRequiredReviewers(deliverableId);
	const findings = execution.reviewerFindings(deliverableId);

	// Overriding without a reason is the blind-override anti-pattern that let
	// unreviewed work ship — re-ask until a note arrives (bounded).
	const MAX_ASKS = 3;
	let answer: Answers[number] | undefined;
	let note = "";
	for (let attempt = 1; attempt <= MAX_ASKS; attempt++) {
		let answers: Answers;
		try {
			answers = await ask.ask([
				buildGateQuestion(deliverableId, reason, failing, findings, opts),
			]);
		} catch {
			return; // ask surface unavailable — blocked card remains
		}
		answer = answers.find((a) => a.questionId === `ship-gate:${deliverableId}`);
		if (!answer || answer.deferred || answer.skipped) return;
		note = answer.note?.trim() ?? "";
		if (answer.value !== GATE_OPTION_OVERRIDE || note) break;
		if (attempt === MAX_ASKS) {
			deps.notify(
				`Override without a reason — leaving ${deliverableId} parked. Answer again with a note.`,
				"warning",
			);
			return;
		}
		deps.notify(
			"Overriding requires a reason — answer again and press `n` on the " +
				"override option to type the note BEFORE committing the answer. " +
				"It becomes the waiver record.",
			"warning",
		);
	}
	if (!answer) return;

	if (answer.value === GATE_OPTION_OVERRIDE) {
		for (const reviewer of failing) {
			execution.overrideReviewerVerdict(deliverableId, reviewer, note);
		}
		deps.notify(
			`Overrode ${failing.join(", ") || "the gate"} on ${deliverableId} — shipping. Waiver: ${note}`,
			"info",
		);
		// The next tick re-evaluates the gate and ships.
		void execution.tick();
		return;
	}
	if (answer.value === GATE_OPTION_DISCUSS) {
		// The human wants to explore before deciding. The deliverable stays
		// blocked (park semantics); the maestro — which just read all of this —
		// hosts the conversation and re-presents the decision when ready.
		deps.notify(
			`${deliverableId} stays parked — discuss it with the maestro; the question re-appears when you're ready.`,
			"info",
		);
		deps.pi.sendUserMessage(
			`[The human chose "Discuss / research first" on the ${deliverableId} ship gate (${reason}). ` +
				"Engage them directly: answer questions about the findings and the dispute, run research or " +
				"read-only delegates on request (the disputed code, the reviewers' claims, prior art). You may " +
				"NOT open the gate yourself. When they are ready to decide, re-present the question by calling " +
				'gate(action: "escalate", ...) with your updated recommendation.]',
			{ deliverAs: "followUp" },
		);
		return;
	}
	if (answer.value === GATE_OPTION_SEND_BACK) {
		// Execute the send-back here, in extension code: reopen the completed
		// deliverable and respawn its worker with the findings. Telling the
		// model to do it dead-ended — complete → active was illegal and no
		// model tool can respawn a worker.
		const failingFindings = renderFindings(
			findings.filter((f) => failing.includes(f.name)),
		);
		const kickoff = buildSendBackKickoff(
			reason,
			failing,
			note,
			failingFindings,
			"human",
		);
		const sent = await execution.sendBackToWorker(deliverableId, kickoff);
		if (sent) {
			deps.notify(
				`Sent ${deliverableId} back to its worker — reopened for rework.`,
				"info",
			);
			deps.pi.sendUserMessage(
				`[Human decision on the ${deliverableId} ship gate: sent back to the worker with guidance: ` +
					`${note || "(none — the reviewers' findings)"}. The worker was respawned; the panel re-runs after the fix.]`,
				{ deliverAs: "followUp" },
			);
		} else {
			// Nothing to respawn into (e.g. post-restart) — fall back to
			// informing the model so it can recover manually.
			deps.pi.sendUserMessage(
				`[Human decision on the ${deliverableId} ship gate (${failing.join(", ")} holding): ` +
					`send the worker back to address the findings. Guidance: ${note || "(none given — use the reviewers' findings)"}. ` +
					"Automatic respawn was not possible — respawn or steer the worker yourself, have it fix and re-run the review panel.]",
				{ deliverAs: "followUp" },
			);
		}
		return;
	}
	// Leave parked — review or dependency guidance remains authoritative.
}
