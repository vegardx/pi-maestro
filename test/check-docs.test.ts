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
	write("README.md", "# fixture\n\nTools: `plan`, `bash`, `delete`.\n");
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
			["Run the `deep-review` workflow.", "deep-review"],
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

	it("passes this repository", () => {
		const { status, out } = run(ROOT);
		expect(out).toContain("check-docs: OK");
		expect(status).toBe(0);
	});
});
