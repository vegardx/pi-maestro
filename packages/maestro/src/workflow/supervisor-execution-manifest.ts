import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	parse,
	relative,
	resolve,
} from "node:path";

export interface WorkflowExecutionArtifact {
	readonly path: string;
	readonly sha256: string;
}

export interface WorkflowExecutionRepository {
	readonly id: string;
	readonly root: string;
}

export interface WorkflowExecutionBundle {
	readonly root: string;
	/** Exact, sorted inventory relative to root. */
	readonly files: readonly {
		readonly path: string;
		readonly sha256: string;
	}[];
}

export interface WorkflowExecutionManifest {
	readonly version: 1;
	readonly runId: string;
	readonly launch: {
		readonly task: string;
		readonly executionProfile: string | null;
		readonly inputOverrides: Readonly<Record<string, WorkflowExecutionJson>>;
	};
	readonly artifacts: {
		readonly spec: WorkflowExecutionArtifact;
		readonly bundle: WorkflowExecutionBundle;
		readonly helpers: readonly WorkflowExecutionArtifact[];
		/** Content-bound only; semantic validation belongs to the future compiler. */
		readonly models: WorkflowExecutionArtifact;
		/** Content-bound only; semantic validation belongs to the future compiler. */
		readonly profile: WorkflowExecutionArtifact;
	};
	readonly repositories: readonly WorkflowExecutionRepository[];
	/** Content-bound only; semantic validation belongs to the future compiler. */
	readonly authorityPolicy: WorkflowExecutionArtifact;
	readonly materialization: {
		readonly runtimeRoot: string;
		readonly workflowStateRoot: string;
		readonly writableRoots: readonly string[];
		/** Exact prior workflow run trees hidden from this phase. */
		readonly deniedReadRoots: readonly string[];
		readonly materializationDigest: string;
		readonly agentToolkitDigest: string;
		readonly agentToolkitName: "@vegardx/agent-toolkit";
		readonly agentToolkitVersion: string;
		/** Declared metadata only; agentToolkitDigest verifies the actual tree. */
		readonly agentToolkitSourceRevision: string;
	};
}

export type WorkflowExecutionJson =
	| null
	| boolean
	| number
	| string
	| readonly WorkflowExecutionJson[]
	| { readonly [key: string]: WorkflowExecutionJson };

export interface WorkflowExecutionManifestBinding {
	readonly coordinatedRunRoot: string;
	readonly coordinatedWorktreeRoots: readonly string[];
	readonly runtimeRoot: string;
	readonly workflowStateRoot: string;
	readonly writableRoots: readonly string[];
	readonly deniedReadRoots: readonly string[];
	readonly materializationDigest: string;
	readonly agentToolkitDigest: string;
	readonly agentToolkitName: "@vegardx/agent-toolkit";
	readonly agentToolkitVersion: string;
	readonly agentToolkitSourceRevision: string;
}

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TOP_KEYS = new Set([
	"version",
	"runId",
	"launch",
	"artifacts",
	"repositories",
	"authorityPolicy",
	"materialization",
]);
const LAUNCH_KEYS = new Set(["task", "executionProfile", "inputOverrides"]);
const ARTIFACT_GROUP_KEYS = new Set([
	"spec",
	"bundle",
	"helpers",
	"models",
	"profile",
]);
const ARTIFACT_KEYS = new Set(["path", "sha256"]);
const BUNDLE_KEYS = new Set(["root", "files"]);
const REPOSITORY_KEYS = new Set(["id", "root"]);
const MATERIALIZATION_KEYS = new Set([
	"runtimeRoot",
	"workflowStateRoot",
	"writableRoots",
	"deniedReadRoots",
	"materializationDigest",
	"agentToolkitDigest",
	"agentToolkitName",
	"agentToolkitVersion",
	"agentToolkitSourceRevision",
]);

export function canonicalWorkflowExecutionManifest(
	manifest: WorkflowExecutionManifest,
): string {
	validateWorkflowExecutionManifest(manifest);
	return canonicalJson(manifest);
}

export function digestWorkflowExecutionManifest(
	manifest: WorkflowExecutionManifest,
): string {
	return sha256(canonicalWorkflowExecutionManifest(manifest));
}

