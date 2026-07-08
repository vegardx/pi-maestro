// Commit-message generation prompt + extraction. The prompt is handed to
// runAgentTurn; the agent inspects the staged diff itself (it has the bash/git
// tools) and replies with a single conventional-commit message. Extraction is
// pure and tested.

const CONVENTIONAL =
	/^(feat|fix|refactor|docs|chore|test|style|perf|ci|build)(\([^)]+\))?!?: .+/;

export function buildCommitMessagePrompt(
	deliverableId: string | undefined,
	paths: readonly string[],
): string {
	const scope = deliverableId ? ` for deliverable "${deliverableId}"` : "";
	const fileList =
		paths.length > 0
			? `\n\nStaged paths:\n${paths.map((p) => `- ${p}`).join("\n")}`
			: "";
	return [
		`Write a single conventional-commit message${scope}.`,
		"Inspect the staged diff (git diff --cached) to ground it in the actual change.",
		"Format: `type(scope): subject` — subject in the imperative, ≤72 chars.",
		"Valid types: feat, fix, refactor, docs, chore, test, style, perf, ci, build.",
		"Add a body only when the change needs explanation — describe why, not what.",
		"Reply with ONLY the commit message (no prose, no code fences).",
		fileList,
	].join("\n");
}

/**
 * Pull a usable commit message out of the agent's reply: strip wrapping code
 * fences and surrounding blank lines, drop a leading prose line if the agent
 * ignored instructions, and require the subject to look conventional. Returns
 * null when nothing usable remains.
 */
export function extractCommitMessage(raw: string): string | null {
	let text = raw.trim();
	if (!text) return null;

	// Strip a single wrapping ``` fence if present.
	const fence = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
	if (fence) text = fence[1].trim();

	const lines = text.split("\n");
	// If the first line isn't conventional but a later line is, the agent
	// prepended prose — drop everything before the first conventional line.
	if (!CONVENTIONAL.test(lines[0])) {
		const idx = lines.findIndex((l) => CONVENTIONAL.test(l));
		if (idx < 0) return null;
		lines.splice(0, idx);
	}
	const message = lines.join("\n").trim();
	return CONVENTIONAL.test(message.split("\n")[0]) ? message : null;
}

export function isConventional(subject: string): boolean {
	return CONVENTIONAL.test(subject);
}
