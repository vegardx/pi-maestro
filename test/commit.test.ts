import {
	buildCommitMessagePrompt,
	extractCommitMessage,
	parseChangedPaths,
	runShip,
	type ShipDeps,
} from "@vegardx/pi-commit";
import type { ShipDeliverableInput } from "@vegardx/pi-contracts";

describe("extractCommitMessage", () => {
	it("accepts a clean conventional message", () => {
		expect(extractCommitMessage("feat(core): add thing")).toBe(
			"feat(core): add thing",
		);
	});

	it("strips a wrapping code fence", () => {
		expect(extractCommitMessage("```\nfix: bug\n```")).toBe("fix: bug");
	});

	it("drops leading prose before the first conventional line", () => {
		const raw = "Here is the message:\n\nrefactor(ui): simplify\n\nbody line";
		expect(extractCommitMessage(raw)).toBe(
			"refactor(ui): simplify\n\nbody line",
		);
	});

	it("returns null when nothing looks conventional", () => {
		expect(extractCommitMessage("just some text")).toBeNull();
		expect(extractCommitMessage("")).toBeNull();
	});
});

describe("buildCommitMessagePrompt", () => {
	it("names the deliverable and lists paths", () => {
		const p = buildCommitMessagePrompt("d-1" as never, ["a.ts", "b.ts"]);
		expect(p).toContain('deliverable "d-1"');
		expect(p).toContain("- a.ts");
		expect(p).toContain("conventional-commit");
	});
});

describe("parseChangedPaths", () => {
	it("extracts paths, rename targets, and quoted names; dedupes", () => {
		const porcelain = [
			" M src/a.ts",
			"?? src/b.ts",
			"R  old.ts -> src/c.ts",
			' M "with space.ts"',
			" M src/a.ts",
		].join("\n");
		expect(parseChangedPaths(porcelain)).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"with space.ts",
		]);
	});

	it("returns empty for a clean tree", () => {
		expect(parseChangedPaths("")).toEqual([]);
	});
});

// A baseline set of deps that succeeds end-to-end; tests override per case.
function deps(over: Partial<ShipDeps> = {}): ShipDeps {
	return {
		cwd: "/repo",
		currentBranch: () => "feat/x",
		defaultBranch: async () => "main",
		changedPaths: () => ["a.ts"],
		stageAndCommit: () => ({ ok: true, sha: "abc123" }),
		pushBranch: async () => true,
		findOpenPr: async () => null,
		createPr: async () => 42,
		generateMessage: async () => "feat: add a",
		confirm: async () => true,
		...over,
	};
}

const input: ShipDeliverableInput = {};

describe("runShip", () => {
	it("ships end-to-end: commit, push, open PR", async () => {
		const r = await runShip(deps(), input);
		expect(r).toEqual({
			branch: "feat/x",
			committed: true,
			sha: "abc123",
			pushed: true,
			pr: 42,
		});
	});

	it("refuses to commit on the default branch", async () => {
		const r = await runShip(deps({ currentBranch: () => "main" }), input);
		expect(r).toEqual({ branch: "main", committed: false, pushed: false });
	});

	it("stops when there is nothing to stage", async () => {
		const r = await runShip(deps({ changedPaths: () => [] }), input);
		expect(r.committed).toBe(false);
	});

	it("aborts when the gate is declined", async () => {
		let staged = false;
		const r = await runShip(
			deps({
				confirm: async () => false,
				stageAndCommit: () => {
					staged = true;
					return { ok: true };
				},
			}),
			input,
		);
		expect(r.committed).toBe(false);
		expect(staged).toBe(false);
	});

	it("uses an explicit message without generating one", async () => {
		let generated = false;
		const r = await runShip(
			deps({
				generateMessage: async () => {
					generated = true;
					return "feat: nope";
				},
			}),
			{ message: "fix: explicit" },
		);
		expect(generated).toBe(false);
		expect(r.committed).toBe(true);
	});

	it("returns the existing PR instead of opening a new one", async () => {
		let created = false;
		const r = await runShip(
			deps({
				findOpenPr: async () => 7,
				createPr: async () => {
					created = true;
					return 99;
				},
			}),
			input,
		);
		expect(r.pr).toBe(7);
		expect(created).toBe(false);
	});

	it("skips PR work when openPr is false", async () => {
		const r = await runShip(deps(), { openPr: false });
		expect(r.committed).toBe(true);
		expect(r.pushed).toBe(true);
		expect(r.pr).toBeUndefined();
	});

	it("reports committed-but-not-pushed when push fails", async () => {
		const r = await runShip(deps({ pushBranch: async () => false }), input);
		expect(r).toMatchObject({ committed: true, pushed: false });
		expect(r.pr).toBeUndefined();
	});

	it("operates entirely in deps.cwd (the explicit target tree)", async () => {
		const seen: string[] = [];
		await runShip(
			deps({
				cwd: "/wt/a",
				currentBranch: (cwd) => {
					seen.push(cwd);
					return "feat/x";
				},
				defaultBranch: async (cwd) => {
					seen.push(cwd);
					return "main";
				},
				changedPaths: (cwd) => {
					seen.push(cwd);
					return ["a.ts"];
				},
				stageAndCommit: (cwd) => {
					seen.push(cwd);
					return { ok: true, sha: "abc" };
				},
				pushBranch: async (cwd) => {
					seen.push(cwd);
					return true;
				},
				findOpenPr: async (cwd) => {
					seen.push(cwd);
					return null;
				},
				createPr: async (cwd) => {
					seen.push(cwd);
					return 1;
				},
			}),
			input,
		);
		expect(seen.every((c) => c === "/wt/a")).toBe(true);
		expect(seen.length).toBeGreaterThan(0);
	});
});
