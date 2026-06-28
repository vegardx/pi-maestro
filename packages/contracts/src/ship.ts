// Commit/ship vocabulary. One capability — shipDeliverable — wraps
// commit + push + PR behind a single combined gate.

import type { DeliverableId } from "./ids.js";

export interface ShipDeliverableInput {
	/** The deliverable being shipped; omitted for a standalone commit. */
	readonly deliverableId?: DeliverableId;
	/** Explicit paths to stage. Omit to use the deliverable's tracked set. */
	readonly paths?: readonly string[];
	/** Override the generated conventional-commit message. */
	readonly message?: string;
	/** Open or update a PR after pushing. Defaults to true. */
	readonly openPr?: boolean;
	/**
	 * Working tree to operate in (commit + push + PR). Defaults to the live
	 * session cwd. modes passes the deliverable's worktree (fanout) or the
	 * plan's repo path (sequential) so shipping is decoupled from the one cwd
	 * a session can't move mid-run.
	 */
	readonly cwd?: string;
}

export interface ShipResult {
	readonly branch: string;
	readonly committed: boolean;
	readonly sha?: string;
	readonly pushed: boolean;
	readonly pr?: number;
}
