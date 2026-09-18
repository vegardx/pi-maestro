import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function maestroRoot(agentDir: string = getAgentDir()): string {
	return join(agentDir, "maestro");
}

/** `<agentDir>/maestro/plans` — one directory per project, and nothing else. */
export function plansRoot(agentDir?: string): string {
	return join(maestroRoot(agentDir), "plans");
}

/**
 * A working directory as the directory name Pi gives that project's sessions.
 *
 * THE SAME KEY PI USES. `<agentDir>/sessions/<key>` is where Pi puts a
 * project's sessions; this is where maestro puts that project's plans, and
 * where pi-workflow will put its runs. One key means the three are siblings a
 * person can look at together, and that a plan cannot be filed under a name
 * the session record does not share.
 *
 * Pi computes it in `core/session-manager.js` (`getDefaultSessionDirPath`) and
 * does not export it, so it is written out once here and pinned by a test on a
 * literal. Pi resolves the cwd with its own `resolvePath`, which normalizes and
 * `path.resolve`s but deliberately does NOT follow symlinks — `canonicalizePath`
 * is a separate function it does not use here — so this does not realpath
 * either. A store keyed on the real path and a session keyed on the symlinked
 * one would be two names for one project, which is the whole thing this avoids.
 */
export function projectKey(cwd: string): string {
	return `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
}

/**
 * `<agentDir>/maestro/plans/<project key>` — one project's plans.
 *
 * Plans written before this key existed sit directly under `plansRoot` as
 * `plans/<slug>`. They are not read, not listed and not migrated: the slug
 * they were filed under says nothing about which repository they describe, so
 * there is no project this build could honestly file them in.
 */
export function projectPlansRoot(cwd: string, agentDir?: string): string {
	return join(plansRoot(agentDir), projectKey(cwd));
}

/**
 * The basenames, named once.
 *
 * `PLAN_FILE` is what `createPlanStore` writes and what its `planFile` helper
 * promises; a second literal in either place is exactly the joined-by-strings
 * defect this package is organised against — the store would keep writing
 * `plan.json` while an exporter read something else, and nothing would fail.
 *
 * The per-slug joins themselves live on the store and nowhere else: a caller
 * that builds `<root>/<slug>/publication.json` by hand is a second opinion
 * about where a plan is, and now that the root is keyed by project, a second
 * opinion is a path in another project or in no project at all.
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
