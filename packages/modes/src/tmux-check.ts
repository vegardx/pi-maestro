// Startup tmux requirement check. pi-maestro requires tmux — workers run in
// tmux sessions and (with the inspectable-runs transport) subagents do too —
// so a missing binary or a maestro started outside tmux must be caught loudly
// at session_start, not discovered later as mysteriously wedged spawns.

export interface TmuxRequirementInput {
	/** Is the tmux binary on PATH (isTmuxAvailable())? */
	readonly tmuxAvailable: boolean;
	/** Relevant process env: TMUX (inside-session marker) + escape hatch. */
	readonly env: Readonly<Record<string, string | undefined>>;
}

export interface TmuxRequirementIssue {
	readonly severity: "error" | "warning";
	readonly message: string;
}

/**
 * Evaluate the tmux requirement. Pure — the caller feeds probes in and
 * notifies the results out. Returns no issues when the requirement is met or
 * explicitly waived (PI_MAESTRO_TRANSPORT=headless — the only sanctioned way
 * to run without tmux, e.g. harness/CI runs).
 */
export function tmuxRequirementIssues(
	input: TmuxRequirementInput,
): TmuxRequirementIssue[] {
	if (input.env.PI_MAESTRO_TRANSPORT === "headless") return [];
	const issues: TmuxRequirementIssue[] = [];
	if (!input.tmuxAvailable) {
		issues.push({
			severity: "error",
			message:
				"pi-maestro requires tmux, and none was found on PATH — worker and " +
				"subagent runs WILL fail to spawn. Install tmux (e.g. `brew install " +
				"tmux`) or set PI_MAESTRO_TRANSPORT=headless if you really mean to " +
				"run without it.",
		});
		// No point also complaining about being outside a session.
		return issues;
	}
	if (!input.env.TMUX) {
		issues.push({
			severity: "warning",
			message:
				"pi-maestro is running OUTSIDE a tmux session — worker panes, " +
				"/view, and pane attach will not work. Start pi inside tmux " +
				"(`tmux new -s maestro`).",
		});
	}
	return issues;
}
