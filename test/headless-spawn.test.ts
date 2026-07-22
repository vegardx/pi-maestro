// The headless execution launcher: deliverable workers as detached child
// processes instead of tmux panes (no shared tmux server → no cross-session
// fencing). Exercised against REAL child processes — the whole point is that
// spawn/liveness/kill/capture work without tmux.

import { describe, expect, it } from "vitest";
import { createHeadlessSpawner } from "../packages/modes/src/exec/headless-spawn.js";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(
	predicate: () => Promise<boolean>,
	ms = 3000,
): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await settle(20);
	}
}

const node = (code: string): string[] => [process.execPath, "-e", code];

describe("headless spawner", () => {
	it("spawns a detached child, captures its output, and reports its exit", async () => {
		const s = createHeadlessSpawner();
		await s.spawn(
			"one",
			process.cwd(),
			node("process.stdout.write('hello-headless')"),
		);
		// A short child exits on its own; liveness flips to false.
		await waitFor(async () => !(await s.hasSession("one")));
		const output = await s.capture("one");
		expect(output).toContain("hello-headless");
		expect(output).toContain("[pi exited");
	});

	it("kill() terminates a long-running child", async () => {
		const s = createHeadlessSpawner();
		await s.spawn("two", process.cwd(), node("setInterval(() => {}, 1000)"));
		await settle(150);
		expect(await s.hasSession("two")).toBe(true);
		await s.kill("two");
		await waitFor(async () => !(await s.hasSession("two")));
		expect(await s.hasSession("two")).toBe(false);
	});

	it("is empty/false for an unknown agent name", async () => {
		const s = createHeadlessSpawner();
		expect(await s.hasSession("nope")).toBe(false);
		expect(await s.capture("nope")).toBe("");
	});

	it("respawning a name replaces the prior child", async () => {
		const s = createHeadlessSpawner();
		await s.spawn("re", process.cwd(), node("setInterval(() => {}, 1000)"));
		await settle(150);
		expect(await s.hasSession("re")).toBe(true);
		// Replace with a short-lived process; the old one is killed.
		await s.spawn("re", process.cwd(), node("process.stdout.write('second')"));
		await waitFor(async () => (await s.capture("re")).includes("second"));
		expect(await s.capture("re")).toContain("second");
	});
});
