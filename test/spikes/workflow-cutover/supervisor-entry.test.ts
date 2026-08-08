import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	executeWorkflowSupervisorRequest,
	validateWorkflowSupervisorRequest,
	verifyWorkflowSpecDigest,
	type WorkflowSupervisorEntryOperations,
	type WorkflowSupervisorRequest,
} from "../../../packages/maestro/src/workflow/supervisor-entry.js";

function request(
	overrides: Partial<WorkflowSupervisorRequest> = {},
): WorkflowSupervisorRequest {
	return {
		version: 1,
		action: "start",
		runId: "run_001",
		cwd: "/coordinated/run",
		specPath: "/coordinated/run/runtime/implement-review.json",
		specSha256: "a".repeat(64),
		executionManifestPath: "/coordinated/run/runtime/execution-manifest.json",
		executionManifestSha256: "b".repeat(64),
		task: "Implement the approved workflow.",
		executionProfile: "production",
		inputOverrides: { depth: "standard" },
		waitTimeoutMs: 60_000,
		...overrides,
	};
}

function operations(status = "completed"): WorkflowSupervisorEntryOperations & {
	start: ReturnType<typeof vi.fn>;
	inspect: ReturnType<typeof vi.fn>;
	resume: ReturnType<typeof vi.fn>;
	wait: ReturnType<typeof vi.fn>;
	verifySpec: ReturnType<typeof vi.fn>;
	verifyExecutionManifest: ReturnType<typeof vi.fn>;
} {
	return {
		start: vi.fn(async (_spec, _cwd, options) => ({ runId: options.runId })),
		inspect: vi.fn(async (_cwd, runId) => ({ runId, status })),
		resume: vi.fn(async (_cwd, runId) => ({ runId, status: "running" })),
		wait: vi.fn(async (_cwd, runId) => ({ runId, status })),
		verifySpec: vi.fn(async () => undefined),
		verifyExecutionManifest: vi.fn(async () => undefined),
	};
}

