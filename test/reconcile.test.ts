// Orphan reconciler battery. The invariants under test: reap only with proof
// of orphanhood (dead process group, terminal parent, or stale ownerless
// record), never reap anything a live process may still supervise, and always
// verify the tmux session dead BEFORE settling the record (the record is the
// only pointer to the session).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId, RunRecord, RunStatus } from "@vegardx/pi-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileOrphanedRuns } from "../packages/subagents/src/reconcile.js";
import {
	createRunStore,
	type RunStore,
} from "../packages/subagents/src/store.js";

const NOW = 1_000_000_000_000;
const MINUTE = 60_000;

function id(s: string): RunId {
	return s as RunId;
}

describe("orphan reconciler", () => {
	let root: string;
	let store: RunStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-reconcile-"));
		store = createRunStore(root);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function seed(
		runId: string,
		status: RunStatus,
		over: Partial<RunRecord> = {},
	): void {
		store.create({
			schemaVersion: 2,
			id: id(runId),
			profile: { profile: "deliverable-agent" },
			status,
			createdAt: NOW - 5 * MINUTE,
			updatedAt: NOW - 5 * MINUTE,
			...over,
		});
	}

	it("reaps an orphan (terminal parent, dead pgid): session killed BEFORE the record settles", () => {
		seed("parent", "succeeded");
		seed("child", "running", {
			parent: id("parent"),
			metadata: {
				transport: "tmux",
				processGroup: 4242,
				tmuxSession: "maestro-run-child",
			},
		});

		const killed: string[] = [];
		const { reaped, skipped } = reconcileOrphanedRuns(store, {
			now: NOW,
			isProcessAlive: () => false,
			killTmuxSession: (session) => {
				// Ordering proof: at kill time the record must still be active —
				// settling first would erase the only pointer to the session.
				expect(store.readRecord(id("child"))?.status).toBe("running");
				killed.push(session);
				return true;
			},
		});

		expect(killed).toEqual(["maestro-run-child"]);
		expect(reaped).toEqual([id("child")]);
		expect(skipped).toEqual([]);
		const record = store.readRecord(id("child"));
		expect(record?.status).toBe("failed");
		expect(record?.result?.error).toMatch(/^orphaned: /);
	});

	it("never reaps a run with a live process group, even under a terminal parent", () => {
		seed("parent", "failed");
		seed("child", "running", {
			parent: id("parent"),
			metadata: { transport: "tmux", processGroup: 4242 },
		});

		const { reaped, skipped } = reconcileOrphanedRuns(store, {
			now: NOW,
			isProcessAlive: () => true,
			killTmuxSession: () => {
				throw new Error("must not touch the session of a live run");
			},
		});

		expect(reaped).toEqual([]);
		expect(skipped).toEqual([id("child")]);
		expect(store.readRecord(id("child"))?.status).toBe("running");
	});

	it("keeps a recently-updated run with no recorded process group (conservative)", () => {
		// A supervisor announces a run before publishing its process facts; a
		// fresh ownerless record may still be mid-startup somewhere.
		seed("fresh", "queued", { updatedAt: NOW - 1 * MINUTE });

		const { reaped, skipped } = reconcileOrphanedRuns(store, {
			now: NOW,
			isProcessAlive: () => false,
		});

		expect(reaped).toEqual([]);
		expect(skipped).toEqual([id("fresh")]);
		expect(store.readRecord(id("fresh"))?.status).toBe("queued");
	});

	it("reaps an ownerless run once it goes stale", () => {
		seed("stale", "running", { updatedAt: NOW - 11 * MINUTE });

		const { reaped } = reconcileOrphanedRuns(store, {
			now: NOW,
			isProcessAlive: () => false,
		});

		expect(reaped).toEqual([id("stale")]);
		const record = store.readRecord(id("stale"));
		expect(record?.status).toBe("failed");
		expect(record?.result?.error).toMatch(/^orphaned: no owning process/);
	});

	it("skips an orphan whose session kill cannot be verified, record untouched", () => {
		seed("wedged", "running", {
			metadata: {
				transport: "tmux",
				processGroup: 4242,
				tmuxSession: "maestro-run-wedged",
			},
		});

		const { reaped, skipped } = reconcileOrphanedRuns(store, {
			now: NOW,
			isProcessAlive: () => false,
			killTmuxSession: () => false,
		});

		expect(reaped).toEqual([]);
		expect(skipped).toEqual([id("wedged")]);
		const record = store.readRecord(id("wedged"));
		expect(record?.status).toBe("running");
		expect(record?.metadata?.tmuxSession).toBe("maestro-run-wedged");
	});

	it("ignores terminal runs entirely", () => {
		seed("done", "succeeded");
		seed("dead", "failed");

		const { reaped, skipped } = reconcileOrphanedRuns(store, {
			now: NOW,
			isProcessAlive: () => false,
		});

		expect(reaped).toEqual([]);
		expect(skipped).toEqual([]);
	});

	it("a terminal parent alone orphans an ownerless child regardless of staleness", () => {
		seed("parent", "stopped");
		seed("child", "running", {
			parent: id("parent"),
			updatedAt: NOW - 1 * MINUTE,
		});

		const { reaped } = reconcileOrphanedRuns(store, {
			now: NOW,
			isProcessAlive: () => false,
		});

		expect(reaped).toEqual([id("child")]);
		expect(store.readRecord(id("child"))?.result?.error).toMatch(
			/^orphaned: parent run parent is terminal/,
		);
	});

	it("a live parent keeps a recent ownerless child", () => {
		seed("parent", "running", {
			metadata: { transport: "tmux", processGroup: 1111 },
		});
		seed("child", "running", {
			parent: id("parent"),
			updatedAt: NOW - 1 * MINUTE,
		});

		const { reaped, skipped } = reconcileOrphanedRuns(store, {
			now: NOW,
			isProcessAlive: (pgid) => pgid === 1111,
		});

		expect(reaped).toEqual([]);
		expect(skipped.sort()).toEqual([id("child"), id("parent")]);
	});
});
