// The capability grant table + profile compilation (design: "the OS enforces,
// we explain"). Default-deny scoping and the worktree/shared-.git edge.

import { describe, expect, it } from "vitest";
import {
	compileWriteProfile,
	writeScopeFor,
} from "../packages/modes/src/isolation/capability-grants.js";

describe("writeScopeFor (default-deny grant table)", () => {
	it("scopes maestro to the repo, a worker to its workspace, a reviewer to none", () => {
		expect(writeScopeFor("maestro", "auto")).toBe("repo");
		expect(writeScopeFor("maestro", "recon")).toBe("repo");
		expect(writeScopeFor("worker", "auto")).toBe("workspace");
		expect(writeScopeFor("reviewer", "auto")).toBe("none");
	});

	it("hack lifts all restrictions for every actor (global escape hatch)", () => {
		expect(writeScopeFor("maestro", "hack")).toBe("host");
		expect(writeScopeFor("worker", "hack")).toBe("host");
		expect(writeScopeFor("reviewer", "hack")).toBe("host");
	});
});

describe("compileWriteProfile", () => {
	const paths = {
		worktree: "/repo/.worktrees/node-a",
		repoRoot: "/repo",
		worktreeGitDir: "/repo/.git/worktrees/node-a",
		sharedGitDir: "/repo/.git",
		scratch: ["/scratch/home", "/scratch/tmp"],
	};

	it("workspace scope: writes confined to the worktree + its own git dir + scratch", () => {
		const profile = compileWriteProfile("workspace", paths);
		expect(profile.unrestricted).toBe(false);
		expect(profile.allowWrite).toEqual([
			"/repo/.worktrees/node-a",
			"/repo/.git/worktrees/node-a",
			// commit objects go to the SHARED .git/objects (content-addressed, safe).
			"/repo/.git/objects",
			"/scratch/home",
			"/scratch/tmp",
		]);
		// The shared repo config/refs are denied even in scope (git-identity edge).
		expect(profile.denyWrite).toEqual(["/repo/.git/config", "/repo/.git/refs"]);
	});

	it("repo scope: the whole checkout is writable, shared git-state still denied", () => {
		const profile = compileWriteProfile("repo", paths);
		expect(profile.allowWrite).toContain("/repo");
		expect(profile.denyWrite).toContain("/repo/.git/config");
	});

	it("none scope: only private scratch is writable (reviewer)", () => {
		const profile = compileWriteProfile("none", paths);
		expect(profile.allowWrite).toEqual(["/scratch/home", "/scratch/tmp"]);
		expect(profile.denyWrite).toEqual([]);
	});

	it("host scope: unrestricted — the caller runs direct, unsandboxed (hack)", () => {
		const profile = compileWriteProfile("host", paths);
		expect(profile.unrestricted).toBe(true);
		expect(profile.allowWrite).toEqual([]);
	});
});
