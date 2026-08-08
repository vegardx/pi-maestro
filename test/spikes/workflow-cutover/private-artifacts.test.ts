import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type PrivateArtifactReference,
	PrivateArtifactStore,
} from "../../../packages/maestro/src/workflow/private-artifacts.js";

const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0)
		rmSync(roots.pop() as string, { recursive: true, force: true });
});

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "maestro-private-")));
	roots.push(root);
	const repo = join(root, "kindling", "api");
	const worktree = join(root, "worktrees", "api", "maestro-run");
	const workflowState = join(root, "workflow-home", ".pi", "workflows");
	const maestroState = join(root, "maestro-state");
	for (const path of [repo, worktree, workflowState, maestroState])
		mkdirSync(path, { recursive: true });
	return { root, repo, worktree, workflowState, maestroState };
}

function review() {
	return {
		sanitizedFindings: [
			{
				id: "finding-token-comparison",
				claim: "Callback tokens use an ordinary equality comparison.",
				evidence: [
					{
						path: "src/callback.ts",
						line: 84,
						observation: "The comparison uses ===.",
					},
				],
			},
		],
		rawFindings: [
			{
				rawId: "raw-security-opus-secret",
				lens: "security",
				claim: "Callback tokens use an ordinary equality comparison.",
				evidence: [
					{
						path: "src/callback.ts",
						line: 84,
						observation: "The comparison uses ===.",
					},
				],
				stageId: "security-opus",
				taskId: "security-opus/item-0",
				resolvedModel: "anthropic/opus-5-private",
			},
		],
		provenance: [
			{
				findingId: "finding-token-comparison",
				contributors: [
					{
						rawFindingId: "raw-security-opus-secret",
						lens: "security",
						stageId: "security-opus",
						taskId: "security-opus/item-0",
						resolvedModel: "anthropic/opus-5-private",
					},
				],
			},
		],
	};
}

function allText(root: string): string {
	const chunks: string[] = [];
	const visit = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile()) chunks.push(readFileSync(child, "utf8"));
		}
	};
	visit(root);
	return chunks.join("\n");
}

describe("W0 private provenance artifacts", () => {
	it("exposes a de-attributed projection and joins provenance only at the seat", () => {
		const paths = fixture();
		// pi-workflow may retain its own raw task output. The first-cutover
		// guarantee is that Maestro never projects this identity into the
		// implementer's inputs, not hostile-process filesystem confidentiality.
		writeFileSync(
			join(paths.workflowState, "reviewer-raw.md"),
			"anthropic/opus-5-private security-opus/item-0",
		);
		const store = new PrivateArtifactStore({
			maestroStateRoot: paths.maestroState,
			coordinatedRepositoryRoots: [paths.repo, paths.worktree],
			sharedWorkflowRoots: [paths.workflowState],
		});
		const stored = store.putReview(review());

		// This simulates the only artifact handed to the implementer. It may be
		// written into the shared worktree, but contains only the normalized claim
		// and an opaque integrity reference.
		writeFileSync(
			join(paths.worktree, "implementer-findings.json"),
			JSON.stringify(stored.projection),
		);
		for (const searchableRoot of [paths.repo, paths.worktree]) {
			const text = allText(searchableRoot);
			expect(text).not.toContain("anthropic/opus-5-private");
			expect(text).not.toContain("security-opus/item-0");
			expect(text).not.toContain("raw-security-opus-secret");
		}
		expect(allText(paths.workflowState)).toContain("anthropic/opus-5-private");
		expect(JSON.stringify(stored.projection)).not.toContain("resolvedModel");
		expect(JSON.stringify(stored.projection)).not.toContain(
			stored.reference.id,
		);
		expect(stored.reference.id).toMatch(/^[a-f0-9]{32}$/);
		expect(stored.reference.digest).toMatch(/^[a-f0-9]{64}$/);

		const joined = store.joinAfterDecisions(stored.reference, [
			{
				findingId: "finding-token-comparison",
				decision: "changed",
				reasoning: "Switched to the existing constant-time helper.",
				commitRefs: ["abc123"],
			},
		]);
		expect(joined.findings[0]?.provenance.contributors[0]).toMatchObject({
			taskId: "security-opus/item-0",
			resolvedModel: "anthropic/opus-5-private",
		});
		expect(joined.findings[0]?.decision.commitRefs).toEqual(["abc123"]);
		expect(joined.rawFindings[0]?.rawId).toBe("raw-security-opus-secret");

		if (process.platform !== "win32") {
			const privateRoot = join(paths.maestroState, "private-artifacts");
			const artifact = join(privateRoot, `${stored.reference.id}.json`);
			expect(statSync(privateRoot).mode & 0o777).toBe(0o700);
			expect(statSync(artifact).mode & 0o777).toBe(0o600);
		}
	});

	it("rejects private roots overlapping repositories or shared workflow state", () => {
		const paths = fixture();
		expect(
			() =>
				new PrivateArtifactStore({
					maestroStateRoot: join(paths.worktree, ".maestro"),
					coordinatedRepositoryRoots: [paths.repo, paths.worktree],
					sharedWorkflowRoots: [paths.workflowState],
				}),
		).toThrow(/must be disjoint/);
		expect(
			() =>
				new PrivateArtifactStore({
					maestroStateRoot: paths.workflowState,
					coordinatedRepositoryRoots: [paths.repo, paths.worktree],
					sharedWorkflowRoots: [paths.workflowState],
				}),
		).toThrow(/must be disjoint/);
	});

	it("rejects traversal-shaped references and detects private ledger tampering", () => {
		const paths = fixture();
		const store = new PrivateArtifactStore({
			maestroStateRoot: paths.maestroState,
			coordinatedRepositoryRoots: [paths.repo, paths.worktree],
			sharedWorkflowRoots: [paths.workflowState],
		});
		const stored = store.putReview(review());
		expect(() =>
			store.joinAfterDecisions(
				{
					id: "../../reviewer-ledger",
					digest: stored.reference.digest,
				} as PrivateArtifactReference,
				[],
			),
		).toThrow(/invalid private artifact reference/);

		const artifact = join(
			paths.maestroState,
			"private-artifacts",
			`${stored.reference.id}.json`,
		);
		writeFileSync(artifact, `${readFileSync(artifact, "utf8")} `);
		expect(() =>
			store.joinAfterDecisions(stored.reference, [
				{
					findingId: "finding-token-comparison",
					decision: "no_change",
					reasoning: "Not applicable.",
				},
			]),
		).toThrow(/integrity check failed/);
	});

	it("rejects dangling or mismatched contributor provenance", () => {
		const paths = fixture();
		const store = new PrivateArtifactStore({
			maestroStateRoot: paths.maestroState,
			coordinatedRepositoryRoots: [paths.repo, paths.worktree],
			sharedWorkflowRoots: [paths.workflowState],
		});
		const input = review();

		expect(() =>
			store.putReview({
				...input,
				provenance: [
					{
						...input.provenance[0],
						contributors: [
							{
								...input.provenance[0].contributors[0],
								rawFindingId: "missing-raw-finding",
							},
						],
					},
				],
			}),
		).toThrow(/unknown raw finding/);

		expect(() =>
			store.putReview({
				...input,
				provenance: [
					{
						...input.provenance[0],
						contributors: [
							{
								...input.provenance[0].contributors[0],
								resolvedModel: "fabricated/model",
							},
						],
					},
				],
			}),
		).toThrow(/metadata does not match/);
	});
});
