// How a worker records its work.
//
// It commits IN PROCESS, never through bash. A linked worktree keeps its branch
// ref in the SHARED git dir, which the write profile denies — rightly, since a
// worker rewriting branches that are not its own is what that deny is for. So
// the shell can never be the commit path, and this is the one that is.

import { describe, expect, it } from "vitest";
import {
	changedPaths,
	createCommitTool,
} from "../packages/maestro/src/commit-tool.js";

function tool(
	over: {
		status?: string;
		ok?: boolean;
		stderr?: string;
		head?: string | null;
	} = {},
) {
	const commits: { paths: readonly string[]; message: string }[] = [];
	const definition = createCommitTool({
		cwd: () => "/worktree",
		ops: {
			status: () => over.status ?? " M src/stats.ts\n?? tests/stats.test.ts\n",
			commit: (_cwd, paths, message) => {
				commits.push({ paths, message });
				return {
					ok: over.ok ?? true,
					stderr: over.stderr ?? "",
				};
			},
			head: () => (over.head === undefined ? "abcdef1234567890" : over.head),
		},
	});
	const run = (params: unknown) =>
		(
			definition.execute as unknown as (
				id: string,
				p: unknown,
			) => Promise<{ content: { text: string }[] }>
		)("call-1", params);
	return { run, commits };
}

describe("what git reports as changed", () => {
	it("reads paths out of porcelain, staged or not", () => {
		expect(changedPaths(" M src/a.ts\n?? src/b.ts\nA  src/c.ts\n")).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
		]);
	});

	it("takes the NEW name of a rename", () => {
		// Staging the old name commits nothing — it no longer exists.
		expect(changedPaths("R  src/old.ts -> src/new.ts\n")).toEqual([
			"src/new.ts",
		]);
	});

	it("unquotes a path git had to quote", () => {
		expect(changedPaths(' M "src/with space.ts"\n')).toEqual([
			"src/with space.ts",
		]);
	});

	it("decodes the escapes inside a quoted path, not just its quotes", () => {
		// Git writes non-ASCII bytes as octal escapes. Stripping only the quotes
		// kept the backslashes and named a file that does not exist — so the
		// commit staged nothing, silently. `ø` is \303\270 in UTF-8.
		expect(changedPaths(' M "src/s\\303\\270k.ts"\n')).toEqual(["src/søk.ts"]);
		expect(changedPaths(' M "src/a\\"b.ts"\n')).toEqual(['src/a"b.ts']);
	});

	it("finds nothing in a clean tree", () => {
		expect(changedPaths("")).toEqual([]);
		expect(changedPaths("\n\n")).toEqual([]);
	});
});

describe("committing", () => {
	it("commits everything changed when no paths are named", async () => {
		const t = tool();
		const said = await t.run({ message: "feat: stats" });
		expect(t.commits[0]?.paths).toEqual([
			"src/stats.ts",
			"tests/stats.test.ts",
		]);
		expect(said.content[0].text).toContain("committed 2 files");
		expect(said.content[0].text).toContain("abcdef12");
	});

	it("commits only what was named when paths are given", async () => {
		// Explicit paths are the point: `git add -A` sweeps up whatever else is
		// in the tree, which is a snapshot rather than a commit.
		const t = tool();
		await t.run({ message: "feat: stats", paths: ["src/stats.ts"] });
		expect(t.commits[0]?.paths).toEqual(["src/stats.ts"]);
	});

	it("says the tree is clean rather than committing nothing", async () => {
		const t = tool({ status: "" });
		const said = await t.run({ message: "feat: nothing" });
		expect(t.commits).toEqual([]);
		expect(said.content[0].text).toContain("nothing to commit");
	});

	it("refuses an empty message instead of writing one", async () => {
		const t = tool();
		const said = await t.run({ message: "   " });
		expect(t.commits).toEqual([]);
		expect(said.content[0].text).toContain("needs a message");
	});

	it("refuses a subject that is not a conventional commit", async () => {
		// The schema used to ASK for a conventional subject in prose and check
		// nothing — every commit was conventional only because models complied.
		const t = tool();
		const said = await t.run({ message: "updated some files" });
		expect(t.commits).toEqual([]);
		expect(said.content[0].text).toContain("not a conventional commit");
	});

	it("accepts scope, breaking marker, and a body", async () => {
		const t = tool();
		await t.run({
			message: "feat(runtime)!: drop the v1 surface\n\nWhy: it was dead.",
		});
		expect(t.commits).toHaveLength(1);
	});

	it("RETURNS a git failure rather than throwing it", async () => {
		// A rejected commit is usually something the worker can fix — a hook, a
		// conflict, a bad path. That is unlike a policy refusal, which is an
		// answer and does throw. Conflating them would teach a worker to treat
		// refusals as retryable.
		const t = tool({ ok: false, stderr: "pre-commit hook failed\n" });
		const said = await t.run({ message: "feat: stats" });
		expect(said.content[0].text).toContain("could not commit");
		expect(said.content[0].text).toContain("pre-commit hook failed");
	});

	it("still reports success when the sha cannot be read", async () => {
		const t = tool({ head: null });
		const said = await t.run({ message: "feat: stats" });
		expect(said.content[0].text).toContain("committed 2 files");
	});
});
