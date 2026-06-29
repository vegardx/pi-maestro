import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionTailer, type TokenSnapshot } from "@vegardx/pi-modes";

function makeSessionHeader(): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id: "test-session",
		timestamp: new Date().toISOString(),
		cwd: "/tmp/test",
	});
}

function makeAssistantEntry(
	id: string,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	},
): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Hello" }],
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				totalTokens:
					usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: usage.cost,
				},
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	});
}

function makeUserEntry(id: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "Hi", timestamp: Date.now() },
	});
}

describe("SessionTailer", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "session-tailer-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads existing session file and accumulates tokens", async () => {
		const file = join(tmpDir, "session.jsonl");
		writeFileSync(
			file,
			`${[
				makeSessionHeader(),
				makeUserEntry("u1"),
				makeAssistantEntry("a1", {
					input: 1000,
					output: 200,
					cacheRead: 500,
					cacheWrite: 100,
					cost: 0.01,
				}),
				makeUserEntry("u2"),
				makeAssistantEntry("a2", {
					input: 800,
					output: 150,
					cacheRead: 600,
					cacheWrite: 50,
					cost: 0.008,
				}),
			].join("\n")}\n`,
		);

		const snapshots: TokenSnapshot[] = [];
		const tailer = new SessionTailer(file, (s) => snapshots.push(s), {
			debounceMs: 10,
		});

		// Initial read happens synchronously in constructor, but callback is immediate.
		await new Promise((r) => setTimeout(r, 50));
		tailer.stop();

		expect(snapshots.length).toBeGreaterThanOrEqual(1);
		const last = snapshots[snapshots.length - 1]!;
		expect(last.input).toBe(1800);
		expect(last.output).toBe(350);
		expect(last.cacheRead).toBe(1100);
		expect(last.cacheWrite).toBe(150);
		expect(last.totalTokens).toBe(1800 + 350 + 1100 + 150);
		expect(last.cost).toBeCloseTo(0.018);
		expect(last.turns).toBe(2);
		// cacheHitRate = 1100 / (1800 + 1100) * 100
		expect(last.cacheHitRate).toBeCloseTo((1100 / 2900) * 100);
	});

	it("watches for new lines appended after creation", async () => {
		const file = join(tmpDir, "session.jsonl");
		writeFileSync(file, `${makeSessionHeader()}\n`);

		const snapshots: TokenSnapshot[] = [];
		const tailer = new SessionTailer(file, (s) => snapshots.push(s), {
			debounceMs: 10,
		});

		// Wait a tick, then append.
		await new Promise((r) => setTimeout(r, 30));
		appendFileSync(
			file,
			`${makeAssistantEntry("a1", {
				input: 500,
				output: 100,
				cacheRead: 200,
				cacheWrite: 50,
				cost: 0.005,
			})}\n`,
		);

		await new Promise((r) => setTimeout(r, 200));
		tailer.stop();

		expect(snapshots.length).toBeGreaterThanOrEqual(1);
		const last = snapshots[snapshots.length - 1]!;
		expect(last.input).toBe(500);
		expect(last.output).toBe(100);
		expect(last.turns).toBe(1);
	});

	it("waits for file creation when file does not exist", async () => {
		const file = join(tmpDir, "future-session.jsonl");

		const snapshots: TokenSnapshot[] = [];
		const tailer = new SessionTailer(file, (s) => snapshots.push(s), {
			debounceMs: 10,
		});

		// File doesn't exist yet — no callback.
		await new Promise((r) => setTimeout(r, 50));
		expect(snapshots).toHaveLength(0);

		// Create the file with an assistant message.
		writeFileSync(
			file,
			`${[
				makeSessionHeader(),
				makeAssistantEntry("a1", {
					input: 300,
					output: 80,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0.003,
				}),
			].join("\n")}\n`,
		);

		await new Promise((r) => setTimeout(r, 300));
		tailer.stop();

		expect(snapshots.length).toBeGreaterThanOrEqual(1);
		const last = snapshots[snapshots.length - 1]!;
		expect(last.input).toBe(300);
		expect(last.output).toBe(80);
		expect(last.cacheHitRate).toBe(0);
	});

	it("ignores non-assistant messages", async () => {
		const file = join(tmpDir, "session.jsonl");
		writeFileSync(
			file,
			`${[
				makeSessionHeader(),
				makeUserEntry("u1"),
				JSON.stringify({
					type: "message",
					id: "tr1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: {
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "bash",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: Date.now(),
					},
				}),
				makeAssistantEntry("a1", {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0.001,
				}),
			].join("\n")}\n`,
		);

		const snapshots: TokenSnapshot[] = [];
		const tailer = new SessionTailer(file, (s) => snapshots.push(s), {
			debounceMs: 10,
		});

		await new Promise((r) => setTimeout(r, 50));
		tailer.stop();

		const last = snapshots[snapshots.length - 1]!;
		expect(last.turns).toBe(1);
		expect(last.input).toBe(100);
	});

	it("snapshot() returns current state without waiting for callback", async () => {
		const file = join(tmpDir, "session.jsonl");
		writeFileSync(
			file,
			`${[
				makeSessionHeader(),
				makeAssistantEntry("a1", {
					input: 400,
					output: 60,
					cacheRead: 100,
					cacheWrite: 20,
					cost: 0.004,
				}),
			].join("\n")}\n`,
		);

		const tailer = new SessionTailer(file, () => {}, { debounceMs: 10 });
		// Initial read is sync — snapshot should be populated immediately.
		await new Promise((r) => setTimeout(r, 20));
		const snap = tailer.snapshot();
		tailer.stop();

		expect(snap.input).toBe(400);
		expect(snap.output).toBe(60);
		expect(snap.cacheRead).toBe(100);
	});

	it("handles rapid appends with debouncing", async () => {
		const file = join(tmpDir, "session.jsonl");
		writeFileSync(file, `${makeSessionHeader()}\n`);

		let callCount = 0;
		const tailer = new SessionTailer(
			file,
			() => {
				callCount++;
			},
			{ debounceMs: 50 },
		);

		await new Promise((r) => setTimeout(r, 30));

		// Rapid-fire appends.
		for (let i = 0; i < 10; i++) {
			appendFileSync(
				file,
				`${makeAssistantEntry(`a${i}`, {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0.0001,
				})}\n`,
			);
		}

		// With 50ms debounce, we should get fewer callbacks than appends.
		await new Promise((r) => setTimeout(r, 300));
		tailer.stop();

		// Verify all 10 turns were counted despite debouncing.
		const snap = tailer.snapshot();
		expect(snap.turns).toBe(10);
		expect(snap.input).toBe(100);
		// Debounce means fewer callbacks than writes.
		expect(callCount).toBeLessThan(10);
	});

	it("handles file truncation (reset offset)", async () => {
		const file = join(tmpDir, "session.jsonl");
		writeFileSync(
			file,
			`${[
				makeSessionHeader(),
				makeAssistantEntry("a1", {
					input: 1000,
					output: 200,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0.01,
				}),
			].join("\n")}\n`,
		);

		const snapshots: TokenSnapshot[] = [];
		const tailer = new SessionTailer(file, (s) => snapshots.push(s), {
			debounceMs: 10,
		});

		await new Promise((r) => setTimeout(r, 50));

		// Truncate and rewrite (simulates rotation).
		writeFileSync(
			file,
			`${[
				makeSessionHeader(),
				makeAssistantEntry("a2", {
					input: 50,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0.001,
				}),
			].join("\n")}\n`,
		);

		await new Promise((r) => setTimeout(r, 200));
		tailer.stop();

		// After truncation the tailer re-reads from 0, accumulating new content
		// on top of existing totals (no reset of accumulators — that's by design,
		// since in practice rotation means a new session file path).
		const last = snapshots[snapshots.length - 1]!;
		expect(last.turns).toBe(2);
	});
});
