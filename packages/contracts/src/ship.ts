// Ship vocabulary for the deliverable model. Maestro owns shipping — agents only
// commit. This defines the types for the maestro's push+PR workflow.

import type { DeliverableId } from "./ids.js";

export interface ShipDeliverableInput {
	/** The deliverable being shipped. */
	readonly deliverableId: DeliverableId;
	/** Working tree to operate in (commit + push + PR). */
	readonly cwd: string;
	/** Branch to push. */
	readonly branch: string;
	/** PR title. */
	readonly title: string;
	/** PR body (assembled from deliverable body + tasks + agent reports). */
	readonly body: string;
	/** Base branch for the PR (default branch or stacked parent). */
	readonly baseBranch?: string;
}

export interface ShipResult {
	readonly branch: string;
	readonly pushed: boolean;
	readonly pr?: number;
	readonly prUrl?: string;
}
