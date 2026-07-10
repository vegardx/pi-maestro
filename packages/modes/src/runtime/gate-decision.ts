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
					"Tell the maestro how the worker should address the findings — " +
					"add a note with your guidance; the panel re-runs after the fix.",
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
		deps.pi.sendUserMessage(
			`[Human decision on the ${deliverableId} ship gate (${failing.join(", ")} holding): ` +
				`send the worker back to address the findings. Guidance: ${note || "(none given — use the reviewers' findings)"}. ` +
				"Respawn or steer the worker, have it fix and re-run the review panel.]",
			{ deliverAs: "followUp" },
		);
		return;
	}
	// Leave parked — the blocked card and /retry remain.
}
