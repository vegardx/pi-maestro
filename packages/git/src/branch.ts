// Branch operations. Network ops (push/pull) run on the async runner so a
// stalled fetch can't freeze the TUI and Esc can cancel.

import { runCommand, runCommandAsync, type ShellResult } from "./shell.js";

export function branchExists(cwd: string, branch: string): boolean {
	return runCommand(
		"git",
		["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
		{ cwd },
	).ok;
}

export function checkoutBranch(cwd: string, branch: string): ShellResult {
	return runCommand("git", ["checkout", branch], { cwd });
}

export function createBranch(
	cwd: string,
	branch: string,
	base?: string,
): ShellResult {
	const args = ["checkout", "-b", branch];
	if (base) args.push(base);
	return runCommand("git", args, { cwd });
}

/** `git rebase --onto <newbase> <oldbase> HEAD`. */
export function rebaseOnto(
	cwd: string,
	newbase: string,
	oldbase: string,
): ShellResult {
	return runCommand("git", ["rebase", "--onto", newbase, oldbase, "HEAD"], {
		cwd,
	});
}

/** Abortable `git pull --ff-only origin <branch>`. */
export function pullFastForward(
	cwd: string,
	branch: string,
	signal?: AbortSignal,
): Promise<ShellResult> {
	return runCommandAsync("git", ["pull", "--ff-only", "origin", branch], {
		cwd,
		signal,
	});
}

/** Abortable `git push -u origin <branch>`. */
export function pushBranch(
	cwd: string,
	branch: string,
	signal?: AbortSignal,
): Promise<ShellResult> {
	return runCommandAsync("git", ["push", "-u", "origin", branch], {
		cwd,
		signal,
	});
}
