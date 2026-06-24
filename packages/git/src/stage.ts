// Staging + commit. Enforces the repo safety rule in code: only explicit
// pathspecs are ever staged — never `git add -A`, `-u`, or `.` — so a bug or a
// careless caller can't sweep `.env` or unrelated files into a commit.

import { runCommand, type ShellResult } from "./shell.js";

/** Pathspecs that stage broadly; rejected by stageFiles. */
const FORBIDDEN_SPECS = new Set([".", "-A", "--all", "-u", "--update", "*"]);

export class UnsafeStageError extends Error {
	constructor(readonly spec: string) {
		super(
			`refusing to stage broad pathspec "${spec}" — pass explicit file paths (no -A/-u/.)`,
		);
		this.name = "UnsafeStageError";
	}
}

function assertSafePath(spec: string): void {
	const trimmed = spec.trim();
	if (
		trimmed === "" ||
		FORBIDDEN_SPECS.has(trimmed) ||
		trimmed.startsWith("-")
	) {
		throw new UnsafeStageError(spec);
	}
}

/**
 * Stage explicit paths with `git add -- <paths>`. Throws UnsafeStageError for
 * any broad/option-like spec. The `--` separator keeps paths from being parsed
 * as options.
 */
export function stageFiles(cwd: string, paths: readonly string[]): ShellResult {
	if (paths.length === 0) {
		throw new UnsafeStageError("(empty)");
	}
	for (const path of paths) assertSafePath(path);
	return runCommand("git", ["add", "--", ...paths], { cwd });
}

/**
 * Commit the staged index. The message is piped via stdin (`-F -`) so
 * apostrophes, quotes, and multi-line bodies need no shell escaping.
 */
export function commit(
	cwd: string,
	message: string,
	opts: { signoff?: boolean; allowEmpty?: boolean } = {},
): ShellResult {
	const args = ["commit", "-F", "-"];
	if (opts.signoff) args.push("--signoff");
	if (opts.allowEmpty) args.push("--allow-empty");
	return runCommand("git", args, { cwd, stdin: message });
}

/** Stage explicit paths then commit them in one call. */
export function stageAndCommit(
	cwd: string,
	paths: readonly string[],
	message: string,
	opts: { signoff?: boolean } = {},
): ShellResult {
	const staged = stageFiles(cwd, paths);
	if (!staged.ok) return staged;
	return commit(cwd, message, opts);
}
