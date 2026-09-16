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
