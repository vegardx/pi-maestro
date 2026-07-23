// LIVE enforcement proof (macOS only): exercises @anthropic-ai/sandbox-runtime
// end-to-end — a real sandbox-exec profile confining writes to a scope. Skipped
// off darwin. This is the "does the kernel actually deny it" check the plan's
// verification calls for; the mocked decision logic lives in
// realtree-sandbox.test.ts.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileWriteProfile } from "../packages/modes/src/isolation/capability-grants.js";
import { defaultSandboxWrap } from "../packages/modes/src/isolation/realtree-sandbox.js";

const live = process.platform === "darwin" ? describe : describe.skip;

live("real sandbox enforcement (macOS)", () => {
	it("allows writes inside the scope and DENIES writes to a real user location", async () => {
		// NOT under the system temp — macOS/sandbox-runtime allow temp writes by
		// default (tools need it); the meaningful containment is a real HOME path.
		const base = join(
			homedir(),
			`.maestro-sbx-test-${process.pid}-${Date.now()}`,
		);
		const scope = join(base, "scope");
		mkdirSync(scope, { recursive: true });
		const outside = join(base, "outside.txt"); // in HOME, not in the scope
		try {
			const profile = compileWriteProfile("workspace", {
				worktree: scope,
				repoRoot: scope,
				scratch: [],
			});

			// In-scope write succeeds.
			const okCmd = await defaultSandboxWrap(
				`printf x > '${join(scope, "ok.txt")}'`,
				profile,
			);
			execFileSync("bash", ["-c", okCmd], { stdio: "ignore" });
			expect(existsSync(join(scope, "ok.txt"))).toBe(true);

			// Out-of-scope write (a HOME file) is denied by the kernel.
			const badCmd = await defaultSandboxWrap(
				`printf x > '${outside}'`,
				profile,
			);
			let denied = false;
			try {
				execFileSync("bash", ["-c", badCmd], { stdio: "ignore" });
			} catch {
				denied = true;
			}
			expect(existsSync(outside)).toBe(false);
			expect(denied).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	}, 20_000);
});
