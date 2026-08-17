import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answers, Questionnaire } from "@vegardx/pi-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	WorkflowApprovalGate,
	type WorkflowApprovalRequest,
} from "../../../packages/maestro/src/workflow/workflow-approval-gate.js";

const fixtures: string[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0))
		rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "maestro-workflow-approval-"));
	fixtures.push(root);
	const maestroState = join(root, "maestro-state");
	const worktree = join(root, "run", "repos", "api");
	const workflowState = join(root, "run", "runtime", ".pi");
	mkdirSync(maestroState, { recursive: true });
	mkdirSync(worktree, { recursive: true });
	mkdirSync(workflowState, { recursive: true });
	const gate = () =>
		new WorkflowApprovalGate({
			maestroStateRoot: maestroState,
			descendantWritableRoots: [worktree, workflowState],
			now: () => new Date("2026-08-08T12:00:00.000Z"),
			depth: () => 0,
		});
	return { root, maestroState, worktree, workflowState, gate };
}

function approval(
	over: Partial<WorkflowApprovalRequest> = {},
): WorkflowApprovalRequest {
	return {
		runId: "run-1",
		planSlug: "ship-api",
		executionDigest: "a".repeat(64),
		approvalText: "Plan: update the API and its contract.",
		...over,
	};
}

function asker(answer: Answers) {
	return { ask: vi.fn(async (_questions: Questionnaire) => answer) };
}