describe("workflow supervisor executable entry", () => {
	it("starts and waits inside the same supervised process", async () => {
		const ops = operations();
		await expect(
			executeWorkflowSupervisorRequest(request(), ops),
		).resolves.toEqual({ runId: "run_001", status: "completed" });
		expect(ops.start).toHaveBeenCalledWith(
			"/coordinated/run/runtime/implement-review.json",
			"/coordinated/run",
			{
				runId: "run_001",
				task: "Implement the approved workflow.",
				executionProfile: "production",
				inputOverrides: { depth: "standard" },
			},
		);
		expect(ops.verifySpec).toHaveBeenCalledWith(
			"/coordinated/run/runtime/implement-review.json",
			"a".repeat(64),
		);
		expect(ops.inspect).not.toHaveBeenCalled();
		expect(ops.wait).toHaveBeenCalledAfter(ops.start);
	});

	it("lets the package resume a blocked run before waiting", async () => {
		const ops = operations("blocked");
		await expect(
			executeWorkflowSupervisorRequest(
				request({ action: "continue", executionProfile: undefined }),
				ops,
			),
		).resolves.toEqual({ runId: "run_001", status: "blocked" });
		expect(ops.start).not.toHaveBeenCalled();
		expect(ops.inspect).toHaveBeenCalledWith("/coordinated/run", "run_001");
		expect(ops.resume).toHaveBeenCalledWith("/coordinated/run", "run_001");
		expect(ops.wait).toHaveBeenCalledAfter(ops.resume);
	});

	it("surfaces the package refusal for a non-resumable blocked run", async () => {
		const ops = operations("blocked");
		ops.resume.mockRejectedValue(
			new Error("resume requires a resumable blocked run"),
		);
		await expect(
			executeWorkflowSupervisorRequest(request({ action: "continue" }), ops),
		).rejects.toThrow(/resumable blocked run/);
		expect(ops.wait).not.toHaveBeenCalled();
	});

	it.each(["failed", "interrupted"])(
		"resumes a %s run before waiting",
		async (status) => {
			const ops = operations("completed");
			ops.inspect.mockResolvedValue({ runId: "run_001", status });
			await expect(
				executeWorkflowSupervisorRequest(request({ action: "continue" }), ops),
			).resolves.toEqual({ runId: "run_001", status: "completed" });
			expect(ops.resume).toHaveBeenCalledWith("/coordinated/run", "run_001");
			expect(ops.wait).toHaveBeenCalledAfter(ops.resume);
		},
	);

	it("returns a completed continuation without calling resume", async () => {
		const ops = operations("completed");
		await expect(
			executeWorkflowSupervisorRequest(request({ action: "continue" }), ops),
		).resolves.toEqual({ runId: "run_001", status: "completed" });
		expect(ops.resume).not.toHaveBeenCalled();
		expect(ops.wait).not.toHaveBeenCalled();
	});

	it("waits again after a bounded wait expires while the run is active", async () => {
		const ops = operations("running");
		ops.wait
			.mockRejectedValueOnce(
				new Error("Flow run run_001 still running after 60000ms wait"),
			)
			.mockResolvedValueOnce({ runId: "run_001", status: "completed" });
		ops.inspect.mockResolvedValue({ runId: "run_001", status: "running" });

		await expect(
			executeWorkflowSupervisorRequest(request(), ops),
		).resolves.toEqual({ runId: "run_001", status: "completed" });
		expect(ops.wait).toHaveBeenCalledTimes(2);
	});

	it("does not hide a non-timeout supervisor wait error", async () => {
		const ops = operations("running");
		ops.wait.mockRejectedValue(new Error("workflow store corrupt"));
		await expect(
			executeWorkflowSupervisorRequest(request(), ops),
		).rejects.toThrow(/store corrupt/);
		expect(ops.inspect).not.toHaveBeenCalled();
	});

	it.each([
		{ runId: "../escape" },
		{ cwd: "relative" },
		{ specPath: "relative" },
		{ specSha256: "not-a-digest" },
		{ task: " " },
		{ waitTimeoutMs: 999 },
		{ waitTimeoutMs: 14_400_001 },
		{ inputOverrides: { broken: Number.NaN } },
	] as const)(
		"rejects an invalid request: $runId$cwd$specPath",
		async (invalid) => {
			const ops = operations();
			await expect(
				executeWorkflowSupervisorRequest(request(invalid), ops),
			).rejects.toThrow(/invalid workflow supervisor request/);
			expect(ops.start).not.toHaveBeenCalled();
			expect(ops.wait).not.toHaveBeenCalled();
		},
	);

	it("fails when the runtime resolves another run identity", async () => {
		const ops = operations();
		ops.start.mockResolvedValue({ runId: "other" });
		await expect(
			executeWorkflowSupervisorRequest(request(), ops),
		).rejects.toThrow(/unexpected run ID/);
		expect(ops.wait).not.toHaveBeenCalled();
	});

	it("does not schedule when the approved spec digest no longer matches", async () => {
		const ops = operations();
		ops.verifySpec.mockRejectedValue(new Error("spec digest mismatch"));
		await expect(
			executeWorkflowSupervisorRequest(request(), ops),
		).rejects.toThrow(/spec digest mismatch/);
		expect(ops.start).not.toHaveBeenCalled();
		expect(ops.inspect).not.toHaveBeenCalled();
		expect(ops.wait).not.toHaveBeenCalled();
	});

	it("does not inspect or schedule when child manifest verification fails", async () => {
		const ops = operations();
		ops.verifyExecutionManifest.mockRejectedValue(
			new Error("manifest artifact changed"),
		);
		await expect(
			executeWorkflowSupervisorRequest(request(), ops),
		).rejects.toThrow(/manifest artifact changed/);
		expect(ops.verifySpec).not.toHaveBeenCalled();
		expect(ops.start).not.toHaveBeenCalled();
		expect(ops.inspect).not.toHaveBeenCalled();
	});

	it("verifies the exact persisted workflow spec bytes", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "maestro-spec-digest-"));
		try {
			const specPath = join(fixture, "workflow.json");
			const contents = '{"workflow":"approved"}\n';
			await writeFile(specPath, contents, "utf8");
			const digest = createHash("sha256").update(contents).digest("hex");
			await expect(
				verifyWorkflowSpecDigest(specPath, digest),
			).resolves.toBeUndefined();
			await expect(
				verifyWorkflowSpecDigest(specPath, "0".repeat(64)),
			).rejects.toThrow(/spec digest mismatch/);
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	it.each([null, undefined, [], { ...request(), ignored: true }])(
		"rejects malformed or unknown persisted request data",
		(value) => {
			expect(() => validateWorkflowSupervisorRequest(value)).toThrow(
				/invalid workflow supervisor request/,
			);
		},
	);
});
