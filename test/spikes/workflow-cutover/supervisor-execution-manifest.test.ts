import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRequestExecutionManifest } from "../../../packages/maestro/src/workflow/supervisor-entry.js";
import {
	canonicalWorkflowExecutionManifest,
	digestWorkflowExecutionManifest,
	readCanonicalWorkflowExecutionManifest,
	validateWorkflowExecutionManifest,
	validateWorkflowExecutionManifestBinding,
	verifyWorkflowExecutionManifest,
	type WorkflowExecutionManifest,
} from "../../../packages/maestro/src/workflow/supervisor-execution-manifest.js";
import { persistWorkflowExecutionManifest } from "../../../packages/maestro/src/workflow/supervisor-launcher.js";

const fixtures: string[] = [];

afterEach(async () => {
	await Promise.all(
		fixtures
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "maestro-execution-manifest-"));
	fixtures.push(root);
	const runtime = join(root, "runtime");
	const bundleRoot = join(runtime, "bundle");
	const state = join(runtime, ".pi");
	const repository = join(root, "repos", "api");
	const scratch = join(root, "scratch", "workflow-supervisor");
	const runtimeModels = join(scratch, "immutable", "pi-agent", "models.json");
	const writableRoots = [
		repository,
		state,
		join(scratch, "mutable", "auth.json"),
		join(scratch, "mutable", "home"),
		join(scratch, "mutable", "sessions"),
		join(scratch, "mutable", "tmp"),
	].sort();
	await Promise.all(
		[runtime, bundleRoot, state, repository, scratch].map((path) =>
			mkdir(path, { recursive: true }),
		),
	);
	await mkdir(join(scratch, "immutable", "pi-agent"), { recursive: true });
	await writeFile(runtimeModels, "models\n");
	const artifact = async (name: string, body: string) => {
		const path = join(runtime, name);
		await writeFile(path, body);
		return { path, sha256: sha256(body) };
	};
	const bundleArtifact = async (name: string, body: string) => {
		const path = join(bundleRoot, name);
		await writeFile(path, body);
		return { path, sha256: sha256(body) };
	};
	const spec = await bundleArtifact("workflow.json", "spec\n");
	const helper = await bundleArtifact("helpers.ts", "helpers\n");
	const manifest: WorkflowExecutionManifest = {
		version: 1,
		runId: "run-1",
		launch: {
			task: "approved task",
			executionProfile: null,
			inputOverrides: {},
		},
		artifacts: {
			spec,
			bundle: {
				root: bundleRoot,
				files: [helper, spec]
					.map((entry) => ({
						path: entry.path.slice(bundleRoot.length + 1),
						sha256: entry.sha256,
					}))
					.sort((left, right) => left.path.localeCompare(right.path)),
			},
			helpers: [helper],
			models: await artifact("models.json", "models\n"),
			profile: await artifact("profile.json", "profile\n"),
		},
		repositories: [{ id: "api", root: repository }],
		authorityPolicy: await artifact("authority.json", "authority\n"),
		materialization: {
			runtimeRoot: scratch,
			workflowStateRoot: state,
			writableRoots,
			deniedReadRoots: [],
			materializationDigest: "a".repeat(64),
			agentToolkitDigest: "b".repeat(64),
			agentToolkitName: "@vegardx/agent-toolkit",
			agentToolkitVersion: "1.2.3",
			agentToolkitSourceRevision: "d".repeat(40),
		},
	};
	return {
		root,
		runtime,
		state,
		repository,
		scratch,
		runtimeModels,
		writableRoots,
		manifest,
		digest: digestWorkflowExecutionManifest(manifest),
	};
}

