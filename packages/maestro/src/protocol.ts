// What a maestro and an agent say to each other.
//
// Nine message types. The old protocol had thirty-odd, and its `hello` alone
// carried a fifteen-kind enum, a resolved model assignment with preset, tier and
// provenance, and a generation counter — so much that the client had to
// fabricate thirty lines of plausible-looking assignment just to send one. A
// version bump could not have fixed that; only a different vocabulary could.
//
// THE ONE THING THIS PROTOCOL EXISTS TO GET RIGHT: maestro owns agent exit. An
// agent does not finish and leave. It sends `done` and waits for `release`. In
// the old system the agent's process could be gone before its result was
// collected, and on one run that lost the output of all five nodes. Making the
// exit a round trip is what removes the race — there is no window, because the
// agent is still there until maestro says otherwise.

import type { TokenSnapshot } from "@vegardx/pi-contracts";

export const PROTOCOL_VERSION = 1;

// ─── Agent → maestro ─────────────────────────────────────────────────────────

/**
 * First message on connect. Maestro answers `welcome` or `reject`.
 *
 * It carries no agent kind, because anything on this socket is a worker. A
 * read-only agent is a call over pi's own stdio RPC and never dials anywhere,
 * and a maestro does not dial itself. A field with one possible value is a
 * field that reads like a decision and is not one.
 */
export interface Hello {
	readonly type: "hello";
	readonly v: number;
	readonly agentId: string;
	/**
	 * The run token, handed over on spawn. Two maestros running at once must not
	 * be able to collect each other's agents.
	 */
	readonly token: string;
	readonly pid: number;
	/** Re-attaching after a maestro restart rather than starting fresh. */
	readonly resumed?: boolean;
}

/** For narration. Carries no result — a result is `done`, and only `done`. */
export interface Status {
	readonly type: "status";
	readonly state: "working" | "idle";
	readonly detail?: string;
}

export interface Tokens {
	readonly type: "tokens";
	/** Cumulative, not a delta: a dropped message must not lose accounting. */
	readonly snapshot: TokenSnapshot;
}

/**
 * The agent's whole result, and its request to be let go. Everything maestro
 * needs to record a `DeliverableRun` is here, because after this the agent is
 * only waiting.
 */
export interface Done {
	readonly type: "done";
	readonly outcome: "succeeded" | "failed";
	/** Required when the outcome is `failed`. */
	readonly failure?: string;
	/** What dependents that named this deliverable in `reads` will be given. */
	readonly handoff?: string;
}

/** Something went wrong that is not a result. The agent stays connected. */
export interface AgentError {
	readonly type: "error";
	readonly message: string;
}

export type AgentMessage = Status | Tokens | Done | AgentError;

// ─── Maestro → agent ─────────────────────────────────────────────────────────

export interface Welcome {
	readonly type: "welcome";
}

/** The handshake failed. Terminal: the agent should stop, not retry. */
export interface Reject {
	readonly type: "reject";
	readonly reason: string;
}

/** You may exit now. The only legal answer to `done`. */
export interface Release {
	readonly type: "release";
}

/** Stop now, finished or not. */
export interface Shutdown {
	readonly type: "shutdown";
	readonly reason: string;
}

export type MaestroMessage = Welcome | Reject | Release | Shutdown;

export type WireMessage = Hello | AgentMessage | MaestroMessage;

// ─── The handshake ───────────────────────────────────────────────────────────

export interface HelloExpectation {
	readonly token: string;
	readonly version?: number;
}

/**
 * Why this hello is not acceptable, or `null` if it is.
 *
 * The gate lives with the protocol rather than in whatever routes messages,
 * because a gate a router can forget to call is a gate that is one refactor
 * away from being decorative.
 */
export function verifyHello(
	value: unknown,
	expect: HelloExpectation,
): string | null {
	const hello = value as Partial<Hello> | null;
	if (typeof hello !== "object" || hello === null || hello.type !== "hello")
		return "not a hello";

	const version = expect.version ?? PROTOCOL_VERSION;
	if (hello.v !== version)
		return `protocol version mismatch: got ${String(hello.v)}, want ${version}`;

	// Checked before the token so a genuinely misdirected connection gets a
	// reason it can act on rather than looking like an authentication failure.
	if (!hello.agentId?.trim()) return "hello carries no agent id";

	if (hello.token !== expect.token)
		return "run token mismatch — this agent belongs to another maestro";

	return null;
}

/**
 * Whether a `done` is self-consistent. A failure with no reason is the shape
 * that produced PR bodies reading "(agent produced no summary)" — the record
 * said something ended without ever saying what happened.
 */
export function checkDone(done: Done): string | null {
	if (done.outcome === "failed" && !done.failure?.trim())
		return "failed with no reason given";
	return null;
}
