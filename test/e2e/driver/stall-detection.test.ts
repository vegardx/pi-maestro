// A wedged SUT must not look like a working one — the second silent failure.
//
// Death (sut-death.test.ts) is a process that exits. A STALL is a process that
// lives but blocks forever on a dead socket: `isStreaming` stuck true, no
// events, transcript frozen. One drive spent 87 minutes that way. The signal
// that catches it is the age of the last SUT-origin event — and its one
// correctness requirement is that the driver's OWN polling cannot refresh that
// clock, or a busy poller would mask every stall (which is how the 87 minutes
// stayed invisible).

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Answerer } from "./answerer.js";
import { detectStall, keepSystemAwake } from "./daemon-health.js";
import { RpcClient } from "./rpc-client.js";

/** Minimal stand-in for the pi child: only what RpcClient actually touches. */
function fakeChild(): {
	stdout: EventEmitter;
	stdin: { write: () => boolean; end: () => void };
	on: EventEmitter["on"];
	feed: (obj: unknown) => void;
} {
	const emitter = new EventEmitter();
	const stdout = new EventEmitter();
	const child = Object.assign(emitter, {
		stdout,
		stdin: { write: () => true, end: () => {} },
		feed: (obj: unknown) =>
			stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`)),
	});
	return child as never;
}

const stubAnswerer = {
	select: async () => ({ cancelled: true }),
	confirm: async () => ({ cancelled: true }),
	input: async () => ({ cancelled: true }),
	editor: async () => ({ cancelled: true }),
} as unknown as Answerer;

describe("SUT activity clock", () => {
	it("advances on real SUT events", () => {
		const child = fakeChild();
		let events = 0;
		new RpcClient(child as never, {
			answerer: stubAnswerer,
			onEvent: () => {
				events++;
			},
		});
		child.feed({ type: "message_update", message: {} });
		child.feed({ type: "tool_execution_start", name: "grep" });
		expect(events).toBe(2);
	});

	it("does NOT advance on command replies — a poller cannot mask a stall", () => {
		const child = fakeChild();
		let events = 0;
		new RpcClient(child as never, {
			answerer: stubAnswerer,
			onEvent: () => {
				events++;
			},
		});
		// `type:"response"` is the reply to get_state/get_messages — the exact
		// traffic a polling driver generates. It must never read as progress.
		child.feed({
			type: "response",
			id: "d-1",
			command: "get_state",
			success: true,
			data: { isStreaming: true },
		});
		child.feed({
			type: "response",
			id: "d-2",
			command: "get_state",
			success: true,
			data: { isStreaming: true },
		});
		expect(events).toBe(0);
	});
});

/** A fake SUT for the detector: no process, just the three things it inspects. */
function fakeSut(opts: {
	died?: boolean;
	sinceMs: number;
	isStreaming?: boolean;
}): Parameters<typeof detectStall>[0] {
	return {
		died: () => (opts.died ? { code: 1, signal: null, at: "now" } : undefined),
		sinceLastActivityMs: () => opts.sinceMs,
		client: {
			getState: async () => ({ isStreaming: opts.isStreaming ?? false }),
		} as never,
	};
}

describe("detectStall", () => {
	const threshold = 1_000;

	it("flags a live, streaming SUT past the threshold", async () => {
		const signal = await detectStall(
			fakeSut({ sinceMs: 5_000, isStreaming: true }),
			threshold,
		);
		expect(signal).toEqual({ sinceMs: 5_000, thresholdMs: threshold });
	});

	it("stays silent below the threshold", async () => {
		expect(
			await detectStall(
				fakeSut({ sinceMs: 200, isStreaming: true }),
				threshold,
			),
		).toBeUndefined();
	});

	it("stays silent when the turn has settled (not streaming)", async () => {
		// A long quiet gap between prompts is idle, not wedged.
		expect(
			await detectStall(
				fakeSut({ sinceMs: 5_000, isStreaming: false }),
				threshold,
			),
		).toBeUndefined();
	});

	it("defers to death — a corpse is not a stall", async () => {
		expect(
			await detectStall(
				fakeSut({ died: true, sinceMs: 5_000, isStreaming: true }),
				threshold,
			),
		).toBeUndefined();
	});
});

describe("keepSystemAwake", () => {
	it("returns a safe, idempotent release", () => {
		const release = keepSystemAwake();
		expect(typeof release).toBe("function");
		// Whatever the platform, releasing must never throw — and twice is fine.
		expect(() => {
			release();
			release();
		}).not.toThrow();
	});
});
