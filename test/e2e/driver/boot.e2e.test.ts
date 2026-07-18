// Boot smoke test for the full-stack driver: proves that a real `pi --mode rpc`
// process comes up with the maestro extensions loaded, and that the RpcClient's
// JSONL framing + command/response correlation work end to end. Guarded behind
// PI_E2E_BOOT=1 because it forks a real `pi` (and may refresh model catalogs),
// so it is not part of the routine hermetic e2e suite.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedAnswerer } from "./answerer.js";
import { type LaunchedSut, launchSut } from "./launch.js";

const RUN = process.env.PI_E2E_BOOT === "1";

describe.skipIf(!RUN)("pi rpc boot", () => {
	const maestroRoot = process.cwd();
	let piHome: string;
	let repoDir: string;
	let sut: LaunchedSut;

	beforeAll(() => {
		piHome = mkdtempSync(join(tmpdir(), "pi-e2e-home-"));
		repoDir = mkdtempSync(join(tmpdir(), "pi-e2e-repo-"));
		writeFileSync(join(repoDir, "README.md"), "# e2e boot repo\n");
		execFileSync("git", ["init", "-q"], { cwd: repoDir });
		execFileSync("git", ["add", "."], { cwd: repoDir });
		execFileSync(
			"git",
			[
				"-c",
				"user.email=e2e@test",
				"-c",
				"user.name=e2e",
				"commit",
				"-qm",
				"init",
			],
			{ cwd: repoDir },
		);
		sut = launchSut({
			maestroRoot,
			repoDir,
			piHome,
			answerer: new ScriptedAnswerer(),
			transcriptPath: join(piHome, "events.jsonl"),
		});
	});

	afterAll(() => {
		sut?.client.close();
		sut?.child.kill("SIGKILL");
		if (piHome) rmSync(piHome, { recursive: true, force: true });
		if (repoDir) rmSync(repoDir, { recursive: true, force: true });
	});

	it("boots with the maestro extensions and answers get_state", async () => {
		const state = (await sut.client.getState()) as { isStreaming?: boolean };
		expect(state).toBeTruthy();
		expect(state.isStreaming).toBe(false);
	}, 60000);
});