describe("deterministic workflow approval gate", () => {
	it("asks one blocking yes/no question and launches only from a normalized human yes", async () => {
		const value = fixture();
		const human = asker([
			{
				questionId: "workflow-plan-approval",
				value: "  YES  ",
				source: "human",
			},
		]);
		const launch = vi.fn(async () => ({ runId: "workflow-1" }));

		const result = await value.gate().approveAndLaunch({
			approval: approval(),
			asker: human,
			launch,
		});

		expect(result).toMatchObject({
			status: "launched",
			approval: "new",
			launchResult: { runId: "workflow-1" },
			record: {
				runId: "run-1",
				planSlug: "ship-api",
				executionDigest: "a".repeat(64),
				approvedAt: "2026-08-08T12:00:00.000Z",
				source: "human",
			},
		});
		expect(human.ask).toHaveBeenCalledOnce();
		const questions = human.ask.mock.calls[0]?.[0];
		expect(questions).toHaveLength(1);
		expect(questions?.[0]).toMatchObject({
			id: "workflow-plan-approval",
			blocking: true,
			options: [
				{ label: "Yes", value: "yes" },
				{ label: "No", value: "no" },
			],
		});
		expect(questions?.[0]?.question).toContain(approval().approvalText);
		expect(launch).toHaveBeenCalledOnce();
		const stored = readFileSync(
			join(value.maestroState, "workflow-approvals", "run-1.json"),
			"utf8",
		);
		expect(stored).not.toContain(approval().approvalText);
		expect(stored).not.toContain("model");
	});

	it("resumes an identical sealed approval without asking again", async () => {
		const value = fixture();
		const firstAsker = asker([
			{ questionId: "workflow-plan-approval", value: "yes", source: "human" },
		]);
		const first = await value.gate().approveAndLaunch({
			approval: approval(),
			asker: firstAsker,
			launch: async () => "first",
		});
		const mustNotAsk = {
			ask: vi.fn(async () => Promise.reject(new Error("asked"))),
		};
		const launch = vi.fn(async () => "resumed");

		const resumed = await value.gate().approveAndLaunch({
			approval: approval(),
			asker: mustNotAsk,
			launch,
		});

		expect(resumed).toMatchObject({
			status: "launched",
			approval: "resumed",
			launchResult: "resumed",
		});
		expect(resumed.status === "launched" && resumed.record).toEqual(
			first.status === "launched" ? first.record : undefined,
		);
		expect(mustNotAsk.ask).not.toHaveBeenCalled();
		expect(launch).toHaveBeenCalledOnce();
	});

	it("does not lose approval when launch fails and safely launches on resume", async () => {
		const value = fixture();
		const human = asker([
			{ questionId: "workflow-plan-approval", value: "yes", source: "human" },
		]);
		await expect(
			value.gate().approveAndLaunch({
				approval: approval(),
				asker: human,
				launch: async () => {
					throw new Error("launch interrupted");
				},
			}),
		).rejects.toThrow(/launch interrupted/);
		expect(
			existsSync(join(value.maestroState, "workflow-approvals", "run-1.json")),
		).toBe(true);

		const mustNotAsk = {
			ask: vi.fn(async () => Promise.reject(new Error("asked"))),
		};
		await expect(
			value.gate().approveAndLaunch({
				approval: approval(),
				asker: mustNotAsk,
				launch: async () => "recovered",
			}),
		).resolves.toMatchObject({
			status: "launched",
			approval: "resumed",
			launchResult: "recovered",
		});
		expect(mustNotAsk.ask).not.toHaveBeenCalled();
	});

	it.each([
		[
			"autopilot",
			[
				{
					questionId: "workflow-plan-approval",
					value: "yes",
					source: "maestro-auto",
				},
			] as Answers,
			"not-human",
		],
		[
			"maestro",
			[{ questionId: "workflow-plan-approval", value: "yes" }] as Answers,
			"not-human",
		],
		[
			"deferred",
			[
				{
					questionId: "workflow-plan-approval",
					value: "yes",
					source: "human",
					deferred: true,
				},
			] as Answers,
			"deferred",
		],
		[
			"skipped",
			[
				{
					questionId: "workflow-plan-approval",
					value: "yes",
					source: "human",
					skipped: true,
				},
			] as Answers,
			"skipped",
		],
		[
			"no",
			[
				{
					questionId: "workflow-plan-approval",
					value: "no",
					source: "human",
				},
			] as Answers,
			"not-approved",
		],
		["missing", [] as Answers, "missing-answer"],
	] as const)(
		"refuses a %s answer without launch",
		async (_label, answer, reason) => {
			const value = fixture();
			const capability = asker(answer);
			const launch = vi.fn(async () => "must-not-launch");

			await expect(
				value.gate().approveAndLaunch({
					approval: approval(),
					asker: capability,
					launch,
				}),
			).resolves.toEqual({ status: "refused", reason });
			expect(capability.ask).toHaveBeenCalledOnce();
			expect(launch).not.toHaveBeenCalled();
			expect(
				existsSync(
					join(value.maestroState, "workflow-approvals", "run-1.json"),
				),
			).toBe(false);
		},
	);

	it("refuses changed digest, text, or slug without asking, launching, or overwriting", async () => {
		const value = fixture();
		const human = asker([
			{ questionId: "workflow-plan-approval", value: "yes", source: "human" },
		]);
		await value.gate().approveAndLaunch({
			approval: approval(),
			asker: human,
			launch: async () => "started",
		});
		const path = join(value.maestroState, "workflow-approvals", "run-1.json");
		const original = readFileSync(path, "utf8");

		for (const changed of [
			approval({ executionDigest: "b".repeat(64) }),
			approval({ approvalText: "A changed plan" }),
			approval({ planSlug: "different-plan" }),
		]) {
			const mustNotAsk = asker([]);
			const launch = vi.fn(async () => "must-not-launch");
			await expect(
				value.gate().approveAndLaunch({
					approval: changed,
					asker: mustNotAsk,
					launch,
				}),
			).rejects.toThrow(/requires a new run id and explicit approval/);
			expect(mustNotAsk.ask).not.toHaveBeenCalled();
			expect(launch).not.toHaveBeenCalled();
			expect(readFileSync(path, "utf8")).toBe(original);
		}

		const secondHuman = asker([
			{ questionId: "workflow-plan-approval", value: "yes", source: "human" },
		]);
		await expect(
			value.gate().approveAndLaunch({
				approval: approval({
					runId: "run-2",
					executionDigest: "b".repeat(64),
					approvalText: "A changed plan",
				}),
				asker: secondHuman,
				launch: async () => "new-identity",
			}),
		).resolves.toMatchObject({
			status: "launched",
			approval: "new",
			launchResult: "new-identity",
		});
		expect(secondHuman.ask).toHaveBeenCalledOnce();
	});

	it("fails closed on record tampering and unsafe storage authority", async () => {
		const value = fixture();
		const human = asker([
			{ questionId: "workflow-plan-approval", value: "yes", source: "human" },
		]);
		await value.gate().approveAndLaunch({
			approval: approval(),
			asker: human,
			launch: async () => "started",
		});
		const path = join(value.maestroState, "workflow-approvals", "run-1.json");
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace("ship-api", "evil-api"),
		);
		await expect(
			value.gate().approveAndLaunch({
				approval: approval(),
				asker: asker([]),
				launch: async () => "must-not-launch",
			}),
		).rejects.toThrow(/record integrity check failed/);

		expect(
			() =>
				new WorkflowApprovalGate({
					maestroStateRoot: value.maestroState,
					descendantWritableRoots: [value.worktree],
					depth: () => 1,
				}),
		).toThrow(/belongs to depth 0/);
		expect(
			() =>
				new WorkflowApprovalGate({
					maestroStateRoot: value.workflowState,
					descendantWritableRoots: [value.workflowState],
					depth: () => 0,
				}),
		).toThrow(/must be disjoint/);
	});
});
