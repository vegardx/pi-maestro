import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadOrCreateWorkflowCommandRun,
	releaseUnapprovedWorkflowCommandRun,
	releaseWorkflowCommandRun,
	workflowCommandAuthoredDigest,
} from "../../../packages/maestro/src/workflow/command-run.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "maestro-command-run-"));
	roots.push(root);
	return {
		maestroStateRoot: join(root, "state"),
		coordinatedRunsRoot: join(root, "runs"),
		planSlug: "multi-repo-plan",
		authoredDigest: workflowCommandAuthoredDigest({ plan: "first" }),
	};
}

describe("workflow command run identity", () => {
	it("resumes the same durable run identity after a seat restart", () => {
		const input = fixture();
		const first = loadOrCreateWorkflowCommandRun({
			...input,
			now: () => 1,
			uuid: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		});
		const resumed = loadOrCreateWorkflowCommandRun({
			...input,
			now: () => 2,
			uuid: () => "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		});
		expect(resumed).toEqual(first);
	});

	it("releases an unapproved identity so a later approval is a fresh run", () => {
		const input = fixture();
		const first = loadOrCreateWorkflowCommandRun({
			...input,
			now: () => 1,
			uuid: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		});
		releaseWorkflowCommandRun({
			maestroStateRoot: input.maestroStateRoot,
			planSlug: input.planSlug,
			runId: first.runId,
		});
		const next = loadOrCreateWorkflowCommandRun({
			...input,
			now: () => 2,
			uuid: () => "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		});
		expect(next.runId).not.toBe(first.runId);
	});

	it("fails closed when a same-slug plan changes during a resumable run", () => {
		const input = fixture();
		loadOrCreateWorkflowCommandRun({
			...input,
			now: () => 1,
			uuid: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		});
		expect(() =>
			loadOrCreateWorkflowCommandRun({
				...input,
				authoredDigest: workflowCommandAuthoredDigest({ plan: "edited" }),
			}),
		).toThrow(/changed while workflow run .* remains resumable/);
	});

	it("releases failed read-only preapproval state but preserves an approved run", () => {
		const input = fixture();
		const first = loadOrCreateWorkflowCommandRun({
			...input,
			now: () => 1,
			uuid: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		});
		const runnerRoot = join(input.maestroStateRoot, "workflow-plan-runs");
		mkdirSync(runnerRoot, { recursive: true });
		writeFileSync(join(runnerRoot, `${first.runId}.json`), "preview\n");

		expect(
			releaseUnapprovedWorkflowCommandRun({
				maestroStateRoot: input.maestroStateRoot,
				coordinatedRunsRoot: input.coordinatedRunsRoot,
				planSlug: input.planSlug,
				runId: first.runId,
			}),
		).toBe(true);
		expect(existsSync(first.coordinatedRunRoot)).toBe(false);
		expect(existsSync(join(runnerRoot, `${first.runId}.json`))).toBe(false);

		const approved = loadOrCreateWorkflowCommandRun({
			...input,
			now: () => 2,
			uuid: () => "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		});
		const approvals = join(input.maestroStateRoot, "workflow-approvals");
		mkdirSync(approvals, { recursive: true });
		writeFileSync(join(approvals, `${approved.runId}.json`), "approved\n");
		expect(
			releaseUnapprovedWorkflowCommandRun({
				maestroStateRoot: input.maestroStateRoot,
				coordinatedRunsRoot: input.coordinatedRunsRoot,
				planSlug: input.planSlug,
				runId: approved.runId,
			}),
		).toBe(false);
		expect(existsSync(approved.coordinatedRunRoot)).toBe(true);
	});
});
