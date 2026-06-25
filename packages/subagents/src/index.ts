// @vegardx/pi-subagents — the single run transport and service that powers
// both delegate-style focused agents and modes' deliverable workers.
//
// This entry currently ships the persistence substrate (child deliverable 1):
//   * RunStore   — durable per-run status.json / events.jsonl / result.md;
//   * RunBus     — in-process pub/sub transport with bounded replay;
//   * persistRunBus — mirrors the bus into the store;
//   * retention  — prune-on-session_start GC (never touches active runs).
//
// The service, profiles, runners, concurrency, and supervisor/tool/UI surface
// (which register the subagents.v1 capability) land in later child
// deliverables. The factory here wires retention to session_start so run
// artifacts are bounded from day one.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineExtension } from "@vegardx/pi-core";
import { runsRoot } from "./paths.js";
import { DEFAULT_RETENTION, pruneRuns } from "./retention.js";
import { createRunStore } from "./store.js";

export {
	createRunBus,
	msgRunId,
	type RunBus,
	type RunBusHandler,
} from "./bus.js";
export { runsRoot } from "./paths.js";
export { persistRunBus } from "./persist.js";
export {
	DEFAULT_RETENTION,
	type PruneResult,
	pruneRuns,
	type RetentionPolicy,
} from "./retention.js";
export {
	assertTransition,
	canTransition,
	isActive,
	isTerminal,
} from "./state-machine.js";
export { createRunStore, type RunStore } from "./store.js";

export default defineExtension(
	{
		name: "subagents",
		path: "packages/subagents/src/index.ts",
		doc: "Run transport, run store, retention, profiles, runners, supervisor.",
	},
	(pi, maestro) => {
		// Bound run artifacts on startup. Gated so a bisect can disable it.
		pi.on("session_start", (_e, ctx: ExtensionContext) => {
			if (!maestro.flags.enabled("retention")) return;
			try {
				const store = createRunStore(runsRoot(ctx.cwd));
				pruneRuns(store, DEFAULT_RETENTION);
			} catch {
				// Retention is best-effort; never block session startup on it.
			}
		});
	},
);
