import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	DefaultPackageManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MAESTRO_PACKAGE_PINS, maestroPackageIdentity } from "../setup.js";
import {
	buildWorkflowChildEnvironment,
	workflowChildEnvironmentPolicy,
} from "./child-environment.js";
import type {
	WorkflowPhaseRuntimeResolution,
	WorkflowPhaseRuntimeResolver,
} from "./production-phase-launcher.js";
import {
	digestWorkflowRuntimePackage,
	isWorkflowPublicationEnvironmentKey,
	type MaterializeWorkflowSupervisorRuntimeOptions,
	materializeWorkflowSupervisorRuntime,
	type WorkflowRuntimeJson,
	type WorkflowSupervisorRuntimeMaterialization,
} from "./supervisor-runtime.js";

export const AGENT_TOOLKIT_SOURCE_REVISION =
	"d8dcea414dc4086fda540394515b14ce3959c34b";
export const AGENT_TOOLKIT_VERSION = "0.1.0";
export const AGENT_TOOLKIT_TREE_DIGEST =
	"36aadadef7c018095e2e474e4a09390a6add12044cdf4d11070c37c54d4daeb7";

interface ReadOnlyPackageLocator {
	getInstalledPath(
		source: string,
		scope: "user" | "project",
	): string | undefined;
}

export interface HostWorkflowPhaseRuntimeResolverOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly sourceEnvironment?: Readonly<NodeJS.ProcessEnv>;
	/** Environment credentials cross the boundary only when named here. */
	readonly allowedEnvironmentKeys?: readonly string[];
	readonly piExecutable?: string;
	readonly gitExecutable?: string;
	/** Read-only test seam. Production constructs Pi's package manager. */
	readonly packageLocator?: ReadOnlyPackageLocator;
	/** Test seam for the immutable package-tree verifier. */
	readonly digestPackage?: (packageRoot: string) => string;
	readonly materializeRuntime?: (
		options: MaterializeWorkflowSupervisorRuntimeOptions,
	) => WorkflowSupervisorRuntimeMaterialization;
}

/**
 * Resolve a phase runtime from the seat's global Pi installation without
 * installing, updating, resolving, or executing package code.
 */
