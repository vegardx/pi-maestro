// The hand-off: an authored plan, by value, with a digest.
//
// BY VALUE, NOT BY REFERENCE. A workflow run validates its input against the
// definition's schema and binds the run's identity to it. Handing a run the
// slug of a stored plan would let the document change under a resumed run —
// the run would then be executing something nobody approved. So the whole
// document travels, and `planDigest` names exactly which bytes were approved,
// so a receipt can be checked against them afterwards.
//
// The digest is over CANONICAL JSON: keys sorted, no whitespace. Two plans
// that differ only in the order their keys were written are the same plan, and
// a digest that said otherwise would make an approval look stale after a
// harmless round trip through a re-serializer.
//
// Nothing here imports the workflow runtime. This module is the seam: pure
// data in, pure data out, so the shape can be tested without a workflow host
// and so pi-maestro does not take a dependency on one.

import { createHash } from "node:crypto";
import type { Plan } from "./plan.js";

/**
 * The `input` of a `workflow_run` for the plan-to-ship workflow.
 *
 * THE PLAN AND ITS DIGEST, AND NOTHING ELSE. There used to be an `effort` beside
 * them — a dial collected in a dialog on the way out of plan mode and sent
 * alongside the document — and it was the one field of this input that was not
 * covered by `planDigest`, because it was not part of the plan. Schema 8 removed
 * it: how hard a role thinks is the session's own model and thinking level,
 * inherited per call, and what the run is gated by is `policy.gates` on the
 * document the digest covers.
 */
export interface WorkflowInput {
	readonly plan: Plan;
	/** sha256 of the plan's canonical JSON, lowercase hex. */
	readonly planDigest: string;
}

/**
 * JSON with object keys in sorted order and no whitespace.
 *
 * Written out rather than delegated to `JSON.stringify` with sorted keys,
 * because `JSON.stringify` re-orders integer-like keys by its own rules — a
 * silent way for two canonicalisations to disagree.
 */
export function canonicalJson(value: unknown): string {
	const encoded = encode(value);
	if (encoded === undefined)
		throw new TypeError("canonical JSON: nothing to encode");
	return encoded;
}

function encode(value: unknown): string | undefined {
	if (value === null) return "null";
	switch (typeof value) {
		case "undefined":
		case "function":
		case "symbol":
			return undefined;
		case "number":
			// What JSON.stringify does with NaN and the infinities, said once.
			return Number.isFinite(value) ? JSON.stringify(value) : "null";
		case "bigint":
			throw new TypeError("canonical JSON: bigint is not JSON");
		case "boolean":
		case "string":
			return JSON.stringify(value);
	}
	if (Array.isArray(value))
		// A hole or an undefined element is `null` in JSON, and position is
		// meaning in an array — it is never dropped the way a key is.
		return `[${value.map((item) => encode(item) ?? "null").join(",")}]`;
	const record = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of Object.keys(record).sort()) {
		const encodedValue = encode(record[key]);
		if (encodedValue !== undefined)
			parts.push(`${JSON.stringify(key)}:${encodedValue}`);
	}
	return `{${parts.join(",")}}`;
}

/** sha256 of the plan's canonical JSON, lowercase hex. */
export function planDigest(plan: Plan): string {
	return createHash("sha256").update(canonicalJson(plan), "utf8").digest("hex");
}

/**
 * The workflow input for a stored plan.
 *
 * Total, and it takes nothing but the plan. A caller used to be able to pass an
 * effort that overrode the document's own — which meant the bytes the digest
 * named and the run that executed them could differ in a dial nobody could see
 * afterwards. Everything this input carries now comes off the plan, so a receipt
 * checked against the stored document is checked against the whole input.
 */
export function toWorkflowInput(plan: Plan): WorkflowInput {
	return { plan, planDigest: planDigest(plan) };
}
