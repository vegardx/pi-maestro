// A dead SUT must not look like a working one.
//
// A live drive spent forty minutes appearing to run after the maestro process
// had exited. `launch.ts` captured stderr but never listened for `exit`, so the
// driver kept answering `get_state` from cached state and reporting
// `isStreaming: true` for a process that no longer existed. The transcript even
// looked active — because every `get_state` response is recorded, so the
// poller's own traffic filled it.
//
// Silence must never read as progress.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sut-death-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The death detection wired in launch.ts, exercised against a real child rather
 * than a mock — the bug was that no listener existed at all, which a mock
 * would happily reproduce.
 */
function watchChild(script: string): {
	died: () =>
		| { code: number | null; signal: NodeJS.Signals | null }
		| undefined;
	child: ReturnType<typeof spawn>;
} {
	const file = join(dir, "child.mjs");
	writeFileSync(file, script);
	const child = spawn(process.execPath, [file], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let death: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	const record = (code: number | null, signal: NodeJS.Signals | null): void => {
		if (!death) death = { code, signal };
	};
	child.on("exit", record);
	child.on("error", () => record(null, null));
	return { died: () => death, child };
}

const settle = () => new Promise((r) => setTimeout(r, 300));

describe("SUT death detection", () => {
	it("reports nothing while the process is alive", async () => {
		const { died, child } = watchChild("setTimeout(() => {}, 10_000);");
		await settle();
		expect(died()).toBeUndefined();
		child.kill("SIGKILL");
	});

	it("records a clean exit with its code", async () => {
		const { died } = watchChild("process.exit(3);");
		await settle();
		expect(died()).toMatchObject({ code: 3 });
	});

	it("records a signal kill — the silent case that fooled a live drive", async () => {
		const { died, child } = watchChild("setTimeout(() => {}, 10_000);");
		await settle();
		child.kill("SIGKILL");
		await settle();
		// No stderr, no exit code: exactly what the real failure looked like.
		expect(died()).toMatchObject({ signal: "SIGKILL" });
	});

	it("records only the first death", async () => {
		const { died } = watchChild("process.exit(1);");
		await settle();
		const first = died();
		await settle();
		expect(died()).toBe(first);
	});
});
