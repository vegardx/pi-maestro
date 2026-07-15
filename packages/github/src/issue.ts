// GitHub issue creation over the gh CLI. Bodies travel only over stdin so
// multiline Markdown and secrets never become argv. The runner is injectable
// for deterministic tests and remains async/abortable in production.

import {
	type RunCommandAsyncOpts,
	runCommandAsync,
	type ShellResult,
} from "@vegardx/pi-git";
import { type RepoSlug, targetArgs } from "./host.js";

export interface CreateIssueInput {
	readonly title: string;
	readonly body: string;
	readonly target: RepoSlug;
}

export interface CreateIssueResult {
	readonly url: string | null;
	readonly error?: string;
}

export type IssueCommandRunner = (
	command: string,
	args: readonly string[],
	opts: RunCommandAsyncOpts,
) => Promise<ShellResult>;

export function buildCreateIssueArgs(
	input: Pick<CreateIssueInput, "title" | "target">,
): string[] {
	return [
		"issue",
		"create",
		"--title",
		input.title,
		"--body-file",
		"-",
		...targetArgs(input.target),
	];
}

export async function createIssue(
	cwd: string,
	input: CreateIssueInput,
	opts: {
		readonly signal?: AbortSignal;
		readonly runner?: IssueCommandRunner;
	} = {},
): Promise<CreateIssueResult> {
	const runner = opts.runner ?? runCommandAsync;
	try {
		const result = await runner("gh", buildCreateIssueArgs(input), {
			cwd,
			stdin: input.body,
			signal: opts.signal,
		});
		if (!result.ok) {
			const error = result.aborted
				? "GitHub issue creation was aborted; creation status is unknown"
				: result.stderr.trim() || `gh exit ${result.exitCode}`;
			return { url: null, error };
		}
		const url = result.stdout.trim().match(/https?:\/\/\S+/)?.[0] ?? null;
		return url
			? { url }
			: {
					url: null,
					error:
						"gh reported success without an issue URL; creation status is unknown",
				};
	} catch (error) {
		return {
			url: null,
			error: `GitHub issue creation failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
