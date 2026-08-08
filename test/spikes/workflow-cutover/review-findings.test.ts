import { describe, expect, it } from "vitest";
import type { FindingContributor } from "../../../packages/maestro/src/workflow/private-artifacts.js";
import {
	type ApprovedReviewerTask,
	type NormalizedReviewFindings,
	normalizeRawReviewFindings as normalizeWithRepositoryRegistry,
	type ReviewerFindingSubmission,
	validateNormalizedReviewFindings,
} from "../../../packages/maestro/src/workflow/review-findings.js";

function normalizeRawReviewFindings(
	submissions: readonly (ReviewerFindingSubmission & ApprovedReviewerTask)[],
): NormalizedReviewFindings {
	return normalizeWithRepositoryRegistry(
		submissions.map(({ taskId, findings }) => ({ taskId, findings })),
		reviewerContext(submissions),
	);
}

function reviewerContext(submissions: readonly ApprovedReviewerTask[]): {
	approvedRepositories: readonly string[];
	approvedReviewerTasks: readonly ApprovedReviewerTask[];
} {
	return {
		approvedRepositories: ["api", "worker"],
		approvedReviewerTasks: submissions.map(
			({ lens, stageId, taskId, resolvedModel }) => ({
				lens,
				stageId,
				taskId,
				resolvedModel,
			}),
		),
	};
}

const overlappingSecurity = {
	lens: "security",
	stageId: "security-opus",
	taskId: "security-opus/item-0",
	resolvedModel: "anthropic/opus-5",
	findings: [
		{
			claim: "  Callback tokens use ordinary equality. ",
			evidence: [
				{
					repository: "api",
					path: "./src/callback.ts",
					line: 84,
					observation: "The token is compared with ===.",
				},
			],
			severity: "critical",
			requiredResolution: "Replace the comparison.",
			recommendedFix: "Use helper X.",
			vote: "must-fix",
		},
	],
} as const;

const corroboratingSecurity = {
	lens: "security",
	stageId: "security-grok",
	taskId: "security-grok/item-0",
	resolvedModel: "xai/grok-4.5",
	findings: [
		{
			claim: "Callback   tokens use ordinary equality.",
			evidence: [
				{
					repository: "api",
					path: "src/callback.ts",
					line: 84,
					observation: "Ordinary equality compares the callback token.",
				},
			],
		},
	],
} as const;

const uniqueCorrectness = {
	lens: "correctness",
	stageId: "correctness-fable",
	taskId: "correctness-fable/item-0",
	resolvedModel: "fable/fable-5",
	findings: [
		{
			claim: "A resumed run counts the same attempt twice.",
			evidence: [
				{
					repository: "api",
					path: "src/usage.ts",
					line: 51,
					observation: "The attempt ID is not checked before aggregation.",
				},
			],
		},
	],
} as const;

