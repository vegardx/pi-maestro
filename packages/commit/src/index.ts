// @vegardx/pi-commit — the conventional-commit ship workflow. It owns the one
// combined gate (commit + push + PR) behind a single capability:
//
//   commit.v1 → shipDeliverable(input): stage explicit paths, commit (explicit
//   or generated message), push the current branch, open/update its PR.
//
// It consumes the git/github seams directly and resolves ask.v1 softly for the
// gate, falling back to ctx.ui.confirm. shipDeliverable operates on the active
// worktree's current branch — modes checks out the right branch first; commit
// stays decoupled from plan internals. A /commit command ships the current
// working-tree changes standalone.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ShipDeliverableInput, ShipResult } from "@vegardx/pi-contracts";
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
import { runShip, type ShipDeps, type ShipSummary } from "./ship.js";

export { buildCommitMessagePrompt, extractCommitMessage } from "./message.js";
export { parseChangedPaths } from "./paths.js";
export { runShip, type ShipDeps, type ShipSummary } from "./ship.js";

export default defineExtension(
	{
		name: "commit",
		path: "packages/commit/src/index.ts",
		doc: "Conventional-commit workflow: shipDeliverable (commit + push + PR).",
	},
	(pi, maestro) => {
		let ctx: ExtensionContext | undefined;
		const capture = (_e: unknown, c: ExtensionContext) => {
			ctx = c;
		};
		pi.on("session_start", capture);
		pi.on("turn_start", capture);
		pi.on("input", capture);

		// Build the injectable deps bound to the live context. Returns undefined
		// when no context has been captured yet (nothing to ship through).
		function makeDeps(active: ExtensionContext): ShipDeps {
			return {
				cwd: active.cwd,
				currentBranch,
				defaultBranch: (cwd) => defaultBranch(cwd),
				changedPaths: (cwd) => parseChangedPaths(statusPorcelain(cwd)),
				stageAndCommit: (cwd, paths, message) => {
					const r = stageAndCommit(cwd, paths, message);
					if (!r.ok) return { ok: false, error: r.stderr.trim() };
					return { ok: true, sha: headSha(cwd) ?? undefined };
				},
				pushBranch: async (cwd, branch) => (await pushBranch(cwd, branch)).ok,
				findOpenPr: async (cwd, branch) => {
					const { pr } = await findOpenPr(cwd, branch);
					return pr?.number ?? null;
				},
				createPr: async (cwd, args) => {
					const { url } = await createPr(cwd, args);
					// gh prints the PR URL ending in /pull/<n>.
					const n = url?.match(/\/pull\/(\d+)/)?.[1];
					return n ? Number(n) : null;
				},
				generateMessage: async (deliverableId, paths) => {
					const prompt = buildCommitMessagePrompt(deliverableId, paths);
					const reply = await runAgentTurn(pi, active, prompt);
					return extractCommitMessage(reply);
				},
				confirm: (summary) => gate(active, summary),
			};
		}

		// The combined gate: prefer ask.v1, fall back to the host confirm dialog.
		async function gate(
			active: ExtensionContext,
			summary: ShipSummary,
		): Promise<boolean> {
			const detail =
				`Commit ${summary.paths.length} path(s) on ${summary.branch}, ` +
				`push, ${summary.willOpenPr ? "and open/update a PR" : "no PR"}.\n\n` +
				summary.message;
			const ask = maestro.capabilities.get(CAPABILITIES.ask);
			if (ask) {
				const answers = await ask.ask([
					{
						id: "ship",
						question: "Ship this deliverable?",
						context: detail,
						options: [{ label: "Ship" }, { label: "Cancel" }],
					},
				]);
				return answers[0]?.value === "Ship";
			}
			return active.ui.confirm("Ship deliverable", detail);
		}

		const shipDeliverable = async (
			input: ShipDeliverableInput,
		): Promise<ShipResult> => {
			if (!ctx) return { branch: "", committed: false, pushed: false };
			const deps = makeDeps(ctx);
			return runShip(
				{
					...deps,
					cwd: input.cwd ?? ctx.cwd,
					...(input.autoApprove ? { confirm: async () => true } : {}),
				},
				input,
			);
		};

		maestro.capabilities.register(CAPABILITIES.commit, { shipDeliverable });

		pi.registerCommand("commit", {
			description:
				"Stage, commit, push, and open/update a PR for current changes.",
			handler: async (_args: string, active: ExtensionContext) => {
				const result = await shipDeliverable({});
				const msg = !result.committed
					? "Nothing shipped."
					: result.pr
						? `Shipped ${result.branch} → PR #${result.pr}.`
						: `Committed ${result.branch}${result.pushed ? " (pushed)" : ""}.`;
				active.ui.notify(msg, result.committed ? "info" : "warning");
			},
		});
	},
);
