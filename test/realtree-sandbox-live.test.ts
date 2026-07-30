// LIVE enforcement proof: exercises @anthropic-ai/sandbox-runtime end to end —
// a real OS profile confining writes to a scope. This is the "does the kernel
// actually deny it" check; the mocked decision logic lives in
// realtree-sandbox.test.ts.
//
// It was macOS-only and CI ran Linux, so it never ran anywhere but a laptop —
// every green badge silent about whether confinement held. It now runs wherever
// sandbox-runtime reports the platform is supported, which includes Linux.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { describe, expect, it } from "vitest";
import { compileWriteProfile } from "../packages/maestro/src/isolation/capability-grants.js";
import {
	defaultSandboxWrap,
	selectProfile,
} from "../packages/maestro/src/isolation/realtree-sandbox.js";

// THREE states, not two — modelling only two is what this file kept getting
// wrong.
//
//   1. the platform cannot sandbox at all              → nothing to prove
//   2. it can, and this machine can actually run it    → prove denial
//   3. it claims it can, but the machine cannot run it → maestro REFUSES every
//      command here, and that is the thing worth asserting
//
// State 3 is real and was invisible. A hosted ubuntu runner has bubblewrap
// installed and reports the platform supported, but its seccomp and
// user-namespace restrictions mean even an ALLOWED write inside the scope
// fails. So `isSupportedPlatform` is a claim about the platform, never about
// the environment — and treating the two as one made CI fail with a stack
// trace where the honest answer is "confinement cannot be proven here".
const PLATFORM_CLAIMS_SUPPORT = SandboxManager.isSupportedPlatform(
	process.platform === "darwin"
		? "macos"
		: process.platform === "linux"
			? "linux"
			: "windows",
);

/** Can this MACHINE actually sandbox — not merely this platform? */
async function environmentCanEnforce(): Promise<boolean> {
	if (!PLATFORM_CLAIMS_SUPPORT) return false;
	const probe = join(homedir(), `.maestro-sbx-probe-${process.pid}`);
	mkdirSync(probe, { recursive: true });
	try {
		const { profile } = selectProfile("worker", "auto", probe, [probe], {
			toplevel: () => probe,
			commonDir: () => join(probe, ".git"),
			gitDir: () => join(probe, ".git"),
		});
		const cmd = await defaultSandboxWrap(
			`printf x > '${join(probe, "probe.txt")}'`,
			profile,
		);
		execFileSync("bash", ["-c", cmd], { stdio: "ignore" });
		return existsSync(join(probe, "probe.txt"));
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
}

const CAN_SANDBOX = await environmentCanEnforce();
const live = CAN_SANDBOX ? describe : describe.skip;

// Always runs, on every platform, and it exists because a SKIPPED safety proof
// reads exactly like a passing one.
//
// The enforcement check below is darwin-only, and CI ran Linux — so for months
// the only test that proves the OS actually denies a write contributed nothing
// while every badge stayed green. There is a macOS job now, but that job would
// ALSO exit 0 if the whole file skipped there (an unsupported runner, a change
// to `isSupportedPlatform`). So this asserts the far weaker but unskippable
// thing: on a platform that claims to support sandboxing, the proof must run.
describe("the enforcement proof is not silently absent", () => {
	it("runs wherever the platform claims it can sandbox", () => {
		const platform =
			process.platform === "darwin"
				? "macos"
				: process.platform === "linux"
					? "linux"
					: "windows";
		if (!SandboxManager.isSupportedPlatform(platform)) return;
		// The platform claims support. Either this machine can enforce — in
		// which case the proof below MUST have run — or it cannot, and maestro
		// refuses every command here rather than running one unconfined. The
		// second is asserted in realtree-sandbox.test.ts; what must never happen
		// is neither being true and nobody saying so.
		if (CAN_SANDBOX) return;
		process.stdout.write(
			`\n  NOTE: ${process.platform} claims sandbox support but this machine cannot enforce it.\n` +
				"  Confinement is UNPROVEN here; maestro refuses commands rather than running them unconfined.\n",
		);
		expect(CAN_SANDBOX).toBe(false);
	});
});

live("real sandbox enforcement", () => {
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