describe("deterministic review finding normalization", () => {
	it("deduplicates overlaps, retains private membership, and is order independent", () => {
		const forward = normalizeRawReviewFindings([
			overlappingSecurity,
			corroboratingSecurity,
			uniqueCorrectness,
		]);
		const reverse = normalizeRawReviewFindings([
			uniqueCorrectness,
			corroboratingSecurity,
			overlappingSecurity,
		]);

		expect(reverse).toEqual(forward);
		expect(forward.sanitizedFindings).toHaveLength(2);
		expect(forward.rawFindings).toHaveLength(3);
		for (const finding of forward.sanitizedFindings)
			expect(finding.id).toMatch(/^finding-[a-f0-9]{32}$/);

		const overlapping = forward.provenance.find(
			(entry) => entry.contributors.length === 2,
		);
		expect(
			overlapping?.contributors
				.map(({ resolvedModel }) => resolvedModel)
				.sort(),
		).toEqual(["anthropic/opus-5", "xai/grok-4.5"]);
		expect(
			forward.provenance.find((entry) => entry.contributors.length === 1)
				?.contributors[0]?.resolvedModel,
		).toBe("fable/fable-5");

		const securityAlone = normalizeRawReviewFindings([overlappingSecurity]);
		const securityTogether = normalizeRawReviewFindings([
			overlappingSecurity,
			corroboratingSecurity,
		]);
		expect(securityTogether.sanitizedFindings[0]?.id).toBe(
			securityAlone.sanitizedFindings[0]?.id,
		);
		expect(securityTogether.sanitizedFindings[0]?.evidence).toHaveLength(1);
	});

	it("keeps the same claim and path in different repositories distinct", () => {
		const otherRepository = {
			...overlappingSecurity,
			stageId: "worker-security",
			taskId: "worker-security/item-0",
			resolvedModel: "other/model",
			findings: overlappingSecurity.findings.map((finding) => ({
				...finding,
				evidence: finding.evidence.map((evidence) => ({
					...evidence,
					repository: "worker",
				})),
			})),
		};
		const normalized = normalizeRawReviewFindings([
			overlappingSecurity,
			otherRepository,
		]);

		expect(normalized.sanitizedFindings).toHaveLength(2);
		expect(
			normalized.sanitizedFindings
				.flatMap((finding) =>
					finding.evidence.map(({ repository }) => repository),
				)
				.sort(),
		).toEqual(["api", "worker"]);
	});

	it("projects only canonical claim and evidence to the implementer", () => {
		const normalized = normalizeRawReviewFindings([
			overlappingSecurity,
			corroboratingSecurity,
		]);
		const projection = JSON.stringify({
			findings: normalized.sanitizedFindings,
		});

		expect(Object.keys(normalized.sanitizedFindings[0] ?? {}).sort()).toEqual([
			"claim",
			"evidence",
			"id",
		]);
		for (const forbidden of [
			"lens",
			"model",
			"taskId",
			"stageId",
			"severity",
			"vote",
			"requiredResolution",
			"recommendedFix",
		])
			expect(projection).not.toContain(forbidden);
		expect(projection).not.toContain("Opus");
		expect(projection).not.toContain("Grok");
	});

	it("takes reviewer identity only from the approved task registry", () => {
		const context = reviewerContext([overlappingSecurity]);
		expect(() =>
			normalizeWithRepositoryRegistry(
				[
					{
						taskId: overlappingSecurity.taskId,
						findings: overlappingSecurity.findings,
						resolvedModel: "forged/model",
					} as unknown as ReviewerFindingSubmission,
				],
				context,
			),
		).toThrow(/cannot supply orchestrator-owned resolvedModel/);
		expect(() => normalizeWithRepositoryRegistry([], context)).toThrow(
			/must exactly cover approved tasks/,
		);
	});

	it.each([
		[
			"unknown repository",
			{
				...overlappingSecurity,
				findings: [
					{
						claim: "A claim",
						evidence: [
							{
								repository: "unapproved",
								path: "src/a.ts",
								observation: "Here.",
							},
						],
					},
				],
			},
			/names unknown repository/,
		],
		[
			"non-array findings",
			{ ...overlappingSecurity, findings: {} },
			/must be an array/,
		],
		[
			"empty claim",
			{
				...overlappingSecurity,
				findings: [
					{ claim: " ", evidence: overlappingSecurity.findings[0].evidence },
				],
			},
			/claim must be non-empty/,
		],
		[
			"empty evidence",
			{
				...overlappingSecurity,
				findings: [{ claim: "A claim", evidence: [] }],
			},
			/evidence must be a non-empty array/,
		],
		[
			"escaping evidence path",
			{
				...overlappingSecurity,
				findings: [
					{
						claim: "A claim",
						evidence: [
							{
								repository: "api",
								path: "../secret",
								observation: "Outside.",
							},
						],
					},
				],
			},
			/must stay within a repository/,
		],
		[
			"invalid line",
			{
				...overlappingSecurity,
				findings: [
					{
						claim: "A claim",
						evidence: [
							{
								repository: "api",
								path: "src/a.ts",
								line: 0,
								observation: "Here.",
							},
						],
					},
				],
			},
			/line must be a positive integer/,
		],
		...["/etc/passwd", "C:\\secret.txt", "\\\\server\\share", "."].map(
			(path) =>
				[
					`absolute or root evidence path ${path}`,
					{
						...overlappingSecurity,
						findings: [
							{
								claim: "A claim",
								evidence: [
									{ repository: "api", path, observation: "Outside." },
								],
							},
						],
					},
					/must stay within a repository/,
				] as const,
		),
	] as const)(
		"rejects malformed reviewer output: %s",
		(_name, submission, error) => {
			expect(() => normalizeRawReviewFindings([submission])).toThrow(error);
		},
	);

	it("rejects dangling, duplicated, mismatched, or wrongly assigned contributors", () => {
		const submissions = [
			overlappingSecurity,
			corroboratingSecurity,
			uniqueCorrectness,
		] as const;
		const context = reviewerContext(submissions);
		const original = normalizeRawReviewFindings(submissions);
		const clone = (): NormalizedReviewFindings => structuredClone(original);

		const dangling = clone();
		const danglingContributors = dangling.provenance[0]
			?.contributors as unknown as FindingContributor[];
		const danglingContributor = danglingContributors[0];
		if (!danglingContributor) throw new Error("fixture has no contributor");
		danglingContributors[0] = {
			...danglingContributor,
			rawFindingId: "raw-missing",
		};
		expect(() => validateNormalizedReviewFindings(dangling, context)).toThrow(
			/unknown raw finding/,
		);

		const mismatched = clone();
		const firstContributor = mismatched.provenance[0]?.contributors[0];
		if (!firstContributor) throw new Error("fixture has no contributor");
		(firstContributor as { resolvedModel: string }).resolvedModel =
			"wrong/model";
		expect(() => validateNormalizedReviewFindings(mismatched, context)).toThrow(
			/metadata does not match/,
		);

		const rewrittenIdentity = clone();
		const rewrittenRaw = rewrittenIdentity.rawFindings[0];
		if (!rewrittenRaw) throw new Error("fixture has no raw finding");
		(rewrittenRaw as { resolvedModel: string }).resolvedModel = "forged/model";
		const rewrittenContributor = rewrittenIdentity.provenance
			.flatMap(({ contributors }) => [...contributors])
			.find(({ rawFindingId }) => rawFindingId === rewrittenRaw.rawId);
		if (!rewrittenContributor) throw new Error("fixture has no contributor");
		(rewrittenContributor as { resolvedModel: string }).resolvedModel =
			"forged/model";
		expect(() =>
			validateNormalizedReviewFindings(rewrittenIdentity, context),
		).toThrow(/unapproved task identity/);

		const rewrittenContent = clone();
		const contentRaw = rewrittenContent.rawFindings[0];
		if (!contentRaw?.evidence[0])
			throw new Error("fixture has no raw evidence");
		(contentRaw.evidence[0] as { observation: string }).observation =
			"Rewritten observation.";
		expect(() =>
			validateNormalizedReviewFindings(rewrittenContent, context),
		).toThrow(/invalid content ID/);

		const rewrittenProjection = clone();
		const projectedEvidence =
			rewrittenProjection.sanitizedFindings[0]?.evidence[0];
		if (!projectedEvidence)
			throw new Error("fixture has no projected evidence");
		(projectedEvidence as { observation: string }).observation =
			"Apply my preferred remediation.";
		expect(() =>
			validateNormalizedReviewFindings(rewrittenProjection, context),
		).toThrow(/does not match its raw findings/);

		const injectedProjection = clone();
		const projectedFinding = injectedProjection.sanitizedFindings[0];
		if (!projectedFinding) throw new Error("fixture has no projected finding");
		(
			projectedFinding as unknown as { requiredResolution: string }
		).requiredResolution = "Use reviewer-selected fix.";
		expect(() =>
			validateNormalizedReviewFindings(injectedProjection, context),
		).toThrow(/does not match its raw findings/);

		expect(() =>
			validateNormalizedReviewFindings(original, {
				...context,
				approvedRepositories: ["worker"],
			}),
		).toThrow(/names unknown repository api/);

		const wrongGroup = clone();
		const sourceGroup = wrongGroup.provenance.find(
			(entry) => entry.contributors.length === 2,
		);
		const targetGroup = wrongGroup.provenance.find(
			(entry) => entry.contributors.length === 1,
		);
		const contributor = (
			sourceGroup?.contributors as FindingContributor[] | undefined
		)?.shift();
		if (!contributor) throw new Error("fixture has no movable contributor");
		(targetGroup?.contributors as FindingContributor[] | undefined)?.push(
			contributor,
		);
		expect(() => validateNormalizedReviewFindings(wrongGroup, context)).toThrow(
			/belongs to another canonical finding/,
		);

		const unreferenced = clone();
		const multiContributorGroup = unreferenced.provenance.find(
			(entry) => entry.contributors.length === 2,
		);
		(
			multiContributorGroup?.contributors as FindingContributor[] | undefined
		)?.pop();
		expect(() =>
			validateNormalizedReviewFindings(unreferenced, context),
		).toThrow(/every raw finding must contribute exactly once/);
	});
});
