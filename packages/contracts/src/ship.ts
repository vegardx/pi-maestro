// Commit/ship vocabulary. One capability — shipDeliverable — wraps
// commit + push + PR behind a single combined gate.

import type { DeliverableId } from "./ids.js";

export interface ShipDeliverableInput {
	readonly deliverableId: DeliverableId;
	/** Explicit paths to stage. Omit to use the deliverable's tracked set. */
	readonly paths?: readonly string[];
	/** Override the generated conventional-commit message. */
	readonly message?: string;
	/** Open or update a PR after pushing. Defaults to true. */
	readonly openPr?: boolean;
}

export interface ShipResult {
	readonly branch: string;
	readonly committed: boolean;
	readonly sha?: string;
	readonly pushed: boolean;
	readonly pr?: number;
}
