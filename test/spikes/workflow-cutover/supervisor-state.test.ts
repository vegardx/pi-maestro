import {
	chmodSync,
	mkdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeWorkflowSupervisorState } from "../../../packages/maestro/src/workflow/supervisor-state.js";

const cleanups: string[] = [];

afterEach(() => {
	for (const path of cleanups.splice(0))
		rmSync(path, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "maestro-workflow-state-"));
	cleanups.push(root);
	return root;
}

describe("workflow supervisor state layout", () => {
	it("maps the package-fixed cwd state path into the writable runtime root", async () => {
		const root = await fixture();
		const first = materializeWorkflowSupervisorState(root);
		expect(first.workflowStateRoot).toBe(
			await realpath(join(root, "runtime", ".pi")),
		);
		expect(readlinkSync(first.workflowStateLink)).toBe(
			relative(first.coordinatedRunRoot, first.workflowStateRoot),
		);

		const workflowRecord = join(root, ".pi", "workflows", "run-1.json");
		mkdirSync(join(root, ".pi", "workflows"), { recursive: true });
		writeFileSync(workflowRecord, "{}\n");
		expect(await realpath(workflowRecord)).toBe(
			join(first.workflowStateRoot, "workflows", "run-1.json"),
		);

		expect(materializeWorkflowSupervisorState(root)).toEqual(first);
	});

	it("refuses a regular cwd state path or a retargeted link on resume", async () => {
		const regularRoot = await fixture();
		mkdirSync(join(regularRoot, ".pi"));
		expect(() => materializeWorkflowSupervisorState(regularRoot)).toThrow(
			/managed symbolic link/,
		);

		const changedRoot = await fixture();
		mkdirSync(join(changedRoot, "other"));
		symlinkSync("other", join(changedRoot, ".pi"), "dir");
		expect(() => materializeWorkflowSupervisorState(changedRoot)).toThrow(
			/link target changed/,
		);
	});

	it("does not follow a runtime-container link outside the coordinated run", async () => {
		const root = await fixture();
		const outside = await fixture();
		symlinkSync(outside, join(root, "runtime"), "dir");
		expect(() => materializeWorkflowSupervisorState(root)).toThrow(
			/must be a real directory/,
		);
		await expect(realpath(join(outside, ".pi"))).rejects.toThrow();
	});

	it("enforces private existing runtime state where POSIX modes apply", async () => {
		const root = await fixture();
		mkdirSync(join(root, "runtime", ".pi"), { recursive: true });
		chmodSync(join(root, "runtime"), 0o755);
		if (process.platform === "win32") {
			expect(() => materializeWorkflowSupervisorState(root)).not.toThrow();
		} else {
			expect(() => materializeWorkflowSupervisorState(root)).toThrow(
				/mode 0700/,
			);
		}
	});

	it("rejects relative and filesystem-wide roots", () => {
		expect(() => materializeWorkflowSupervisorState("relative")).toThrow(
			/must be absolute/,
		);
		expect(() => materializeWorkflowSupervisorState("/")).toThrow(
			/filesystem root/,
		);
	});
});
