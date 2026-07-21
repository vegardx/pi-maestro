// The two sandbox seeds, which are easy to confuse and fail differently.
//
// `seedRepo` creates a repo from nothing (local-remote and CI paths): it runs
// `git init`. `seedClonedRepo` seeds a repo that ALREADY EXISTS as a clone (the
// real-GitHub path): no init, and it PUSHES — otherwise agents see the
// scaffolding locally while origin still holds only the README, and the first
// PR's diff carries the seed.
//
// The real-GitHub path shipped without any seed at all, so the planner found a
// bare repo, correctly concluded there was no toolchain, and added a bootstrap
// deliverable the scenario does not expect.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing } from "./env-profile.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "seed-repo-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function expectScaffolding(repoDir: string): void {
	const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
	// The runner the scenario's tests are invoked with. Node strips TypeScript
	// natively, so `node --test` runs the scenario's .ts test files directly.
	expect(pkg.scripts.test).toBe("node --test");
	expect(pkg.type).toBe("module");
	expect(existsSync(join(repoDir, "src"))).toBe(true);
	expect(existsSync(join(repoDir, "tests"))).toBe(true);
}

describe("seedRepo — a repo that does not exist yet", () => {
	it("initialises, commits, and leaves a clean tree", () => {
		const repoDir = join(dir, "fresh");
		mkdirSync(repoDir);
		__testing.seedRepo(repoDir);

		expectScaffolding(repoDir);
		expect(git(repoDir, ["status", "--porcelain"]).trim()).toBe("");
		expect(git(repoDir, ["log", "--oneline"])).toContain(
			"bootstrap e2e sandbox",
		);
	});
});

describe("seedClonedRepo — a repo that already exists", () => {
	it("commits onto the clone and pushes, without re-initialising", () => {
		// A bare origin plus a clone: the shape the real-GitHub path produces.
		const origin = join(dir, "origin.git");
		mkdirSync(origin);
		git(origin, ["init", "-q", "--bare", "-b", "main"]);
		const seedSrc = join(dir, "seed");
		mkdirSync(seedSrc);
		git(seedSrc, ["init", "-q", "-b", "main"]);
		git(seedSrc, [
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"initial",
		]);
		git(seedSrc, ["remote", "add", "origin", origin]);
		git(seedSrc, ["push", "-q", "origin", "main"]);

		const clone = join(dir, "clone");
		execFileSync("git", ["clone", "-q", origin, clone]);
		const gitDirBefore = git(clone, ["rev-parse", "--git-dir"]).trim();

		__testing.seedClonedRepo(clone);

		expectScaffolding(clone);
		expect(git(clone, ["status", "--porcelain"]).trim()).toBe("");
		// Not re-initialised: same git dir, and the clone's history is intact.
		expect(git(clone, ["rev-parse", "--git-dir"]).trim()).toBe(gitDirBefore);
		expect(git(clone, ["log", "--oneline"])).toContain("initial");
		// Pushed: origin carries the seed, so the first PR diff will not.
		expect(git(origin, ["log", "--oneline", "main"])).toContain(
			"bootstrap e2e sandbox",
		);
	});
});
