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

/** How much model budget a run may spend. The workflow reads it as a dial. */
export const EFFORTS = ["cheap", "standard", "deep"] as const;

export type Effort = (typeof EFFORTS)[number];

/** What an author who said nothing meant. */
export const DEFAULT_EFFORT: Effort = "standard";

export function isEffort(value: unknown): value is Effort {
	return (EFFORTS as readonly unknown[]).includes(value);
}

/** The `input` of a `workflow_run` for the plan-to-ship workflow. */
export interface WorkflowInput {
	readonly plan: Plan;
	/** sha256 of the plan's canonical JSON, lowercase hex. */
	readonly planDigest: string;
	readonly effort: Effort;
}

/** An effort that is not one of the three. */
export class UnknownEffortError extends Error {
	constructor(readonly found: unknown) {
		super(
			`unknown effort ${JSON.stringify(found)} — one of ${EFFORTS.join(", ")}`,
		);
		this.name = "UnknownEffortError";
	}
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
 * Takes `unknown` for the effort on purpose: it arrives from a command
 * argument or a tool call, where "standrd" is one keystroke away, and a typo
 * that silently became `standard` would spend a deep run's budget — or fail to.
 *
 * **An absent effort is the plan's own.** `policy.effort` is a decision a human
 * made in the plan-mode exit and the digest covers it, so a run started without
 * naming one runs at the effort the document asks for rather than at a default
 * that overrides it. The parameter still wins when it is given: `/plan run
 * <slug> deep` is a human saying something about this run.
 *
 * A stored `policy.effort` this build does not recognise is not an error here —
 * `inspectPlan` reports it, `resolvePolicy` resolves it to the default, and so
 * does this. Only an effort the CALLER passed is worth throwing over.
 */
export function toWorkflowInput(plan: Plan, effort?: unknown): WorkflowInput {
	const authored = plan.policy?.effort;
	const wanted =
		effort ?? (isEffort(authored) ? authored : undefined) ?? DEFAULT_EFFORT;
	if (!isEffort(wanted)) throw new UnknownEffortError(effort);
	return { plan, planDigest: planDigest(plan), effort: wanted };
}