describe("approved workflow execution manifest", () => {
	it("persists the exact canonical approved value and reads it back by digest", async () => {
		const value = await fixture();
		const path = await persistWorkflowExecutionManifest(
			value.manifest,
			value.digest,
			value.state,
		);
		expect(await readFile(path, "utf8")).toBe(
			`${canonicalWorkflowExecutionManifest(value.manifest)}\n`,
		);
		expect(
			await readCanonicalWorkflowExecutionManifest(path, value.digest),
		).toEqual(value.manifest);

		await writeFile(path, `${JSON.stringify(value.manifest, null, 2)}\n`);
		await expect(
			readCanonicalWorkflowExecutionManifest(path, value.digest),
		).rejects.toThrow(/not canonical JSON/);
	});

	it("rejects unknown fields and malformed or duplicate declarations", async () => {
		const { manifest } = await fixture();
		expect(() =>
			validateWorkflowExecutionManifest({ ...manifest, surprise: true }),
		).toThrow(/invalid workflow execution manifest/);
		expect(() =>
			validateWorkflowExecutionManifest({
				...manifest,
				artifacts: {
					...manifest.artifacts,
					spec: { ...manifest.artifacts.spec, sha256: "BAD" },
				},
			}),
		).toThrow(/manifest spec/);
		expect(() =>
			validateWorkflowExecutionManifest({
				...manifest,
				repositories: [
					...manifest.repositories,
					{ id: "api", root: join(manifest.repositories[0]!.root, "copy") },
				],
			}),
		).toThrow(/duplicate.*repository/);
		expect(() =>
			validateWorkflowExecutionManifest({
				...manifest,
				authorityPolicy: {
					path: join(
						manifest.materialization.workflowStateRoot,
						"authority.json",
					),
					sha256: "a".repeat(64),
				},
			}),
		).toThrow(/approved artifacts overlap writable roots/);
		const outsidePath = join(
			manifest.materialization.workflowStateRoot,
			"outside",
		);
		await mkdir(outsidePath);
		const outside = await realpath(outsidePath);
		expect(() =>
			validateWorkflowExecutionManifest({
				...manifest,
				materialization: {
					...manifest.materialization,
					deniedReadRoots: [outside],
				},
			}),
		).toThrow(/denied workflow read root must be a strict child/);
	});

	it("binds approval to the actual materialization and sandbox roots", async () => {
		const value = await fixture();
		const binding = {
			coordinatedRunRoot: value.root,
			coordinatedWorktreeRoots: [value.repository],
			runtimeRoot: value.scratch,
			workflowStateRoot: value.state,
			writableRoots: value.writableRoots,
			deniedReadRoots: [],
			materializationDigest: "a".repeat(64),
			agentToolkitDigest: "b".repeat(64),
			agentToolkitName: "@vegardx/agent-toolkit" as const,
			agentToolkitVersion: "1.2.3",
			agentToolkitSourceRevision: "d".repeat(40),
		};
		expect(() =>
			validateWorkflowExecutionManifestBinding(
				value.manifest,
				value.digest,
				binding,
			),
		).not.toThrow();
		expect(() =>
			validateWorkflowExecutionManifestBinding(value.manifest, value.digest, {
				...binding,
				materializationDigest: "c".repeat(64),
			}),
		).toThrow(/materialization digest mismatch/);
		expect(() =>
			validateWorkflowExecutionManifestBinding(value.manifest, value.digest, {
				...binding,
				coordinatedWorktreeRoots: [join(value.root, "repos", "web")],
			}),
		).toThrow(/repository roots mismatch/);
		expect(() =>
			validateWorkflowExecutionManifestBinding(value.manifest, value.digest, {
				...binding,
				writableRoots: binding.writableRoots.slice(1),
			}),
		).toThrow(/writable roots mismatch/);
		const changedToolkit = {
			...value.manifest,
			materialization: {
				...value.manifest.materialization,
				agentToolkitVersion: "1.2.4",
			},
		};
		expect(() =>
			validateWorkflowExecutionManifestBinding(
				changedToolkit,
				digestWorkflowExecutionManifest(changedToolkit),
				binding,
			),
		).toThrow(/toolkit identity mismatch/);
	});

	it("binds the exact canonical sorted denied-read set", async () => {
		const value = await fixture();
		const reviewAPath = join(value.state, "workflows", "review-a");
		const reviewBPath = join(value.state, "workflows", "review-b");
		await mkdir(reviewAPath, { recursive: true });
		await mkdir(reviewBPath, { recursive: true });
		const reviewA = await realpath(reviewAPath);
		const reviewB = await realpath(reviewBPath);
		const manifest = {
			...value.manifest,
			materialization: {
				...value.manifest.materialization,
				deniedReadRoots: [reviewA, reviewB],
			},
		};
		const digest = digestWorkflowExecutionManifest(manifest);
		const binding = {
			coordinatedRunRoot: value.root,
			coordinatedWorktreeRoots: [value.repository],
			runtimeRoot: value.scratch,
			workflowStateRoot: value.state,
			writableRoots: value.writableRoots,
			deniedReadRoots: [reviewA, reviewB],
			materializationDigest: "a".repeat(64),
			agentToolkitDigest: "b".repeat(64),
			agentToolkitName: "@vegardx/agent-toolkit" as const,
			agentToolkitVersion: "1.2.3",
			agentToolkitSourceRevision: "d".repeat(40),
		};

		expect(() =>
			validateWorkflowExecutionManifestBinding(manifest, digest, binding),
		).not.toThrow();
		expect(() =>
			validateWorkflowExecutionManifestBinding(manifest, digest, {
				...binding,
				deniedReadRoots: [reviewA],
			}),
		).toThrow(/denied read roots mismatch/);
		expect(() =>
			validateWorkflowExecutionManifestBinding(manifest, digest, {
				...binding,
				deniedReadRoots: [reviewB, reviewA],
			}),
		).toThrow(/must be canonical, sorted, and unique/);
	});

	it("verifies every approved artifact before workflow scheduling", async () => {
		const value = await fixture();
		const binding = {
			coordinatedRunRoot: value.root,
			coordinatedWorktreeRoots: [value.repository],
			runtimeRoot: value.scratch,
			workflowStateRoot: value.state,
			writableRoots: value.writableRoots,
			deniedReadRoots: [],
			materializationDigest: "a".repeat(64),
			agentToolkitDigest: "b".repeat(64),
			agentToolkitName: "@vegardx/agent-toolkit" as const,
			agentToolkitVersion: "1.2.3",
			agentToolkitSourceRevision: "d".repeat(40),
		};
		await expect(
			verifyWorkflowExecutionManifest(value.manifest, value.digest, binding),
		).resolves.toBeUndefined();
		await writeFile(value.runtimeModels, "different approved models\n");
		await expect(
			verifyWorkflowExecutionManifest(value.manifest, value.digest, binding),
		).rejects.toThrow(/runtime models do not match/);
		await writeFile(value.runtimeModels, "models\n");
		await writeFile(value.manifest.artifacts.helpers[0]!.path, "poisoned\n");
		await expect(
			verifyWorkflowExecutionManifest(value.manifest, value.digest, binding),
		).rejects.toThrow(/bundle inventory mismatch/);
	});

	it("rejects extra bundle files, symlinks, and special files", async () => {
		const bindingFor = (value: Awaited<ReturnType<typeof fixture>>) => ({
			coordinatedRunRoot: value.root,
			coordinatedWorktreeRoots: [value.repository],
			runtimeRoot: value.scratch,
			workflowStateRoot: value.state,
			writableRoots: value.writableRoots,
			deniedReadRoots: [],
			materializationDigest: "a".repeat(64),
			agentToolkitDigest: "b".repeat(64),
			agentToolkitName: "@vegardx/agent-toolkit" as const,
			agentToolkitVersion: "1.2.3",
			agentToolkitSourceRevision: "d".repeat(40),
		});

		const extra = await fixture();
		await writeFile(
			join(extra.manifest.artifacts.bundle.root, "unapproved.ts"),
			"x",
		);
		await expect(
			verifyWorkflowExecutionManifest(
				extra.manifest,
				extra.digest,
				bindingFor(extra),
			),
		).rejects.toThrow(/bundle inventory mismatch/);

		const missing = await fixture();
		await rm(missing.manifest.artifacts.helpers[0]!.path);
		await expect(
			verifyWorkflowExecutionManifest(
				missing.manifest,
				missing.digest,
				bindingFor(missing),
			),
		).rejects.toThrow(/bundle inventory mismatch/);

		const linked = await fixture();
		await symlink(
			linked.manifest.artifacts.spec.path,
			join(linked.manifest.artifacts.bundle.root, "linked.json"),
		);
		await expect(
			verifyWorkflowExecutionManifest(
				linked.manifest,
				linked.digest,
				bindingFor(linked),
			),
		).rejects.toThrow(/bundle contains symlink/);

		const special = await fixture();
		const fifo = join(special.manifest.artifacts.bundle.root, "pipe");
		execFileSync("mkfifo", [fifo]);
		await expect(
			verifyWorkflowExecutionManifest(
				special.manifest,
				special.digest,
				bindingFor(special),
			),
		).rejects.toThrow(/bundle contains special file/);
	});

	it("is re-verified by the sandbox child against its runtime environment", async () => {
		const value = await fixture();
		const path = await persistWorkflowExecutionManifest(
			value.manifest,
			value.digest,
			value.state,
		);
		const previous = {
			runtime: process.env.PI_MAESTRO_WORKFLOW_RUNTIME_ROOT,
			materialization: process.env.PI_MAESTRO_WORKFLOW_MATERIALIZATION_DIGEST,
			toolkit: process.env.PI_MAESTRO_WORKFLOW_TOOLKIT_DIGEST,
			toolkitVersion: process.env.PI_MAESTRO_WORKFLOW_TOOLKIT_VERSION,
			toolkitRevision: process.env.PI_MAESTRO_WORKFLOW_TOOLKIT_SOURCE_REVISION,
			state: process.env.PI_MAESTRO_WORKFLOW_STATE_ROOT,
			writable: process.env.PI_MAESTRO_WORKFLOW_WRITABLE_ROOTS,
			deniedRead: process.env.PI_MAESTRO_WORKFLOW_DENIED_READ_ROOTS,
		};
		Object.assign(process.env, {
			PI_MAESTRO_WORKFLOW_RUNTIME_ROOT: value.scratch,
			PI_MAESTRO_WORKFLOW_MATERIALIZATION_DIGEST: "a".repeat(64),
			PI_MAESTRO_WORKFLOW_TOOLKIT_DIGEST: "b".repeat(64),
			PI_MAESTRO_WORKFLOW_TOOLKIT_VERSION: "1.2.3",
			PI_MAESTRO_WORKFLOW_TOOLKIT_SOURCE_REVISION: "d".repeat(40),
			PI_MAESTRO_WORKFLOW_STATE_ROOT: value.state,
			PI_MAESTRO_WORKFLOW_WRITABLE_ROOTS: JSON.stringify(value.writableRoots),
			PI_MAESTRO_WORKFLOW_DENIED_READ_ROOTS: "[]",
		});
		const request = {
			version: 1 as const,
			action: "start" as const,
			runId: "run-1",
			cwd: value.root,
			specPath: value.manifest.artifacts.spec.path,
			specSha256: value.manifest.artifacts.spec.sha256,
			executionManifestPath: path,
			executionManifestSha256: value.digest,
			task: "approved task",
			waitTimeoutMs: 60_000,
		};
		try {
			await expect(
				verifyRequestExecutionManifest(request, () => undefined),
			).resolves.toBeUndefined();
			const unapprovedReview = join(
				await realpath(value.state),
				"workflows",
				"unapproved-review",
			);
			await mkdir(unapprovedReview, { recursive: true });
			process.env.PI_MAESTRO_WORKFLOW_DENIED_READ_ROOTS = JSON.stringify([
				unapprovedReview,
			]);
			await expect(
				verifyRequestExecutionManifest(request, () => undefined),
			).rejects.toThrow(/denied read roots mismatch/);
			process.env.PI_MAESTRO_WORKFLOW_DENIED_READ_ROOTS = "[]";
			process.env.PI_MAESTRO_WORKFLOW_TOOLKIT_DIGEST = "c".repeat(64);
			await expect(
				verifyRequestExecutionManifest(request, () => undefined),
			).rejects.toThrow(/toolkit digest mismatch/);
		} finally {
			restoreEnvironment("PI_MAESTRO_WORKFLOW_RUNTIME_ROOT", previous.runtime);
			restoreEnvironment(
				"PI_MAESTRO_WORKFLOW_MATERIALIZATION_DIGEST",
				previous.materialization,
			);
			restoreEnvironment(
				"PI_MAESTRO_WORKFLOW_TOOLKIT_DIGEST",
				previous.toolkit,
			);
			restoreEnvironment(
				"PI_MAESTRO_WORKFLOW_TOOLKIT_VERSION",
				previous.toolkitVersion,
			);
			restoreEnvironment(
				"PI_MAESTRO_WORKFLOW_TOOLKIT_SOURCE_REVISION",
				previous.toolkitRevision,
			);
			restoreEnvironment("PI_MAESTRO_WORKFLOW_STATE_ROOT", previous.state);
			restoreEnvironment(
				"PI_MAESTRO_WORKFLOW_WRITABLE_ROOTS",
				previous.writable,
			);
			restoreEnvironment(
				"PI_MAESTRO_WORKFLOW_DENIED_READ_ROOTS",
				previous.deniedRead,
			);
		}
	});
});

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function restoreEnvironment(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
