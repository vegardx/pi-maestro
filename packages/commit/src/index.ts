// @vegardx/pi-commit — conventional-commit workflow.
// Agents get: commitLocal (stage + commit).
// Maestro/interactive gets: commitLocal + /ship (push + PR).
//
// The executor calls shipping programmatically for automatic group shipping.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension, runAgentTurn } from "@vegardx/pi-core";
import {
	currentBranch,
	headSha,
	pushBranch,
	stageAndCommit,
	statusPorcelain,
} from "@vegardx/pi-git";
import { createPr, defaultBranch, findOpenPr } from "@vegardx/pi-github";
import { buildCommitMessagePrompt, extractCommitMessage } from "./message.js";
import { parseChangedPaths } from "./paths.js";

export { buildCommitMessagePrompt, extractCommitMessage } from "./message.js";
export { parseChangedPaths } from "./paths.js";

export interface CommitInput {
	readonly paths?: readonly string[];
	readonly message?: string;
	readonly cwd?: string;
}

export interface CommitResult {
	readonly committed: boolean;
	readonly sha?: string;
	readonly message?: string;
	readonly error?: string;
}

export interface ShipInput {
	/** Working tree to ship from. Defaults to session cwd. */
	readonly cwd?: string;
	/** Skip confirmation. */
	readonly autoApprove?: boolean;
	/** PR title override. */
	readonly title?: string;
	/** PR body override. */
	readonly body?: string;
}

export interface ShipResult {
	readonly branch: string;
	readonly pushed: boolean;
	readonly pr?: number;
	readonly prUrl?: string;
	readonly error?: string;
}

export default defineExtension(
	{
		name: "commit",
		path: "packages/commit/src/index.ts",
		doc: "Conventional-commit workflow: stage, commit locally. Maestro ships.",
	},
	(pi, maestro) => {
		let ctx: ExtensionContext | undefined;
		const capture = (_e: unknown, c: ExtensionContext) => {
			ctx = c;
		};
		pi.on("session_start", capture);
		pi.on("turn_start", capture);
		pi.on("input", capture);

		async function commitLocal(input: CommitInput): Promise<CommitResult> {
			const active = ctx;
			if (!active) return { committed: false, error: "no active context" };

			const cwd = input.cwd ?? active.cwd;
			const changedPaths = parseChangedPaths(statusPorcelain(cwd));
			const paths = input.paths?.length
				? (input.paths as string[])
				: changedPaths;

			if (paths.length === 0) {
				return { committed: false, error: "nothing to commit" };
			}

			// Generate or use provided message
			let message = input.message;
			if (!message) {
				const prompt = buildCommitMessagePrompt(undefined, paths);
				const reply = await runAgentTurn(pi, active, prompt);
				message = extractCommitMessage(reply) ?? undefined;
				if (!message) {
					return {
						committed: false,
						error: "failed to generate commit message",
					};
				}
			}

			const result = stageAndCommit(cwd, paths, message);
			if (!result.ok) {
				return { committed: false, error: result.stderr.trim() };
			}

			const sha = headSha(cwd) ?? undefined;
			return { committed: true, sha, message };
		}

		maestro.capabilities.register(CAPABILITIES.commit, { commitLocal });

		// ── Ship: push + PR (maestro/interactive only, not for agents) ──────

		async function ship(input: ShipInput): Promise<ShipResult> {
			const active = ctx;
			if (!active)
				return { branch: "", pushed: false, error: "no active context" };

			const cwd = input.cwd ?? active.cwd;
			const branch = currentBranch(cwd);
			if (!branch)
				return { branch: "", pushed: false, error: "not on a branch" };

			const defBranch = await defaultBranch(cwd);
			if (branch === defBranch) {
				return {
					branch,
					pushed: false,
					error: "refusing to ship default branch",
				};
			}

			// Push
			const pushResult = await pushBranch(cwd, branch);
			if (!pushResult.ok) {
				return { branch, pushed: false, error: "push failed" };
			}

			// Find or create PR
			const { pr: existingPr } = await findOpenPr(cwd, branch);
			if (existingPr) {
				return { branch, pushed: true, pr: existingPr.number };
			}

			const title =
				input.title ?? branch.replace(/^feat\//, "").replace(/-/g, " ");
			const body = input.body ?? "";
			const { url } = await createPr(cwd, {
				title,
				body,
				base: defBranch ?? undefined,
			});
			const prNum = url?.match(/\/pull\/(\d+)/)?.[1];

			return {
				branch,
				pushed: true,
				pr: prNum ? Number(prNum) : undefined,
				prUrl: url ?? undefined,
			};
		}

		maestro.capabilities.register(CAPABILITIES.ship, { ship });

		pi.registerCommand("commit", {
			description:
				"Stage and commit current changes with a conventional-commit message.",
			handler: async (_args: string, active: ExtensionContext) => {
				const result = await commitLocal({ cwd: active.cwd });
				const msg = result.committed
					? `Committed: ${result.message} (${result.sha?.slice(0, 7)})`
					: `Nothing committed: ${result.error}`;
				active.ui.notify(msg, result.committed ? "info" : "warning");
			},
		});

		pi.registerCommand("ship", {
			description: "Push current branch and open/update a PR.",
			handler: async (_args: string, active: ExtensionContext) => {
				const result = await ship({ cwd: active.cwd });
				const msg = result.pushed
					? result.pr
						? `Shipped ${result.branch} → PR #${result.pr}.`
						: `Pushed ${result.branch}.`
					: `Ship failed: ${result.error}`;
				active.ui.notify(msg, result.pushed ? "info" : "warning");
			},
		});
	},
);
