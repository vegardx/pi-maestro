// The delete tool moves targets to a recoverable trash location — never a hard
// rm. Verifies the source is gone and the target survives under the trash root.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeleteTool } from "../packages/modes/src/delete-tool.js";

let cwd: string;
let agentDir: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "del-cwd-"));
	agentDir = mkdtempSync(join(tmpdir(), "del-agent-"));
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("delete tool (always trash)", () => {
	it("removes the target from the source but keeps it recoverable in trash", async () => {
		const target = join(cwd, "gone.txt");
		writeFileSync(target, "bye");

		const result = (await createDeleteTool().execute(
			"id",
			{ paths: ["gone.txt"] },
			undefined as never,
			() => {},
			{ cwd } as never,
		)) as {
			content: { text: string }[];
			details: { trashRoot: string };
		};

		// Gone from the working tree...
		expect(existsSync(target)).toBe(false);
		expect(result.content[0].text).toContain("gone.txt → trash");
		// ...but recoverable under the trash root (soft delete).
		const trashed = join(
			result.details.trashRoot,
			target.replace(/^[/\\]+/, ""),
		);
		expect(existsSync(trashed)).toBe(true);
	});

	it("skips a missing path without failing the others", async () => {
		writeFileSync(join(cwd, "here.txt"), "x");
		const result = (await createDeleteTool().execute(
			"id",
			{ paths: ["here.txt", "nope.txt"] },
			undefined as never,
			() => {},
			{ cwd } as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("here.txt → trash");
		expect(result.content[0].text).toContain("nope.txt: not found");
	});
});