export function validateWorkflowExecutionManifest(
	value: unknown,
): asserts value is WorkflowExecutionManifest {
	if (!isStrictRecord(value, TOP_KEYS) || value.version !== 1)
		throw new Error("invalid workflow execution manifest");
	if (typeof value.runId !== "string" || !ID.test(value.runId))
		throw new Error("invalid workflow execution manifest run ID");
	if (
		!isStrictRecord(value.launch, LAUNCH_KEYS) ||
		typeof value.launch.task !== "string" ||
		!value.launch.task.trim() ||
		(value.launch.executionProfile !== null &&
			(typeof value.launch.executionProfile !== "string" ||
				!value.launch.executionProfile.trim())) ||
		!isRecord(value.launch.inputOverrides) ||
		!isJsonValue(value.launch.inputOverrides)
	)
		throw new Error("invalid workflow execution manifest launch");
	if (!isStrictRecord(value.artifacts, ARTIFACT_GROUP_KEYS))
		throw new Error("invalid workflow execution manifest artifacts");
	validateArtifact(value.artifacts.spec, "spec");
	validateBundle(value.artifacts.bundle);
	validateArtifactList(value.artifacts.helpers, "helpers");
	validateArtifact(value.artifacts.models, "models");
	validateArtifact(value.artifacts.profile, "profile");
	validateArtifact(value.authorityPolicy, "authority policy");
	const bundleRoot = canonicalPath(value.artifacts.bundle.root);
	for (const artifact of [value.artifacts.spec, ...value.artifacts.helpers]) {
		assertStrictChild(
			canonicalPath(artifact.path),
			bundleRoot,
			"bundle artifact",
		);
		const relativePath = relative(bundleRoot, canonicalPath(artifact.path));
		const declared = value.artifacts.bundle.files.find(
			(entry) => entry.path === relativePath,
		);
		if (!declared || declared.sha256 !== artifact.sha256)
			throw new Error(
				`workflow execution manifest bundle does not bind ${artifact.path}`,
			);
	}
	if (!Array.isArray(value.repositories) || value.repositories.length === 0)
		throw new Error("workflow execution manifest requires repositories");
	const ids = new Set<string>();
	const roots = new Set<string>();
	for (const repository of value.repositories) {
		if (
			!isStrictRecord(repository, REPOSITORY_KEYS) ||
			typeof repository.id !== "string" ||
			!ID.test(repository.id) ||
			typeof repository.root !== "string" ||
			!isAbsolute(repository.root)
		)
			throw new Error("invalid workflow execution manifest repository");
		if (ids.has(repository.id) || roots.has(resolve(repository.root)))
			throw new Error("duplicate workflow execution manifest repository");
		ids.add(repository.id);
		roots.add(resolve(repository.root));
	}
	if (
		!isStrictRecord(value.materialization, MATERIALIZATION_KEYS) ||
		typeof value.materialization.runtimeRoot !== "string" ||
		!isAbsolute(value.materialization.runtimeRoot) ||
		typeof value.materialization.workflowStateRoot !== "string" ||
		!isAbsolute(value.materialization.workflowStateRoot) ||
		!Array.isArray(value.materialization.writableRoots) ||
		value.materialization.writableRoots.length === 0 ||
		value.materialization.writableRoots.some(
			(root) => typeof root !== "string" || !isAbsolute(root),
		) ||
		!Array.isArray(value.materialization.deniedReadRoots) ||
		value.materialization.deniedReadRoots.some(
			(root) => typeof root !== "string" || !isAbsolute(root),
		) ||
		typeof value.materialization.materializationDigest !== "string" ||
		!DIGEST.test(value.materialization.materializationDigest) ||
		typeof value.materialization.agentToolkitDigest !== "string" ||
		!DIGEST.test(value.materialization.agentToolkitDigest) ||
		value.materialization.agentToolkitName !== "@vegardx/agent-toolkit" ||
		typeof value.materialization.agentToolkitVersion !== "string" ||
		!value.materialization.agentToolkitVersion.trim() ||
		typeof value.materialization.agentToolkitSourceRevision !== "string" ||
		!/^[a-f0-9]{40,64}$/.test(value.materialization.agentToolkitSourceRevision)
	)
		throw new Error("invalid workflow execution manifest materialization");
	const writableRoots = value.materialization.writableRoots.map(canonicalPath);
	const deniedReadRoots = value.materialization.deniedReadRoots.map(
		canonicalDeniedReadPath,
	);
	if (writableRoots.includes(canonicalPath(value.materialization.runtimeRoot)))
		throw new Error(
			"workflow execution manifest runtime root must remain immutable",
		);
	if (
		canonicalJson(writableRoots) !== canonicalJson([...writableRoots].sort()) ||
		new Set(writableRoots).size !== writableRoots.length ||
		!writableRoots.includes(
			canonicalPath(value.materialization.workflowStateRoot),
		)
	)
		throw new Error(
			"workflow execution manifest writable roots must be sorted and include workflow state",
		);
	if (
		canonicalJson(value.materialization.deniedReadRoots) !==
			canonicalJson(deniedReadRoots) ||
		canonicalJson(deniedReadRoots) !==
			canonicalJson([...deniedReadRoots].sort()) ||
		new Set(deniedReadRoots).size !== deniedReadRoots.length
	)
		throw new Error(
			"workflow execution manifest denied read roots must be canonical, sorted, and unique",
		);
	const workflowRunsRoot = canonicalPath(
		resolve(value.materialization.workflowStateRoot, "workflows"),
	);
	for (const root of deniedReadRoots)
		assertStrictChild(root, workflowRunsRoot, "denied workflow read root");
	for (let left = 0; left < writableRoots.length; left += 1)
		for (let right = left + 1; right < writableRoots.length; right += 1)
			if (pathsOverlap(writableRoots[left]!, writableRoots[right]!))
				throw new Error("workflow execution manifest writable roots overlap");
	for (const artifactRoot of [
		bundleRoot,
		canonicalPath(value.artifacts.models.path),
		canonicalPath(value.artifacts.profile.path),
		canonicalPath(value.authorityPolicy.path),
	])
		if (writableRoots.some((root) => pathsOverlap(root, artifactRoot)))
			throw new Error(
				"workflow execution manifest approved artifacts overlap writable roots",
			);
}

