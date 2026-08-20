import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createDeleteTool } from "../packages/maestro/src/delete-tool.js";

const dirs: string[] = [];

afterEach(() => {
	for (const directory of dirs.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function temp(name: string): string {
	const path = mkdtempSync(join(tmpdir(), name));
	dirs.push(path);
	return path;
}

function context(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext;
}

describe("recoverable delete", () => {
	it("normalizes absolute path aliases before deriving the trash destination", async () => {
		const cwd = temp("maestro-delete-cwd-");
		const agentDir = temp("maestro-delete-agent-");
		const source = join(cwd, "note.txt");
		writeFileSync(source, "keep me");

		const result = await createDeleteTool(agentDir).execute(
			"delete-1",
			{ paths: [`${cwd}/missing/../note.txt`] },
			undefined,
			undefined,
			context(cwd),
		);
		const details = result.details as { trashRoot: string };

		expect(existsSync(source)).toBe(false);
		expect(details.trashRoot.startsWith(join(agentDir, "trash"))).toBe(true);
		expect(
			existsSync(join(details.trashRoot, source.replace(/^[/\\]+/, ""))),
		).toBe(true);
	});

	it("allocates a distinct trash root for concurrent calls", async () => {
		const cwd = temp("maestro-delete-cwd-");
		const agentDir = temp("maestro-delete-agent-");
		writeFileSync(join(cwd, "one.txt"), "one");
		writeFileSync(join(cwd, "two.txt"), "two");
		const tool = createDeleteTool(agentDir);

		const [one, two] = await Promise.all([
			tool.execute(
				"delete-1",
				{ paths: ["one.txt"] },
				undefined,
				undefined,
				context(cwd),
			),
			tool.execute(
				"delete-2",
				{ paths: ["two.txt"] },
				undefined,
				undefined,
				context(cwd),
			),
		]);

		expect((one.details as { trashRoot: string }).trashRoot).not.toBe(
			(two.details as { trashRoot: string }).trashRoot,
		);
	});
});
