import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "check-docs.mjs");

/**
 * A minimal tree that satisfies rules 1-4, so any failure a test observes comes
 * from rule 5 and not from the scaffolding.
 */
function fixture(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "check-docs-"));
	const write = (rel: string, text: string) => {
		const path = join(dir, rel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, text);
	};
	mkdirSync(join(dir, "packages"), { recursive: true });
	write("README.md", "# fixture\n\nTools: `bash`, `delete`.\n");
	write("docs/usage.md", "# usage\n");
	for (const [rel, text] of Object.entries(files)) write(rel, text);
	return dir;
}

function run(dir: string) {
	const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("check-docs rule 5", () => {
	it("passes a tree whose skill references all resolve", () => {
		const dir = fixture({
			"skills/github/SKILL.md": "Use `skills/github-cli` for the CLI.\n",
			"skills/github-cli/SKILL.md": "# gh\n",
		});
		try {
			const { status, out } = run(dir);
			expect(out).toContain("check-docs: OK");
			expect(status).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails when a skill names a sibling skill directory that is absent", () => {
		const dir = fixture({
			"skills/github/SKILL.md": "Defer to `skills/github-actions` for YAML.\n",
		});
		try {
			const { status, out } = run(dir);
			expect(status).toBe(1);
			expect(out).toContain(
				"names skills/github-actions, which this package does not ship",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails on a doc naming an absent skill directory", () => {
		const dir = fixture({
			"docs/architecture.md": "See `skills/workflows` for runs.\n",
		});
		try {
			const { status, out } = run(dir);
			expect(status).toBe(1);
			expect(out).toContain("docs/architecture.md:1 names skills/workflows");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("catches each fictional identifier the bundled skills once claimed", () => {
		const cases: [string, string][] = [
			["Call `workflow_dynamic` to run it.", "workflow_dynamic"],
			["Use the `execution-router` skill.", "execution-router"],
			["Use `workflow-guide` when authoring.", "workflow-guide"],
			["Set `awaitTerminal: true` to block.", "awaitTerminal"],
			["Use `detach: true` for background runs.", "detach"],
			["Run the `deep-research` workflow.", "deep-research"],
			["Run the `impact-review` workflow.", "impact-review"],
		];
		for (const [line, identifier] of cases) {
			const dir = fixture({ "skills/demo/SKILL.md": `${line}\n` });
			try {
				const { status, out } = run(dir);
				expect(status, `${identifier} should fail the gate`).toBe(1);
				expect(out).toContain("skills/demo/SKILL.md:1 names");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	// The other direction, and the reason the list needs pruning as well as
	// growing: `deep-review` is a definition `@vegardx/pi-workflow` now ships,
	// so a doc naming it is telling the truth and the gate must let it.
	it("allows a workflow that has since shipped", () => {
		const dir = fixture({
			"skills/demo/SKILL.md": "Run the `deep-review` workflow.\n",
		});
		try {
			const { status, out } = run(dir);
			expect(out).toContain("check-docs: OK");
			expect(status).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// `plan-review` USED TO BE on the hand-off path — the seat started it as a
	// headless workflow run through `runBuiltin` — and the rule was that the word
	// must stay legal. It is a fiction now: the plan check is a one-shot
	// pi-subagent attempt, nothing starts a `plan-review` workflow, and a doc
	// that says otherwise sends a reader looking for something this seat no
	// longer has.
	it("fails a doc or a skill that still names the blind `plan-review` workflow", () => {
		const dir = fixture({
			"docs/usage.md": "The hand-off starts `plan-review` blind.\n",
		});
		try {
			const { status, out } = run(dir);
			expect(status).toBe(1);
			expect(out).toContain("docs/usage.md:1 names plan-review");
			expect(out).toContain("one-shot pi-subagent attempt");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// A DIFFERENT WORD. The definition this package ships is `plan-reviewer`, and
	// banning its prefix would ban the thing that replaced the fiction.
	it("leaves the `plan-reviewer` definition this package ships alone", () => {
		const dir = fixture({
			"docs/usage.md": "The check runs the `plan-reviewer` definition.\n",
		});
		try {
			const { status, out } = run(dir);
			expect(out).toContain("check-docs: OK");
			expect(status).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves a dated record that names the workflow alone", () => {
		const dir = fixture({
			"docs/design/old.md": "`plan-review` gated the transition then.\n",
		});
		try {
			const { status, out } = run(dir);
			expect(out).toContain("check-docs: OK");
			expect(status).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves dated design and review records alone", () => {
		const dir = fixture({
			"docs/design/old.md": "The `execution-router` was proposed here.\n",
			"docs/reviews/old.md": "`workflow_dynamic` was reviewed here.\n",
		});
		try {
			const { status, out } = run(dir);
			expect(out).toContain("check-docs: OK");
			expect(status).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("check-docs rule 6", () => {
	// The rule used to exempt one section, because this repository had a step of
	// its own next to pi-subagent's — readiness. That step is gone, so there is
	// nothing left to draw a boundary against and no exemption to keep: the word
	// is a failure anywhere a claim is made.
	it("fails a current-state doc that uses the word at all", () => {
		const dir = fixture({
			"docs/workflow-plans.md":
				"## The hand-off\n\nThe preflight step checks every repository.\n",
		});
		try {
			const { status, out } = run(dir);
			expect(status).toBe(1);
			expect(out).toContain('docs/workflow-plans.md:3 says "preflight"');
			expect(out).toContain("launch-plan compile");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails a skill that uses it", () => {
		const dir = fixture({
			"skills/demo/SKILL.md": "# demo\n\nRun preflight before the plan.\n",
		});
		try {
			const { status, out } = run(dir);
			expect(status).toBe(1);
			expect(out).toContain('skills/demo/SKILL.md:3 says "preflight"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exempts no heading, because there is nothing left to disown it under", () => {
		const dir = fixture({
			"docs/usage.md":
				"### Readiness is not preflight\n\nPreflight belongs to pi-subagent.\n",
		});
		try {
			const { status, out } = run(dir);
			expect(status).toBe(1);
			expect(out).toContain("docs/usage.md:1");
			expect(out).toContain("docs/usage.md:3");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves dated records with the older vocabulary alone", () => {
		const dir = fixture({
			"docs/design/old.md":
				"The preflight/postflight pair was designed here.\n",
		});
		try {
			const { status, out } = run(dir);
			expect(out).toContain("check-docs: OK");
			expect(status).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the whole repository", () => {
	it("passes this repository", () => {
		const { status, out } = run(ROOT);
		expect(out).toContain("check-docs: OK");
		expect(status).toBe(0);
	});
});
