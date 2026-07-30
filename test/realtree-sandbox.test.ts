// Real-tree per-actor profile derivation + shadow logging (plan step 0).
// Injects git resolvers so the derivation is tested without a real repo.

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	createEnforcingBashOperations,
	createShadowBashOperations,
	type GitDeps,
	resolveProfilePaths,
	SandboxUnavailable,
	selectProfile,
} from "../packages/maestro/src/isolation/realtree-sandbox.js";

const git: GitDeps = {
	toplevel: () => "/repo",
	commonDir: () => "/repo/.git",
	gitDir: (cwd) =>
		cwd === "/repo/.worktrees/node-a"
			? "/repo/.git/worktrees/node-a"
			: "/repo/.git",
};

describe("resolveProfilePaths", () => {
	it("worker: cwd is the worktree; shared + worktree git dirs resolved", () => {
		const paths = resolveProfilePaths(
			"worker",
			"/repo/.worktrees/node-a",
			["/scratch"],
			git,
		);
		expect(paths.worktree).toBe("/repo/.worktrees/node-a");
		expect(paths.worktreeGitDir).toBe("/repo/.git/worktrees/node-a");
		expect(paths.sharedGitDir).toBe("/repo/.git");
		expect(paths.repoRoot).toBe("/repo");
	});

	it("maestro: sees the repo root, no worktree", () => {
		const paths = resolveProfilePaths("maestro", "/repo", ["/scratch"], git);
		expect(paths.repoRoot).toBe("/repo");
		expect(paths.worktree).toBeUndefined();
		expect(paths.sharedGitDir).toBe("/repo/.git");
	});
});

describe("selectProfile", () => {
	it("worker in auto → workspace scope confined to the worktree", () => {
		const { scope, profile } = selectProfile(
			"worker",
			"auto",
			"/repo/.worktrees/node-a",
			["/scratch"],
			git,
		);
		expect(scope).toBe("workspace");
		expect(profile.allowWrite).toContain("/repo/.worktrees/node-a");
		expect(profile.allowWrite).not.toContain("/repo");
		expect(profile.denyWrite).toContain("/repo/.git/config");
	});

	it("maestro in recon → repo scope; hack → unrestricted", () => {
		expect(selectProfile("maestro", "plan", "/repo", ["/s"], git).scope).toBe(
			"repo",
		);
		const hack = selectProfile("worker", "hack", "/repo", ["/s"], git);
		expect(hack.scope).toBe("host");
		expect(hack.profile.unrestricted).toBe(true);
	});
});

describe("createShadowBashOperations", () => {
	it("logs the would-apply profile and runs the command unchanged", async () => {
		const calls: Array<{ command: string; cwd: string }> = [];
		const base: BashOperations = {
			exec: async (command, cwd) => {
				calls.push({ command, cwd });
				return { exitCode: 0 };
			},
		};
		const lines: string[] = [];
		const ops = createShadowBashOperations(base, {
			actor: "worker",
			mode: "auto",
			scratch: ["/scratch"],
			git,
			log: (line) => lines.push(line),
		});
		const result = await ops.exec("echo hi", "/repo/.worktrees/node-a", {
			onData: () => {},
		});
		// The command ran unchanged (report-only)...
		expect(result.exitCode).toBe(0);
		expect(calls).toEqual([
			{ command: "echo hi", cwd: "/repo/.worktrees/node-a" },
		]);
		// ...and the profile it WOULD enforce was logged.
		expect(lines[0]).toContain("actor=worker");
		expect(lines[0]).toContain("scope=workspace");
		expect(lines[0]).toContain("allowWrite=[/repo/.worktrees/node-a");
	});
});

describe("createEnforcingBashOperations", () => {
	function tracker() {
		const ran: string[] = [];
		const base: BashOperations = {
			exec: async (command) => {
				ran.push(command);
				return { exitCode: 0 };
			},
		};
		return { ran, base };
	}
	// The wrap is injected here; production uses the SandboxManager-backed one.
	const wrap = async (
		command: string,
		profile: { allowWrite: readonly string[] },
	) => `SANDBOX(allow=${profile.allowWrite.join(",")}):${command}`;

	it("wraps a scoped command under its allowWrite before running it", async () => {
		const { ran, base } = tracker();
		const ops = createEnforcingBashOperations(base, {
			actor: "worker",
			mode: "auto",
			scratch: ["/scratch"],
			git,
			wrap,
		});
		await ops.exec("echo hi", "/repo/.worktrees/node-a", { onData: () => {} });
		expect(ran[0]).toContain("SANDBOX(allow=/repo/.worktrees/node-a");
		expect(ran[0]).toContain("echo hi");
	});

	it("runs an unrestricted (hack) command WITHOUT wrapping it", async () => {
		const { ran, base } = tracker();
		const ops = createEnforcingBashOperations(base, {
			actor: "worker",
			mode: "hack",
			scratch: ["/scratch"],
			git,
			wrap,
		});
		await ops.exec("rm -rf /", "/repo", { onData: () => {} });
		expect(ran[0]).toBe("rm -rf /");
	});
});

describe("when the sandbox cannot start at all", () => {
	// Found by putting the enforcement proof on a CI runner: the macOS image has
	// no ripgrep, `SandboxManager.initialize` threw, and NOTHING CAUGHT IT. The
	// rejection travelled out through the gated `exec`, so on any machine
	// missing sandbox-runtime's own tools every shell command failed with a
	// library error naming a dependency the user had never heard of.
	it("refuses with something the operator can act on", async () => {
		const failing = createEnforcingBashOperations(
			{ exec: async () => ({ exitCode: 0 }) } as never,
			{
				actor: "worker",
				mode: "auto",
				scratch: ["/tmp"],
				git: {
					toplevel: () => "/repo",
					commonDir: () => "/repo/.git",
					gitDir: () => "/repo/.git/worktrees/w",
				},
				wrap: async () => {
					throw new SandboxUnavailable("Required: ripgrep (rg).");
				},
			},
		);
		await expect(
			failing.exec("npm test", "/repo/w", { onData: () => {} } as never),
		).rejects.toThrow(/ripgrep/);
		await expect(
			failing.exec("npm test", "/repo/w", { onData: () => {} } as never),
		).rejects.toThrow(/MAESTRO_SANDBOX=off/);
	});

	it("does NOT fall back to running unconfined", async () => {
		// The tempting fallback, and the wrong one. Dropping the guarantee this
		// path exists for — quietly — is the defect this codebase keeps finding.
		const ran: string[] = [];
		const failing = createEnforcingBashOperations(
			{
				exec: async (command: string) => {
					ran.push(command);
					return { exitCode: 0 };
				},
			} as never,
			{
				actor: "worker",
				mode: "auto",
				scratch: ["/tmp"],
				git: {
					toplevel: () => "/repo",
					commonDir: () => "/repo/.git",
					gitDir: () => "/repo/.git/worktrees/w",
				},
				wrap: async () => {
					throw new SandboxUnavailable("Required: ripgrep (rg).");
				},
			},
		);
		await failing
			.exec("rm -rf /", "/repo/w", { onData: () => {} } as never)
			.catch(() => undefined);
		expect(ran).toEqual([]);
	});
});
