import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function maestroRoot(agentDir: string = getAgentDir()): string {
	return join(agentDir, "maestro");
}

/** `<agentDir>/maestro/plans` */
export function plansRoot(agentDir?: string): string {
	return join(maestroRoot(agentDir), "plans");
}

/**
 * The basenames, named once.
 *
 * `PLAN_FILE` is what `createPlanStore` writes and what `planFile` promises; a
 * second literal in either place is exactly the joined-by-strings defect this
 * package is organised against — the store would keep writing `plan.json`
 * while an exporter read something else, and nothing would fail.
 */
export const PLAN_FILE = "plan.json";

/** The workflow input exported beside a plan, so a run need not be retyped. */
export const WORKFLOW_INPUT_FILE = "workflow-input.json";

/**
 * Where publication receipts accumulate, one file per plan.
 *
 * An APPEND-ONLY array: a second ship of the same plan is a real event, and a
 * file overwritten on re-ship would lose the branch and the pull request the
 * first one made.
 */
export const PUBLICATION_FILE = "publication.json";

/**
 * Where a plan-mode exit in progress is recorded, one file per session.
 *
 * Under `plans/` on purpose, and a dot-directory there cannot be mistaken for
 * one: `createPlanStore`'s own rule is that a directory whose name is not a
 * valid slug cannot hold a plan it wrote, and `.pending` is not a slug.
 */
export const PENDING_EXIT_DIR = ".pending";

/**
 * What a session id may look like before it becomes a filename.
 *
 * Named here rather than in `pending-exit.ts` because this is the rule that
 * makes the join safe, and a rule kept away from the thing it protects is the
 * defect this package is organised against. `pending-exit.ts` reports it as a
 * `PendingExitError`; the throw below is the backstop for a caller that skips
 * that door.
 */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `<agentDir>/maestro/plans/<slug>` */
export function planDir(slug: string, agentDir?: string): string {
	return join(plansRoot(agentDir), slug);
}

/** `<agentDir>/maestro/plans/<slug>/plan.json` */
export function planFile(slug: string, agentDir?: string): string {
	return join(planDir(slug, agentDir), PLAN_FILE);
}

/** `<agentDir>/maestro/plans/<slug>/workflow-input.json` */
export function workflowInputFile(slug: string, agentDir?: string): string {
	return join(planDir(slug, agentDir), WORKFLOW_INPUT_FILE);
}

/** `<agentDir>/maestro/plans/<slug>/publication.json` */
export function publicationFile(slug: string, agentDir?: string): string {
	return join(planDir(slug, agentDir), PUBLICATION_FILE);
}

/** `<agentDir>/maestro/plans/.pending` */
export function pendingExitRoot(agentDir?: string): string {
	return join(plansRoot(agentDir), PENDING_EXIT_DIR);
}

/**
 * `<agentDir>/maestro/plans/.pending/<sessionId>.json`
 *
 * The session id becomes a filename, so it is checked before it is joined:
 * anything `SESSION_ID_RE` rejects is refused here rather than turned into a
 * path outside the directory.
 */
export function pendingExitFile(sessionId: string, agentDir?: string): string {
	if (!SESSION_ID_RE.test(sessionId))
		throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
	return join(pendingExitRoot(agentDir), `${sessionId}.json`);
}
