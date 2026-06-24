// Suggestion sanitisation + the system-prompt addendum. The addendum teaches
// the agent to emit a single trailing suggest_next_prompt call; prompt-assist
// injects it programmatically at before_agent_start (gated by a flag), so the
// user never has to paste anything into AGENTS.md.

const MAX_SUGGESTION_CHARS = 120;

export const PROMPT_ASSIST_SYSTEM_ADDENDUM = `
You may optionally call the suggest_next_prompt tool exactly once at the very end of your reply, with text set to a short sentence directing the developer to the most likely next instruction (e.g. "Open the PR" not "I'll open the PR"). The tool call is invisible to the developer; it only feeds an optional ghost-text suggestion. Omit the call entirely when there is no obvious next instruction. Keep text to one short sentence, ≤120 characters.
`.trim();

/**
 * Cap a suggestion to a safe shape for the ghost editor.
 *
 * Permissive in: tolerates whitespace, multi-line (first non-empty line wins),
 * and a literal "NONE" sentinel (treated as no suggestion). Strict out: strips
 * ANSI/control sequences and Unicode bidi overrides (no terminal-control
 * injection or visual spoofing of what Tab accepts), trims wrapping quotes and
 * trailing punctuation, caps length with an ellipsis. Returns null when nothing
 * usable remains.
 */
export function sanitiseSuggestion(raw: string): string | null {
	if (!raw) return null;
	let s = "";
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) {
			s = trimmed;
			break;
		}
	}
	if (!s) return null;
	if (s.toUpperCase() === "NONE") return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: must strip control chars by design
	s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: must strip control chars by design
	s = s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: must strip control chars by design
	s = s.replace(/\x1b[\s\S]/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: must strip control chars by design
	s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
	s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
	s = s.trim();
	if (!s) return null;
	s = s.replace(/^["'`]+|["'`]+$/g, "");
	s = s.replace(/[.!?]+$/g, "");
	s = s.trim();
	if (!s) return null;
	if (s.length > MAX_SUGGESTION_CHARS) {
		s = `${s.slice(0, MAX_SUGGESTION_CHARS).trimEnd()}…`;
	}
	return s;
}