export class HostWorkflowPhaseRuntimeResolver
	implements WorkflowPhaseRuntimeResolver
{
	readonly #cwd: string;
	readonly #agentDir: string;
	readonly #environment: Readonly<NodeJS.ProcessEnv>;
	readonly #allowedEnvironmentKeys: readonly string[];
	readonly #piExecutable?: string;
	readonly #gitExecutable?: string;
	readonly #packageLocator: ReadOnlyPackageLocator;
	readonly #digestPackage: (packageRoot: string) => string;
	readonly #materialize: NonNullable<
		HostWorkflowPhaseRuntimeResolverOptions["materializeRuntime"]
	>;

	constructor(options: HostWorkflowPhaseRuntimeResolverOptions) {
		this.#cwd = canonicalDirectory(options.cwd, "workflow host cwd");
		this.#agentDir = canonicalDirectory(
			options.agentDir,
			"workflow host agent directory",
		);
		this.#environment = options.sourceEnvironment ?? process.env;
		this.#allowedEnvironmentKeys = normalizeEnvironmentKeys(
			options.allowedEnvironmentKeys ?? [],
		);
		this.#piExecutable = options.piExecutable;
		this.#gitExecutable = options.gitExecutable;
		const settings = SettingsManager.create(this.#cwd, this.#agentDir);
		this.#packageLocator =
			options.packageLocator ??
			new DefaultPackageManager({
				cwd: this.#cwd,
				agentDir: this.#agentDir,
				settingsManager: settings,
			});
		this.#digestPackage = options.digestPackage ?? digestWorkflowRuntimePackage;
		this.#materialize =
			options.materializeRuntime ?? materializeWorkflowSupervisorRuntime;
	}

	async resolve(input: {
		readonly coordinatedRunRoot: string;
		readonly runId: string;
		readonly approvedModels: readonly string[];
		readonly approvedProviderIds: readonly string[];
	}): Promise<WorkflowPhaseRuntimeResolution> {
		const runRoot = canonicalDirectory(
			input.coordinatedRunRoot,
			"coordinated workflow run root",
		);
		assertApprovedModelProviders(
			input.approvedModels,
			input.approvedProviderIds,
		);
		const providers = normalizedProviderIds(input.approvedProviderIds);
		const toolkitRoot = this.#installedToolkitRoot();
		assertInstalledRevision(toolkitRoot);
		assertToolkitIdentity(toolkitRoot);
		const snapshotRoot = materializeVerifiedToolkitSnapshot(
			runRoot,
			toolkitRoot,
			this.#digestPackage,
		);
		const sourceAuth = selectedAuth(
			readRequiredObject(join(this.#agentDir, "auth.json"), "Pi auth"),
			providers,
		);
		const models = selectedModels(
			readOptionalModels(join(this.#agentDir, "models.json")),
			providers,
		);
		const options: MaterializeWorkflowSupervisorRuntimeOptions = {
			coordinatedRunRoot: runRoot,
			runtimeNamespace: input.runId,
			sourceEnvironment: selectedEnvironment(
				this.#environment,
				this.#allowedEnvironmentKeys,
			),
			allowedEnvironmentKeys: this.#allowedEnvironmentKeys,
			approvedProviderIds: providers,
			sourceAuth,
			models,
			agentToolkit: {
				sourceRoot: snapshotRoot,
				expectedDigest: AGENT_TOOLKIT_TREE_DIGEST,
				expectedVersion: AGENT_TOOLKIT_VERSION,
				sourceRevision: AGENT_TOOLKIT_SOURCE_REVISION,
			},
			...(this.#piExecutable ? { piExecutable: this.#piExecutable } : {}),
			...(this.#gitExecutable ? { gitExecutable: this.#gitExecutable } : {}),
		};
		return { options, runtime: this.#materialize(options) };
	}

	#installedToolkitRoot(): string {
		if (
			MAESTRO_PACKAGE_PINS.agentToolkit !==
			`git:github.com/vegardx/agent-toolkit@${AGENT_TOOLKIT_SOURCE_REVISION}`
		)
			throw new Error("agent-toolkit setup and runtime pins disagree");
		const settings = SettingsManager.create(this.#cwd, this.#agentDir);
		const packages = settings.getGlobalSettings().packages ?? [];
		const toolkitEntries = packages.filter((entry) =>
			maestroPackageIdentity(typeof entry === "string" ? entry : entry.source),
		);
		if (
			toolkitEntries.length !== 1 ||
			toolkitEntries[0] !== MAESTRO_PACKAGE_PINS.agentToolkit
		)
			throw new Error(
				"global Pi settings must contain exactly the pinned agent-toolkit package",
			);
		const installed = this.#packageLocator.getInstalledPath(
			MAESTRO_PACKAGE_PINS.agentToolkit,
			"user",
		);
		if (!installed)
			throw new Error("pinned agent-toolkit package is not installed");
		return canonicalDirectory(installed, "installed agent-toolkit package");
	}
}

function selectedEnvironment(
	source: Readonly<NodeJS.ProcessEnv>,
	allowedEnvironmentKeys: readonly string[],
): Readonly<NodeJS.ProcessEnv> {
	const selected = buildWorkflowChildEnvironment(
		source,
		workflowChildEnvironmentPolicy(allowedEnvironmentKeys),
	);
	for (const key of Object.keys(selected)) {
		if (
			isWorkflowPublicationEnvironmentKey(key) ||
			key === "GIT_CONFIG_COUNT" ||
			key.startsWith("GIT_CONFIG_KEY_") ||
			key.startsWith("GIT_CONFIG_VALUE_")
		)
			delete selected[key];
	}
	return selected;
}

function materializeVerifiedToolkitSnapshot(
	runRoot: string,
	sourceRoot: string,
	digestPackage: (packageRoot: string) => string,
): string {
	const inputsRoot = join(runRoot, "inputs");
	mkdirSync(inputsRoot, { recursive: true, mode: 0o700 });
	const target = join(
		inputsRoot,
		`agent-toolkit-${AGENT_TOOLKIT_SOURCE_REVISION}`,
	);
	if (existsSync(target)) {
		assertToolkitDigest(target, digestPackage);
		return realpathSync(target);
	}
	const staging = `${target}.staging-${process.pid}-${randomUUID()}`;
	try {
		mkdirSync(staging, { mode: 0o700 });
		copyPackageSnapshot(sourceRoot, staging, true);
		assertToolkitDigest(staging, digestPackage);
		try {
			renameSync(staging, target);
		} catch (cause) {
			if (!existsSync(target)) throw cause;
			assertToolkitDigest(target, digestPackage);
		}
	} finally {
		if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
	}
	return realpathSync(target);
}

function copyPackageSnapshot(
	source: string,
	destination: string,
	isRoot: boolean,
): void {
	for (const name of readdirSync(source).sort()) {
		if (
			isRoot &&
			(name === ".git" ||
				name === "node_modules" ||
				name === "package-lock.json")
		)
			continue;
		const from = join(source, name);
		const to = join(destination, name);
		const info = lstatSync(from);
		if (info.isSymbolicLink())
			throw new Error(
				`agent-toolkit contains a symlink: ${relative(source, from)}`,
			);
		if (info.isDirectory()) {
			mkdirSync(to, { mode: 0o700 });
			copyPackageSnapshot(from, to, false);
		} else if (info.isFile()) {
			copyFileSync(from, to);
		} else {
			throw new Error(`agent-toolkit contains an unsupported entry: ${name}`);
		}
	}
}

function assertToolkitDigest(
	root: string,
	digestPackage: (packageRoot: string) => string,
): void {
	const metadata = lstatSync(root);
	if (!metadata.isDirectory() || metadata.isSymbolicLink())
		throw new Error("agent-toolkit snapshot must be a plain directory");
	assertToolkitIdentity(root);
	if (digestPackage(root) !== AGENT_TOOLKIT_TREE_DIGEST)
		throw new Error(
			"installed agent-toolkit does not match its pinned tree digest",
		);
}

function assertToolkitIdentity(root: string): void {
	const packageJson = readRequiredObject(
		join(root, "package.json"),
		"agent-toolkit package",
	);
	if (
		packageJson.name !== "@vegardx/agent-toolkit" ||
		packageJson.version !== AGENT_TOOLKIT_VERSION
	)
		throw new Error(
			"installed agent-toolkit identity/version does not match pin",
		);
}

function assertInstalledRevision(root: string): void {
	const gitMarker = join(root, ".git");
	if (!existsSync(gitMarker))
		throw new Error("installed agent-toolkit has no revision metadata");
	const marker = lstatSync(gitMarker);
	let gitDir: string;
	if (marker.isDirectory()) gitDir = realpathSync(gitMarker);
	else if (marker.isFile()) {
		const match = readFileSync(gitMarker, "utf8")
			.trim()
			.match(/^gitdir: (.+)$/);
		if (!match)
			throw new Error("installed agent-toolkit revision metadata is invalid");
		gitDir = realpathSync(
			isAbsolute(match[1]) ? match[1] : resolve(root, match[1]),
		);
	} else {
		throw new Error("installed agent-toolkit revision metadata is invalid");
	}
	const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
	let revision = head;
	if (head.startsWith("ref: ")) {
		const ref = head.slice(5);
		if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes(".."))
			throw new Error("installed agent-toolkit HEAD reference is unsafe");
		const loose = join(gitDir, ...ref.split("/"));
		if (existsSync(loose)) revision = readFileSync(loose, "utf8").trim();
		else revision = readPackedRef(join(gitDir, "packed-refs"), ref);
	}
	if (revision !== AGENT_TOOLKIT_SOURCE_REVISION)
		throw new Error("installed agent-toolkit revision does not match pin");
}

function readPackedRef(path: string, ref: string): string {
	if (!existsSync(path))
		throw new Error("installed agent-toolkit HEAD reference is missing");
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		if (line.startsWith("#") || line.startsWith("^") || !line.trim()) continue;
		const separator = line.indexOf(" ");
		if (separator > 0 && line.slice(separator + 1) === ref)
			return line.slice(0, separator);
	}
	throw new Error("installed agent-toolkit HEAD reference is missing");
}

function selectedAuth(
	source: Record<string, WorkflowRuntimeJson>,
	providers: readonly string[],
): Record<string, WorkflowRuntimeJson> {
	const selected: Record<string, WorkflowRuntimeJson> = {};
	for (const provider of providers) {
		if (!(provider in source))
			throw new Error(`Pi auth is missing selected provider ${provider}`);
		const credential = source[provider];
		assertSelectedCredential(provider, credential);
		selected[provider] = structuredClone(credential);
	}
	return selected;
}

function assertSelectedCredential(
	provider: string,
	credential: WorkflowRuntimeJson,
): void {
	if (
		typeof credential !== "object" ||
		credential === null ||
		Array.isArray(credential)
	)
		throw new Error(`Pi auth has invalid selected provider ${provider}`);
	const record = credential as Record<string, WorkflowRuntimeJson>;
	if (record.type === "api_key") {
		if (typeof record.key !== "string" || record.key.length === 0)
			throw new Error(`Pi auth has invalid selected provider ${provider}`);
		return;
	}
	if (record.type === "oauth") {
		if (
			typeof record.access !== "string" ||
			typeof record.refresh !== "string" ||
			typeof record.expires !== "number" ||
			!Number.isFinite(record.expires)
		)
			throw new Error(`Pi auth has invalid selected provider ${provider}`);
		return;
	}
	throw new Error(`Pi auth has invalid selected provider ${provider}`);
}

function readOptionalModels(path: string): Record<string, WorkflowRuntimeJson> {
	if (!existsSync(path)) return { providers: {} };
	return readRequiredObject(path, "Pi models");
}

function selectedModels(
	source: Record<string, WorkflowRuntimeJson>,
	providers: readonly string[],
): WorkflowRuntimeJson {
	if (Object.keys(source).some((key) => key !== "providers"))
		throw new Error("Pi models only supports a providers object");
	const rawProviders = source.providers;
	if (
		typeof rawProviders !== "object" ||
		rawProviders === null ||
		Array.isArray(rawProviders)
	)
		throw new Error("Pi models requires a providers object");
	const available = rawProviders as Record<string, WorkflowRuntimeJson>;
	return {
		providers: Object.fromEntries(
			providers.flatMap((provider) =>
				available[provider] === undefined
					? []
					: [[provider, structuredClone(available[provider])]],
			),
		),
	};
}

function readRequiredObject(
	path: string,
	label: string,
): Record<string, WorkflowRuntimeJson> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (cause) {
		throw new Error(`${label} is missing or invalid JSON`, { cause });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`${label} must contain a JSON object`);
	return parsed as Record<string, WorkflowRuntimeJson>;
}

function assertApprovedModelProviders(
	models: readonly string[],
	providerIds: readonly string[],
): void {
	const fromModels = normalizedProviderIds(
		models.map((model) => {
			const separator = model.indexOf("/");
			if (separator < 1 || separator === model.length - 1)
				throw new Error(
					`approved workflow model is not provider/model: ${model}`,
				);
			return model.slice(0, separator);
		}),
	);
	const approved = normalizedProviderIds(providerIds);
	if (JSON.stringify(fromModels) !== JSON.stringify(approved))
		throw new Error("approved workflow providers do not match approved models");
}

function normalizedProviderIds(values: readonly string[]): string[] {
	const normalized = values.map((value) => value.trim());
	if (
		normalized.length === 0 ||
		normalized.some(
			(value) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
		)
	)
		throw new Error("approved workflow provider IDs are invalid");
	return [...new Set(normalized)].sort();
}

function normalizeEnvironmentKeys(
	values: readonly string[],
): readonly string[] {
	for (const value of values) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
			throw new Error(
				`workflow environment allowlist key is invalid: ${value}`,
			);
	}
	return [...new Set(values)].sort();
}

function canonicalDirectory(path: string, label: string): string {
	if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
	const canonical = realpathSync(path);
	if (!lstatSync(canonical).isDirectory())
		throw new Error(`${label} must be a directory`);
	return canonical;
}
