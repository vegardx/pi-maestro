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
	wait: ReturnType<typeof vi.fn>;
	verifySpec: ReturnType<typeof vi.fn>;
} {
	return {
		start: vi.fn(async (_spec, _cwd, options) => ({ runId: options.runId })),
		inspect: vi.fn(async (_cwd, runId) => ({ runId })),
		wait: vi.fn(async (_cwd, runId) => ({ runId, status })),
		verifySpec: vi.fn(async () => undefined),
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

	it("continues an existing run without attempting duplicate initialization", async () => {
		const ops = operations("blocked");
		await expect(
			executeWorkflowSupervisorRequest(
				request({ action: "continue", executionProfile: undefined }),
				ops,
			),
		).resolves.toEqual({ runId: "run_001", status: "blocked" });
		expect(ops.start).not.toHaveBeenCalled();
		expect(ops.inspect).toHaveBeenCalledWith("/coordinated/run", "run_001");
		expect(ops.wait).toHaveBeenCalledAfter(ops.inspect);
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
