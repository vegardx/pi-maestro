// The two mechanical seams the executor declared: where work happens, and how
// it gets out.
//
// The workspace half runs against a real repository, because worktree
// mechanics are exactly the kind of thing that reads correct and behaves
// otherwise. The shipping half separates the decisions from git and gh, so the
// decisions can be asserted without a network.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Deliverable } from "../packages/maestro/src/plan.js";
import { validatePlan } from "../packages/maestro/src/plan.js";
import {
	createShipping,
	numberFromUrl,
	prBody,
	type ShippingOps,
} from "../packages/maestro/src/shipping.js";
import {
	branchFor,
	createWorkspace,
} from "../packages/maestro/src/workspace.js";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "T",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "T",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});

/** A real repository with one commit on `main`. */
function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "maestro-ws-"));
	dirs.push(root);
	const path = join(root, "project");
	execFileSync("mkdir", ["-p", path]);
	git(path, "init", "-q", "-b", "main");
	writeFileSync(join(path, "README.md"), "# project\n");
	git(path, "add", "README.md");
	git(path, "commit", "-q", "-m", "first");
	return path;
}

const deliverable = (
	id: string,
	over: Partial<Deliverable> = {},
): Deliverable => ({
	id,
	title: `Deliverable ${id}`,
	after: [],
	reads: [],
	tasks: [{ id: `${id}-1`, title: `do ${id}` }],
	...over,
});

describe("a deliverable id has to survive becoming a branch", () => {
	it("refuses one that would need escaping", () => {
		// The id becomes a branch name and a directory. An id that needs escaping
		// is an id where two deliverables can collide into one branch, so the
		// constraint lives in plan validation rather than in an escaping step.
		const errors = validatePlan({
			slug: "arc",
			title: "Arc",
			preflight: [],
			postflight: [],
			repos: [{ key: "main", path: "/repo" }],
			deliverables: [deliverable("Build The API")],
		});
		expect(errors).toContainEqual(expect.stringContaining("cannot be an id"));
	});

	it("derives the branch rather than storing it", () => {
		expect(branchFor(deliverable("api"))).toBe("deliverable/api");
	});
});

describe("the workspace, against a real repository", () => {
	it("creates a worktree on its own branch", async () => {
		const path = repo();
		const workspace = createWorkspace({ baseBranch: "main" });
		const made = await workspace.create(deliverable("api"), path);

		expect(made.branch).toBe("deliverable/api");
		expect(git(made.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
			"deliverable/api",
		);
		// A worktree, not a clone: it shares the repository.
		expect(git(path, "worktree", "list")).toContain(made.path);
	});

	it("reuses the worktree it made last time", async () => {
		// A resumed run must not fail on a checkout it created itself.
		const path = repo();
		const workspace = createWorkspace({ baseBranch: "main" });
		const first = await workspace.create(deliverable("api"), path);
		const second = await workspace.create(deliverable("api"), path);
		expect(second.path).toBe(first.path);
	});

	it("keeps two deliverables out of each other's way", async () => {
		const path = repo();
		const workspace = createWorkspace({ baseBranch: "main" });
		const api = await workspace.create(deliverable("api"), path);
		const ui = await workspace.create(deliverable("ui"), path);
		expect(api.path).not.toBe(ui.path);
		expect(api.branch).not.toBe(ui.branch);
	});

	it("says what is wrong when it cannot tell what to branch from", async () => {
		const empty = mkdtempSync(join(tmpdir(), "maestro-nonrepo-"));
		dirs.push(empty);
		await expect(
			createWorkspace().create(deliverable("api"), empty),
		).rejects.toThrow(/cannot tell what to branch from/);
	});
});

describe("shipping decides, git and gh do", () => {
	function ops(over: Partial<ShippingOps> = {}) {
		const calls: string[] = [];
		const impl: ShippingOps = {
			dirty: () => false,
			hasCommits: () => true,
			push: async (_w, branch) => {
				calls.push(`push:${branch}`);
				return { ok: true };
			},
			findPr: async () => {
				calls.push("findPr");
				return null;
			},
			openPr: async () => {
				calls.push("openPr");
				return 42;
			},
			...over,
		};
		return { calls, impl };
	}

	const request = (handoff?: string) => ({
		deliverable: deliverable("api", { body: "The HTTP surface." }),
		worktree: "/worktrees/api",
		branch: "deliverable/api",
		...(handoff ? { handoff } : {}),
	});

	it("pushes, looks for a pull request, then opens one", async () => {
		const o = ops();
		const shipping = createShipping({ base: "main", ops: o.impl });
		expect(await shipping.ship(request("POST /v1/things"))).toBe(42);
		expect(o.calls).toEqual(["push:deliverable/api", "findPr", "openPr"]);
	});

	it("updates the pull request it already has rather than opening a second", async () => {
		// A resumed run, or a second pass over the same deliverable.
		const o = ops({ findPr: async () => 7 });
		const shipping = createShipping({ base: "main", ops: o.impl });
		expect(await shipping.ship(request())).toBe(7);
		expect(o.calls).not.toContain("openPr");
	});

	it("refuses to ship a tree with loose changes", async () => {
		// `finish` means the work is committed. Committing here would mean
		// maestro authoring a message for a change it never saw.
		const o = ops({ dirty: () => true });
		const shipping = createShipping({ base: "main", ops: o.impl });
		await expect(shipping.ship(request())).rejects.toThrow(
			/uncommitted changes/,
		);
		expect(o.calls).toEqual([]);
	});

	it("opens no pull request for a deliverable that produced no diff", async () => {
		// Research that ends in a hand-off and nothing else is not a failure, and
		// it does not get an empty pull request.
		const o = ops({ hasCommits: () => false });
		const shipping = createShipping({ base: "main", ops: o.impl });
		expect(await shipping.ship(request("what we learned"))).toBeUndefined();
		expect(o.calls).toEqual([]);
	});

	it("fails the deliverable when the push fails", async () => {
		const o = ops({
			push: async () => ({ ok: false, error: "protected branch" }),
		});
		const shipping = createShipping({ base: "main", ops: o.impl });
		await expect(shipping.ship(request())).rejects.toThrow(/protected branch/);
	});
});

describe("what the pull request says", () => {
	it("leads with the hand-off, because the diff cannot tell you that", () => {
		const body = prBody(
			deliverable("api", { body: "The HTTP surface." }),
			"POST /v1/things is the entry point.",
		);
		expect(body.indexOf("POST /v1/things")).toBeLessThan(
			body.indexOf("The HTTP surface."),
		);
		expect(body).toContain("- do api");
	});

	it("still describes the work when there was no hand-off", () => {
		expect(prBody(deliverable("api"))).toContain("## Work");
	});

	it("reads the number back out of what gh printed", () => {
		expect(numberFromUrl("https://github.com/o/r/pull/391")).toBe(391);
		expect(numberFromUrl(null)).toBeNull();
	});
});