export function validateWorkflowExecutionManifestLaunch(
	manifest: WorkflowExecutionManifest,
	request: {
		readonly task: string;
		readonly executionProfile?: string;
		readonly inputOverrides?: Readonly<Record<string, unknown>>;
	},
): void {
	validateWorkflowExecutionManifest(manifest);
	const actual = {
		task: request.task,
		executionProfile: request.executionProfile ?? null,
		inputOverrides: request.inputOverrides ?? {},
	};
	if (canonicalJson(manifest.launch) !== canonicalJson(actual))
		throw new Error("workflow execution manifest launch inputs mismatch");
}

export async function verifyWorkflowExecutionManifest(
	manifest: WorkflowExecutionManifest,
	expectedDigest: string,
	binding: WorkflowExecutionManifestBinding,
): Promise<void> {
	validateWorkflowExecutionManifestBinding(manifest, expectedDigest, binding);
	const runRoot = canonicalPath(binding.coordinatedRunRoot);
	await verifyBundle(manifest.artifacts.bundle, runRoot);
	const runtimeArtifacts = [
		manifest.artifacts.models,
		manifest.artifacts.profile,
		manifest.authorityPolicy,
	];
	for (const artifact of runtimeArtifacts) {
		const artifactPath = canonicalPath(artifact.path);
		assertStrictChild(
			artifactPath,
			resolve(runRoot, "runtime"),
			"approved artifact",
		);
		const actual = sha256(await readFile(artifactPath));
		if (actual !== artifact.sha256)
			throw new Error(
				`workflow execution artifact digest mismatch: ${artifact.path}`,
			);
	}
	const runtimeModelsPath = resolve(
		canonicalPath(binding.runtimeRoot),
		"immutable",
		"pi-agent",
		"models.json",
	);
	const runtimeModelsMetadata = await lstat(runtimeModelsPath);
	if (
		!runtimeModelsMetadata.isFile() ||
		runtimeModelsMetadata.isSymbolicLink() ||
		sha256(await readFile(runtimeModelsPath)) !==
			manifest.artifacts.models.sha256
	)
		throw new Error(
			"workflow runtime models do not match the approved execution artifact",
		);
}

async function verifyBundle(
	bundle: WorkflowExecutionBundle,
	runRoot: string,
): Promise<void> {
	const rootMetadata = await lstat(bundle.root);
	if (rootMetadata.isSymbolicLink())
		throw new Error("workflow execution bundle root cannot be a symlink");
	if (!rootMetadata.isDirectory())
		throw new Error("workflow execution bundle root must be a directory");
	const bundleRoot = canonicalPath(bundle.root);
	assertStrictChild(bundleRoot, resolve(runRoot, "runtime"), "approved bundle");
	const actual = await inventoryBundle(bundleRoot);
	if (canonicalJson(actual) !== canonicalJson(bundle.files))
		throw new Error("workflow execution bundle inventory mismatch");
}

