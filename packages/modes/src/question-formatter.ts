import type { PendingQuestion } from "./question-queue.js";

/**
 * Formats pending questions into a message the orchestrator LLM will see
 * when its turn is triggered. Includes instructions to answer or escalate.
 */
export function formatQuestionsForLlm(entries: readonly PendingQuestion[]): string {
	const parts: string[] = [];

	parts.push(
		"One or more agents need a decision to continue. " +
		"Answer each using the `answer` tool if you can decide from context. " +
		"If you truly need human input, use the `escalate` tool.\n",
	);

	for (const entry of entries) {
		parts.push(`─── ${entry.agentName} — ${entry.deliverableTitle} ───`);
		for (const q of entry.questions) {
			parts.push(`\n[${q.id}] ${q.question}`);
			if (q.context) parts.push(`  Context: ${q.context}`);
			if (q.options && q.options.length > 0) {
				parts.push("  Options:");
				for (let i = 0; i < q.options.length; i++) {
					const opt = q.options[i];
					const letter = String.fromCharCode(65 + i); // A, B, C...
					const desc = opt.description ? ` — ${opt.description}` : "";
					const rec = opt.value === q.recommendation || opt.label === q.recommendation
						? " [recommended]"
						: "";
					parts.push(`    ${letter}) ${opt.label}${desc}${rec}`);
				}
			}
			if (q.recommendation) {
				parts.push(`  Worker recommends: ${q.recommendation}`);
			}
			if (q.allowFreeText) {
				parts.push("  (Free text answer allowed)");
			}
		}
		parts.push("");
	}

	return parts.join("\n");
}

/**
 * Formats the Q&A result as a conversation message shown to the user.
 * Shows the question, chosen answer, reasoning, and a /steer override hint.
 */
export function formatAnswerNotice(
	entry: PendingQuestion,
	answers: readonly { questionId: string; value: string }[],
	reasoning?: string,
	autoAnswered = true,
): string {
	const lines: string[] = [];
	const prefix = autoAnswered ? "Auto-answered" : "Answered";

	lines.push(`❓ ${entry.agentName} — ${entry.deliverableTitle}\n`);

	for (const q of entry.questions) {
		lines.push(`Q: ${q.question}`);
		if (q.options && q.options.length > 0) {
			const optLine = q.options.map((opt, i) => {
				const letter = String.fromCharCode(65 + i);
				return `${letter}) ${opt.label}`;
			}).join("  ");
			lines.push(`   ${optLine}`);
		}

		const ans = answers.find((a) => a.questionId === q.id);
		if (ans) {
			// Try to match answer value to option label for display
			const matchedOpt = q.options?.find(
				(o) => o.value === ans.value || o.label === ans.value,
			);
			const display = matchedOpt
				? `${ans.value} — ${matchedOpt.label}`
				: ans.value;
			lines.push(`\n✓ ${prefix}: ${display}`);
		}
	}

	if (reasoning) {
		lines.push(`  Reasoning: ${reasoning}`);
	}

	if (autoAnswered) {
		lines.push(
			`\n  Override: /steer ${entry.agentName} "Your alternative guidance here"`,
		);
	}

	return lines.join("\n");
}
