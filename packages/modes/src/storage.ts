// Storage roots + cutover error. The v1 PlanStore died at the v2 flip —
// plan persistence lives in plan/storage.ts (createPlanStoreV2, gated on
// schemaVersion 6, with wholesale legacy archiving into _legacy/). What
// survives here is the shared root resolution and the unsupported-state
// error both stores' consumers throw/catch.
//
//   <agentDir>/maestro/plans/
//   └── <slug>/plan.json

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function plansRoot(agentDir: string = getAgentDir()): string {
	return join(agentDir, "maestro", "plans");
}

export class UnsupportedMaestroStateError extends Error {
	constructor(
		kind: "plan" | "run" | "execution",
		found: unknown,
		expected: number,
	) {
		super(
			`Unsupported Maestro ${kind} state schema ${String(found)} (expected ${expected}). ` +
				"This release is a full cutover; archive or reset the old Maestro state and retry.",
		);
		this.name = "UnsupportedMaestroStateError";
	}
}