async function inventoryBundle(
	root: string,
	directory = root,
): Promise<Array<{ path: string; sha256: string }>> {
	const result: Array<{ path: string; sha256: string }> = [];
	for (const name of (await readdir(directory)).sort()) {
		const absolute = resolve(directory, name);
		const metadata = await lstat(absolute);
		if (metadata.isSymbolicLink())
			throw new Error(
				`workflow execution bundle contains symlink: ${absolute}`,
			);
		if (metadata.isDirectory()) {
			result.push(...(await inventoryBundle(root, absolute)));
			continue;
		}
		if (!metadata.isFile())
			throw new Error(
				`workflow execution bundle contains special file: ${absolute}`,
			);
		result.push({
			path: relative(root, absolute),
			sha256: sha256(await readFile(absolute)),
		});
	}
	return result.sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
}

export function validateWorkflowExecutionManifestBinding(
	manifest: WorkflowExecutionManifest,
	expectedDigest: string,
	binding: WorkflowExecutionManifestBinding,
): void {
	validateWorkflowExecutionManifest(manifest);
	if (!DIGEST.test(expectedDigest))
		throw new Error("workflow execution manifest digest must be SHA-256");
	if (digestWorkflowExecutionManifest(manifest) !== expectedDigest)
		throw new Error("workflow execution manifest digest mismatch");
	if (
		manifest.materialization.materializationDigest !==
		binding.materializationDigest
	)
		throw new Error(
			"workflow execution manifest materialization digest mismatch",
		);
	if (
		manifest.materialization.agentToolkitDigest !== binding.agentToolkitDigest
	)
		throw new Error("workflow execution manifest toolkit digest mismatch");
	if (
		manifest.materialization.agentToolkitName !== binding.agentToolkitName ||
		manifest.materialization.agentToolkitVersion !==
			binding.agentToolkitVersion ||
		manifest.materialization.agentToolkitSourceRevision !==
			binding.agentToolkitSourceRevision
	)
		throw new Error("workflow execution manifest toolkit identity mismatch");
	if (
		canonicalPath(manifest.materialization.runtimeRoot) !==
		canonicalPath(binding.runtimeRoot)
	)
		throw new Error("workflow execution manifest runtime root mismatch");
	if (
		canonicalPath(manifest.materialization.workflowStateRoot) !==
			canonicalPath(binding.workflowStateRoot) ||
		!sameStringSet(
			manifest.materialization.writableRoots.map(canonicalPath),
			binding.writableRoots.map(canonicalPath),
		)
	)
		throw new Error("workflow execution manifest writable roots mismatch");
	const boundDeniedReadRoots = binding.deniedReadRoots.map(
		canonicalDeniedReadPath,
	);
	if (
		canonicalJson(binding.deniedReadRoots) !==
			canonicalJson(boundDeniedReadRoots) ||
		canonicalJson(boundDeniedReadRoots) !==
			canonicalJson([...boundDeniedReadRoots].sort()) ||
		new Set(boundDeniedReadRoots).size !== boundDeniedReadRoots.length
	)
		throw new Error(
			"workflow execution manifest bound denied read roots must be canonical, sorted, and unique",
		);
	if (
		canonicalJson(manifest.materialization.deniedReadRoots) !==
		canonicalJson(boundDeniedReadRoots)
	)
		throw new Error("workflow execution manifest denied read roots mismatch");
	const runRoot = canonicalPath(binding.coordinatedRunRoot);
	const declaredRoots = manifest.repositories.map((repository) =>
		canonicalPath(repository.root),
	);
	const boundRoots = binding.coordinatedWorktreeRoots.map(canonicalPath);
	if (!sameStringSet(declaredRoots, boundRoots))
		throw new Error("workflow execution manifest repository roots mismatch");
	for (const root of declaredRoots)
		assertStrictChild(root, resolve(runRoot, "repos"), "repository");
	assertStrictChild(
		canonicalPath(binding.runtimeRoot),
		resolve(runRoot, "scratch"),
		"runtime",
	);
}

export async function readCanonicalWorkflowExecutionManifest(
	path: string,
	expectedDigest: string,
): Promise<WorkflowExecutionManifest> {
	if (!isAbsolute(path))
		throw new Error("workflow execution manifest path must be absolute");
	const source = await readFile(path, "utf8");
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw new Error("workflow execution manifest is not JSON");
	}
	validateWorkflowExecutionManifest(value);
	const canonical = `${canonicalWorkflowExecutionManifest(value)}\n`;
	if (source !== canonical)
		throw new Error("workflow execution manifest is not canonical JSON");
	if (sha256(canonical.slice(0, -1)) !== expectedDigest)
		throw new Error("workflow execution manifest digest mismatch");
	return value;
}

