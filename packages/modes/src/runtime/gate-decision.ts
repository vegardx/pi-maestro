// The ship-gate disagreement question: when a deliverable transitions into a
// ship-gate block (worker done, required verdicts unsatisfied), the HUMAN gets
// a decision question instead of having to discover a command. The override
// route executes here, in extension code, on the human's answer — deliberately
// out of reach of any model tool, so an auto-mode maestro can never talk
// itself through its own gate.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Answers, AskCapabilityV1, Question } from "@vegardx/pi-contracts";
import type { ExecutionHandle } from "../exec/index.js";

export interface GateDecisionDeps {
	readonly ask: () => AskCapabilityV1 | undefined;
	readonly execution: () => ExecutionHandle | undefined;
	readonly pi: Pick<ExtensionAPI, "sendUserMessage">;
	readonly notify: (message: string, level: "info" | "warning") => void;
}

export const GATE_OPTION_SEND_BACK = "Send back with guidance";
export const GATE_OPTION_OVERRIDE = "Override and ship";
export const GATE_OPTION_PARK = "Leave parked";

/** Build the decision question for one blocked deliverable. Pure. */
export function buildGateQuestion(
	deliverableId: string,
	reason: string,
	failing: readonly string[],
): Question {
	const holders = failing.length ? failing.join(", ") : "required reviewers";
	return {
		id: `ship-gate:${deliverableId}`,
		question: `${reason} — "${deliverableId}" is parked. How should this resolve?`,
		options: [
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
					`Record YOUR approval as the latest verdict for ${holders} ` +
					"(add the reason as a note). The override is attributed in the " +
					"PR body — the gate opens through its own rules.",
			},
			{
				label: GATE_OPTION_PARK,
				description:
					"Decide later. The deliverable stays blocked and visible; a new " +
					"review verdict or /retry re-opens the question.",
			},
		],
	};
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
): Promise<void> {
	const ask = deps.ask();
	const execution = deps.execution();
	if (!ask || !execution) return; // blocked card remains the fallback surface
	const failing = execution.failingRequiredReviewers(deliverableId);

	let answers: Answers;
	try {
		answers = await ask.ask([
			buildGateQuestion(deliverableId, reason, failing),
		]);
	} catch {
		return; // ask surface unavailable — blocked card remains
	}
	const answer = answers.find(
		(a) => a.questionId === `ship-gate:${deliverableId}`,
	);
	if (!answer || answer.deferred || answer.skipped) return;

	const note = answer.note?.trim() ?? "";
	if (answer.value === GATE_OPTION_OVERRIDE) {
		const reasonText = note || "human override, no reason given";
		for (const reviewer of failing) {
			execution.overrideReviewerVerdict(deliverableId, reviewer, reasonText);
		}
		deps.notify(
			`Overrode ${failing.join(", ") || "the gate"} on ${deliverableId} — shipping.`,
			"info",
		);
		// The next tick re-evaluates the gate and ships.
		void execution.tick();
		return;
	}
	if (answer.value === GATE_OPTION_SEND_BACK) {
		// Execute the send-back here, in extension code: reopen the completed
		// deliverable and respawn its worker with the findings. Telling the
		// model to do it dead-ended — complete → active was illegal and no
		// model tool can respawn a worker.
		const kickoff =
			`Your deliverable was held at the ship gate: ${reason}. ` +
			`The human sent it back to you (${failing.join(", ") || "required reviewers"} holding). ` +
			`Guidance: ${note || "(none given — address the reviewers' findings)"}. ` +
			"Fix the findings, commit, re-run the review panel, and finish again.";
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
	// Leave parked — the blocked card and /retry remain.
}
