// The `commit` a worker actually gets.
//
// This exists because a live drive found the system could not ship anything.
// The classifier refuses `git commit` through bash with "Use the commit tool",
// and no such tool was declared — so a worker was told to reach for something
// that did not exist, and every deliverable failed at the last step. That is
// the exact defect this rebuild exists to remove: a refusal naming a capability
// nothing implements. It went unnoticed because each layer is correct alone,
// and only a real run exercises the composition.
//
// It commits IN PROCESS rather than shelling out through the gated bash. That
// is not an optimisation, it is the whole point. A linked worktree keeps its
// branch ref in the SHARED git dir, which the write profile denies — and it
// should, because a worker rewriting arbitrary branches is exactly what that
// guard is for. Routing the commit around bash keeps the deny meaningful
// instead of making it the thing that stops all work.
//
// Staging is explicit-paths-only, inherited from `stageFiles`. A worker that
// says `git add -A` sweeps up whatever else happens to be in the tree; naming
// what it changed is the difference between a commit and a snapshot.

import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { headSha, stageAndCommit, statusPorcelain } from "@vegardx/pi-git";

export interface CommitToolDeps {
	/** Where the worker runs. Its worktree, and the only tree it may commit in. */
	readonly cwd: () => string;
	/** Injected so a test needs no repository. */
	readonly ops?: {
		readonly status: (cwd: string) => string;
		readonly commit: (
			cwd: string,
			paths: readonly string[],
			message: string,
		) => { readonly ok: boolean; readonly stderr: string };
		readonly head: (cwd: string) => string | null;
	};
}

/** Paths git reports as changed, staged or not, including untracked. */
export function changedPaths(porcelain: string): string[] {
	const paths: string[] = [];
	for (const line of porcelain.split("\n")) {
		if (line.trim().length === 0) continue;
		// `XY <path>`, and for renames `XY <old> -> <new>`. The new name is the
		// one that exists, so a rename staged under its old name commits nothing.
		const path = line.slice(3).trim();
		const arrow = path.lastIndexOf(" -> ");
		paths.push(arrow === -1 ? path : path.slice(arrow + 4));
	}
	return paths
		.map((p) => p.replace(/^"(.*)"$/, "$1"))
		.filter((p) => p.length > 0);
}

const DEFAULT_OPS = {
	status: (cwd: string) => statusPorcelain(cwd),
	commit: (cwd: string, paths: readonly string[], message: string) => {
		const result = stageAndCommit(cwd, [...paths], message);
		return { ok: result.ok, stderr: result.stderr };
	},
	head: (cwd: string) => headSha(cwd),
};

export function createCommitTool(deps: CommitToolDeps): ToolDefinition {
	const ops = deps.ops ?? DEFAULT_OPS;
	return defineTool({
		name: "commit",
		label: "commit",
		description:
			"Record your work on this deliverable's branch. Name the files you changed; " +
			"commit as you finish each piece rather than once at the end. " +
			"The maestro pushes and opens the pull request — you never do.",
		// Without this, the generated brief takes the first SENTENCE — which is
		// the half that says what the tool does and loses both halves that stop a
		// worker going wrong: name your files, and you do not push.
		promptSnippet:
			"record work on your branch. Name the files; the maestro pushes, you never do.",
		parameters: Type.Object({
			message: Type.String({
				description:
					"A conventional-commit subject, and a body when the change needs one.",
			}),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"The files to commit. Omit to commit everything git reports as changed.",
				}),
			),
		}),
		async execute(_id, params) {
			const { message, paths } = params as {
				message: string;
				paths?: string[];
			};
			const cwd = deps.cwd();

			if (!message.trim())
				return said("a commit needs a message — say what changed and why");

			const chosen =
				paths && paths.length > 0 ? paths : changedPaths(ops.status(cwd));
			if (chosen.length === 0)
				return said(
					"nothing to commit — the worktree is clean. If you meant to write " +
						"something first, do that; if the work was already committed, say so.",
				);

			const result = ops.commit(cwd, chosen, message);
			if (!result.ok)
				// Returned rather than thrown: a rejected commit is usually
				// something the worker can fix (a hook, a conflict, a bad path),
				// unlike a policy refusal, which is an answer.
				return said(
					`could not commit: ${result.stderr.trim() || "git failed"}`,
				);

			const sha = ops.head(cwd);
			return said(
				`committed ${chosen.length} file${chosen.length === 1 ? "" : "s"}${
					sha ? ` as ${sha.slice(0, 8)}` : ""
				}`,
			);
		},
	}) as ToolDefinition;
}

function said(text: string): {
	content: { type: "text"; text: string }[];
	details: Record<string, never>;
} {
	return { content: [{ type: "text" as const, text }], details: {} };
}