function validateArtifact(
	value: unknown,
	label: string,
): asserts value is WorkflowExecutionArtifact {
	if (
		!isStrictRecord(value, ARTIFACT_KEYS) ||
		typeof value.path !== "string" ||
		!isAbsolute(value.path) ||
		typeof value.sha256 !== "string" ||
		!DIGEST.test(value.sha256)
	)
		throw new Error(`invalid workflow execution manifest ${label}`);
}

function validateArtifactList(
	value: unknown,
	label: string,
): asserts value is readonly WorkflowExecutionArtifact[] {
	if (!Array.isArray(value))
		throw new Error(`invalid workflow execution manifest ${label}`);
	const paths = new Set<string>();
	for (const artifact of value) {
		validateArtifact(artifact, label);
		if (paths.has(resolve(artifact.path)))
			throw new Error(
				`duplicate workflow execution manifest ${label} artifact`,
			);
		paths.add(resolve(artifact.path));
	}
}

function validateBundle(
	value: unknown,
): asserts value is WorkflowExecutionBundle {
	if (
		!isStrictRecord(value, BUNDLE_KEYS) ||
		typeof value.root !== "string" ||
		!isAbsolute(value.root) ||
		!Array.isArray(value.files) ||
		value.files.length === 0
	)
		throw new Error("invalid workflow execution manifest bundle");
	let previous = "";
	for (const file of value.files) {
		if (
			!isStrictRecord(file, ARTIFACT_KEYS) ||
			typeof file.path !== "string" ||
			!validRelativeBundlePath(file.path) ||
			typeof file.sha256 !== "string" ||
			!DIGEST.test(file.sha256) ||
			file.path <= previous
		)
			throw new Error(
				"workflow execution manifest bundle inventory must be exact and sorted",
			);
		previous = file.path;
	}
}

function validRelativeBundlePath(path: string): boolean {
	return (
		path.length > 0 &&
		!isAbsolute(path) &&
		!path.includes("\\") &&
		resolve("/bundle", path).startsWith("/bundle/") &&
		!path.split("/").some((part) => !part || part === "." || part === "..")
	);
}

function isStrictRecord(
	value: unknown,
	keys: ReadonlySet<string>,
): value is Record<string, unknown> {
	return (
		isRecord(value) &&
		Object.keys(value).every((key) => keys.has(key)) &&
		Object.keys(value).length === keys.size
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("manifest JSON requires finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	throw new Error("manifest value must be JSON");
}

function canonicalPath(input: string): string {
	if (!isAbsolute(input))
		throw new Error("workflow execution manifest paths must be absolute");
	let cursor = resolve(input);
	const missing: string[] = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		missing.unshift(basename(cursor));
		cursor = parent;
	}
	const result = resolve(realpathSync(cursor), ...missing);
	if (result === parse(result).root)
		throw new Error(
			"workflow execution manifest paths must not be filesystem root",
		);
	return result;
}

/**
 * A confined child cannot stat a deliberately denied prior-run root. The seat
 * already bound its canonical spelling into the signed manifest and child
 * environment, so verification resolves the readable parent and treats an
 * EPERM/EACCES leaf lexically. Outside confinement the leaf is still required
 * to be a real directory, never a symlink.
 */
function canonicalDeniedReadPath(input: string): string {
	const lexical = resolve(canonicalPath(dirname(input)), basename(input));
	try {
		const info = lstatSync(input);
		if (info.isSymbolicLink())
			throw new Error("denied workflow read root cannot be a symbolic link");
		return realpathSync(input);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "EACCES" || error.code === "EPERM")
		)
			return lexical;
		throw error;
	}
}

function assertStrictChild(
	candidate: string,
	parent: string,
	label: string,
): void {
	const canonicalParent = canonicalPath(parent);
	const rel = relative(canonicalParent, candidate);
	if (!rel || rel.startsWith("..") || isAbsolute(rel))
		throw new Error(
			`workflow execution manifest ${label} must be a strict child of ${canonicalParent}`,
		);
}

function pathsOverlap(left: string, right: string): boolean {
	const relativeToLeft = relative(left, right);
	const relativeToRight = relative(right, left);
	return (
		relativeToLeft === "" ||
		(!relativeToLeft.startsWith("..") && !isAbsolute(relativeToLeft)) ||
		(!relativeToRight.startsWith("..") && !isAbsolute(relativeToRight))
	);
}

function sameStringSet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		[...left].sort().every((value, index) => value === [...right].sort()[index])
	);
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
