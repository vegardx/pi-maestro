import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	RunBusMessage,
	RunId,
	RunRecord,
	SpawnProfile,
} from "@vegardx/pi-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canTransition,
	createRunBus,
	createRunStore,
	isActive,
	isTerminal,
	msgRunId,
	persistRunBus,
	pruneRuns,
	type RunStore,
} from "../packages/subagents/src/index.js";

const PROFILE: SpawnProfile = { profile: "restricted" };

function id(s: string): RunId {
	return s as RunId;
}

function record(over: Partial<RunRecord> = {}): RunRecord {
	const now = Date.now();
	return {
		id: id("r1"),
		profile: PROFILE,
		status: "queued",
		createdAt: now,
		updatedAt: now,
		...over,
	};
}

describe("run state machine", () => {
	it("allows the legal lifecycle and rejects illegal jumps", () => {
		expect(canTransition("queued", "running")).toBe(true);
		expect(canTransition("running", "succeeded")).toBe(true);
		expect(canTransition("running", "blocked")).toBe(true);
		expect(canTransition("blocked", "running")).toBe(true);
		expect(canTransition("queued", "succeeded")).toBe(false);
		expect(canTransition("succeeded", "running")).toBe(false);
	});

	it("classifies terminal vs active", () => {
		expect(isTerminal("succeeded")).toBe(true);
		expect(isTerminal("canceled")).toBe(true);
		expect(isActive("running")).toBe(true);
		expect(isActive("queued")).toBe(true);
		expect(isActive("blocked")).toBe(true);
		expect(isActive("failed")).toBe(false);
	});
});

describe("RunStore", () => {
	let root: string;
	let store: RunStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-runs-"));
		store = createRunStore(root);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("round-trips a record and enforces transitions", () => {
		store.create(record());
		expect(store.readRecord(id("r1"))?.status).toBe("queued");

		store.setStatus(id("r1"), "running");
		expect(store.readRecord(id("r1"))?.status).toBe("running");

		expect(() => store.setStatus(id("r1"), "queued")).toThrow(/illegal/);
	});

	it("appends and replays events, skipping torn lines", () => {
		const msg: RunBusMessage = {
			type: "progress",
			runId: id("r1"),
			delta: { text: "hi" },
		};
		store.appendEvent(id("r1"), msg);
		store.appendEvent(id("r1"), msg);
		// Simulate a torn trailing write.
		writeFileSync(
			join(root, "r1", "events.jsonl"),
			`${readFileSync(join(root, "r1", "events.jsonl"), "utf8")}{partial`,
		);
		expect(store.readEvents(id("r1"))).toHaveLength(2);
	});

	it("stores a result and result markdown", () => {
		store.create(record({ status: "queued" }));
		store.setStatus(id("r1"), "running");
		store.setResult(id("r1"), { status: "succeeded", summary: "done" });
		store.writeResult(id("r1"), "# done");
		expect(store.readRecord(id("r1"))?.status).toBe("succeeded");
		expect(store.readResult(id("r1"))).toBe("# done");
	});

	it("lists records and removes them", () => {
		store.create(record({ id: id("a") }));
		store.create(record({ id: id("b") }));
		expect(
			store
				.list()
				.map((r) => r.id)
				.sort(),
		).toEqual(["a", "b"]);
		store.remove(id("a"));
		expect(store.list().map((r) => r.id)).toEqual(["b"]);
	});
});

describe("RunBus + persistence", () => {
	let root: string;
	let store: RunStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-bus-"));
		store = createRunStore(root);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("delivers to subscribers and replays the ring", () => {
		const bus = createRunBus();
		const seen: string[] = [];
		const off = bus.subscribe((m) => seen.push(m.type));
		bus.publish({ type: "status", runId: id("r1"), status: "running", at: 1 });
		off();
		bus.publish({ type: "stop", runId: id("r1") });
		expect(seen).toEqual(["status"]);
		expect(bus.replay(id("r1"))).toHaveLength(2);
	});

	it("msgRunId extracts the run for spawn and run-scoped messages", () => {
		expect(
			msgRunId({
				type: "spawn",
				run: { id: id("r1"), prompt: "x", profile: PROFILE },
			}),
		).toBe("r1");
		expect(msgRunId({ type: "stop", runId: id("r2") })).toBe("r2");
	});

	it("mirrors spawn/status/result into the store", () => {
		const bus = createRunBus();
		const off = persistRunBus(bus, store);
		bus.publish({
			type: "spawn",
			run: { id: id("r1"), prompt: "go", profile: PROFILE },
		});
		bus.publish({ type: "status", runId: id("r1"), status: "running", at: 2 });
		bus.publish({
			type: "result",
			runId: id("r1"),
			result: { status: "succeeded", summary: "ok" },
		});
		off();
		expect(store.readRecord(id("r1"))?.status).toBe("succeeded");
		expect(store.readResult(id("r1"))).toBe("ok");
		expect(store.readEvents(id("r1"))).toHaveLength(3);
	});
});

describe("retention", () => {
	let root: string;
	let store: RunStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maestro-gc-"));
		store = createRunStore(root);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const day = 24 * 60 * 60 * 1000;

	it("never prunes active runs", () => {
		store.create(record({ id: id("live"), status: "running", updatedAt: 0 }));
		const { pruned } = pruneRuns(
			store,
			{ maxRuns: 0, maxAgeDays: 0, eventLogCapBytes: 1e9 },
			10 * day,
		);
		expect(pruned).toEqual([]);
		expect(store.readRecord(id("live"))).toBeDefined();
	});

	it("drops over-cap and too-old terminal runs", () => {
		const now = 100 * day;
		store.create(
			record({ id: id("old"), status: "succeeded", updatedAt: now - 30 * day }),
		);
		store.create(
			record({
				id: id("recent1"),
				status: "succeeded",
				updatedAt: now - 1 * day,
			}),
		);
		store.create(
			record({ id: id("recent2"), status: "failed", updatedAt: now - 2 * day }),
		);
		const { pruned } = pruneRuns(
			store,
			{ maxRuns: 1, maxAgeDays: 14, eventLogCapBytes: 1e9 },
			now,
		);
		// old is too old; of the two recent, only the newest survives the cap.
		expect(pruned.sort()).toEqual(["old", "recent2"]);
		expect(store.readRecord(id("recent1"))).toBeDefined();
	});

	it("truncates an oversized event log head/tail", () => {
		store.create(record({ id: id("big"), status: "succeeded" }));
		const line = `{"type":"progress","runId":"big","delta":{"text":"${"x".repeat(200)}"}}\n`;
		writeFileSync(join(root, "big", "events.jsonl"), line.repeat(2000));
		const before = statSync(join(root, "big", "events.jsonl")).size;
		const { truncated } = pruneRuns(
			store,
			{ maxRuns: 50, maxAgeDays: 14, eventLogCapBytes: 50 * 1024 },
			Date.now(),
		);
		const after = statSync(join(root, "big", "events.jsonl")).size;
		expect(truncated).toEqual(["big"]);
		expect(after).toBeLessThan(before);
		expect(readFileSync(join(root, "big", "events.jsonl"), "utf8")).toContain(
			"_truncated",
		);
	});
});
