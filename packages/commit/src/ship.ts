// The ship orchestration: stage → commit → push → PR, behind one combined
// gate. The valuable logic (sequencing, guards, PR create-vs-update) is kept
// pure of the concrete git/gh seams via an injectable ShipDeps, so it can be
// tested with fakes; index.ts binds the real pi-git / pi-github functions.

import type {
	DeliverableId,
	ShipDeliverableInput,
	ShipResult,
} from "@vegardx/pi-contracts";

export interface ShipDeps {
	/** Working directory to operate in (the active worktree). */
	cwd: string;
	/** Current branch, or null when it can't be determined. */
	currentBranch(cwd: string): string | null;
	/** Default branch of the repo (the PR base). */
	defaultBranch(cwd: string): Promise<string | null>;
	/** Paths with changes, derived from porcelain status (explicit, never -A). */
	changedPaths(cwd: string): string[];
	/** Stage the given paths and commit with the message. */
	stageAndCommit(
		cwd: string,
		paths: readonly string[],
		message: string,
	): { ok: boolean; sha?: string; error?: string };
	/** Push the branch to origin. */
	pushBranch(cwd: string, branch: string): Promise<boolean>;
	/** Find an open PR for the branch; null when none. */
	findOpenPr(cwd: string, branch: string): Promise<number | null>;
	/** Open a PR; returns its number or null on failure. */
	createPr(
		cwd: string,
		args: { title: string; body: string; base: string },
	): Promise<number | null>;
	/** Generate a commit message for the staged change (runAgentTurn). */
	generateMessage(
		deliverableId: DeliverableId | undefined,
		paths: readonly string[],
	): Promise<string | null>;
	/** Confirm the combined commit+push+PR action. true to proceed. */
	confirm(summary: ShipSummary): Promise<boolean>;
}

export interface ShipSummary {
	branch: string;
	paths: readonly string[];
	message: string;
	willPush: boolean;
	willOpenPr: boolean;
}

const EMPTY: ShipResult = {
	branch: "",
	committed: false,
	pushed: false,
};

/**
 * Run the ship sequence. Refuses to commit on the default branch (deliverables
 * never land directly on it — that's what the PR is for) and when there's
 * nothing to stage. Honours an explicit message, otherwise generates one. The
 * single confirm gate covers commit+push+PR together.
 */
export async function runShip(
	deps: ShipDeps,
	input: ShipDeliverableInput,
): Promise<ShipResult> {
	const { cwd } = deps;
	const branch = deps.currentBranch(cwd);
	if (!branch) return EMPTY;

	const base = (await deps.defaultBranch(cwd)) ?? null;
	if (base && branch === base) {
		// Never commit a deliverable straight onto the default branch.
		return { ...EMPTY, branch };
	}

	const paths = input.paths?.length ? input.paths : deps.changedPaths(cwd);
	if (paths.length === 0) return { branch, committed: false, pushed: false };

	const message =
		input.message ?? (await deps.generateMessage(input.deliverableId, paths));
	if (!message) return { branch, committed: false, pushed: false };

	const openPr = input.openPr !== false;
	const proceed = await deps.confirm({
		branch,
		paths,
		message,
		willPush: true,
		willOpenPr: openPr,
	});
	if (!proceed) return { branch, committed: false, pushed: false };

	const commit = deps.stageAndCommit(cwd, paths, message);
	if (!commit.ok) return { branch, committed: false, pushed: false };

	const pushed = await deps.pushBranch(cwd, branch);
	const result: ShipResult = {
		branch,
		committed: true,
		sha: commit.sha,
		pushed,
	};
	if (!pushed || !openPr || !base) return result;

	const existing = await deps.findOpenPr(cwd, branch);
	if (existing != null) return { ...result, pr: existing };

	const subject = message.split("\n")[0];
	const pr = await deps.createPr(cwd, { title: subject, body: message, base });
	return pr != null ? { ...result, pr } : result;
}
