import { createHash } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
} from "node:path";
import {
	buildWorkflowChildEnvironment,
	workflowChildEnvironmentPolicy,
} from "./child-environment.js";

type JsonPrimitive = boolean | number | string | null;
export type WorkflowRuntimeJson =
	| JsonPrimitive
	| readonly WorkflowRuntimeJson[]
	| { readonly [key: string]: WorkflowRuntimeJson };

export interface PinnedAgentToolkitPackage {
	/** A complete, already-installed package tree. Lifecycle installs are forbidden. */
	readonly sourceRoot: string;
	/** SHA-256 returned by {@link digestWorkflowRuntimePackage}. */
	readonly expectedDigest: string;
	/** Exact package.json version approved for this run. */
	readonly expectedVersion: string;
	/** Declared producing revision metadata; the tree digest is what is verified. */
	readonly sourceRevision: string;
}

export interface MaterializeWorkflowSupervisorRuntimeOptions {
	readonly coordinatedRunRoot: string;
	/** Safe package run/phase id; each provider-filtered seal owns one namespace. */
	readonly runtimeNamespace: string;
	readonly sourceEnvironment: Readonly<NodeJS.ProcessEnv>;
	/** Provider/extension environment keys explicitly approved by the launch profile. */
	readonly allowedEnvironmentKeys?: readonly string[];
	/** Provider ids whose model-only credentials may enter the autonomous runtime. */
	readonly approvedProviderIds: readonly string[];
	readonly sourceAuth: Readonly<Record<string, WorkflowRuntimeJson>>;
	/** Credential-blind models.json content selected by the compiled workflow. */
	readonly models: WorkflowRuntimeJson;
	readonly agentToolkit: PinnedAgentToolkitPackage;
	/** Real Pi executable wrapped by the scratch PATH shim. */
	readonly piExecutable?: string;
	/** Real Git executable wrapped to refuse remote/publication operations. */
	readonly gitExecutable?: string;
}

export interface WorkflowSupervisorRuntimeMaterialization {
	readonly runtimeRoot: string;
	readonly homeDir: string;
	readonly tmpDir: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	readonly workflowAuthFile: string;
	readonly settingsFile: string;
	readonly modelsFile: string;
	readonly gitConfigFile: string;
	readonly binDir: string;
	readonly piShimFile: string;
	readonly gitShimFile: string;
	readonly agentToolkitPackageRoot: string;
	readonly agentToolkitDigest: string;
	readonly agentToolkitVersion: string;
	readonly agentToolkitSourceRevision: string;
	/** Digest of every immutable runtime input recorded by materialization.json. */
	readonly materializationDigest: string;
	readonly environment: Readonly<Record<string, string>>;
	/** Mutable roots only; runtimeRoot and immutable inputs are never granted. */
	readonly scratchRoots: readonly string[];
}

interface RuntimeManifest {
	readonly version: 1;
	readonly runtimeNamespace: string;
	readonly inputDigest: string;
	readonly agentToolkitDigest: string;
	readonly agentToolkitVersion: string;
	readonly agentToolkitSourceRevision: string;
	readonly immutableFiles: Readonly<Record<string, string>>;
	readonly authCredentialTypes: Readonly<Record<string, string>>;
	readonly immutableApiKeyDigests: Readonly<Record<string, string>>;
	readonly oauthSchemas: Readonly<Record<string, Record<string, string>>>;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const RUNTIME_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MANIFEST_NAME = "materialization.json";
const PUBLICATION_ENV_KEYS = new Set([
	"GH_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GITHUB_PAT",
	"GIT_ASKPASS",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"SSH_AUTH_SOCK",
	"NODE_AUTH_TOKEN",
	"NPM_TOKEN",
]);
const INHERITED_GIT_CONFIG_ENV_PREFIXES = [
	"GIT_CONFIG_KEY_",
	"GIT_CONFIG_VALUE_",
] as const;

/** Trusted override that clears helpers even when a repository config declares one. */
export const WORKFLOW_CREDENTIAL_RESET_ENV = {
	/** Deny every Git transport; status/diff/log continue to work locally. */
	GIT_ALLOW_PROTOCOL: "",
	GIT_CONFIG_COUNT: "2",
	GIT_CONFIG_KEY_0: "credential.helper",
	GIT_CONFIG_VALUE_0: "",
	GIT_CONFIG_KEY_1: "credential.interactive",
	GIT_CONFIG_VALUE_1: "false",
} as const;

/** Fixed credential boundary shared by materialization and supervisor launch. */
export function isWorkflowPublicationEnvironmentKey(key: string): boolean {
	return PUBLICATION_ENV_KEYS.has(key);
}

/**
 * Materialize the complete private runtime inherited by a workflow supervisor.
 * Existing materializations are verified and reused; they are never repaired or
 * silently overwritten because that could hide a corrupted resume boundary.
 */
export function materializeWorkflowSupervisorRuntime(
	options: MaterializeWorkflowSupervisorRuntimeOptions,
): WorkflowSupervisorRuntimeMaterialization {
	const runRoot = validatedRoot(options.coordinatedRunRoot, "coordinated run");
	if (!RUNTIME_NAMESPACE_PATTERN.test(options.runtimeNamespace))
		throw new Error("workflow runtime namespace is unsafe");
	const sourcePackageRoot = validatedRoot(
		options.agentToolkit.sourceRoot,
		"agent-toolkit package",
	);
	if (!statSync(sourcePackageRoot).isDirectory())
		throw new Error("agent-toolkit package root must be a directory");
	assertPackageShape(sourcePackageRoot);
	if (!DIGEST_PATTERN.test(options.agentToolkit.expectedDigest))
		throw new Error("agent-toolkit expected digest must be lowercase SHA-256");
	const sourcePackageDigest = digestWorkflowRuntimePackage(sourcePackageRoot);
	if (sourcePackageDigest !== options.agentToolkit.expectedDigest)
		throw new Error("agent-toolkit package does not match its pinned digest");
	const toolkitIdentity = readAgentToolkitIdentity(sourcePackageRoot);
	if (toolkitIdentity.version !== options.agentToolkit.expectedVersion)
		throw new Error("agent-toolkit package does not match its pinned version");
	if (!/^[a-f0-9]{40,64}$/.test(options.agentToolkit.sourceRevision))
		throw new Error(
			"agent-toolkit declared source revision must be hex metadata",
		);

	const approvedProviderIds = normalizedProviderIds(
		options.approvedProviderIds,
	);
	const filteredAuth = filterAuth(options.sourceAuth, approvedProviderIds);
	const authCredentialTypes = credentialTypes(filteredAuth);
	const immutableApiKeyDigests = apiKeyDigests(filteredAuth);
	const oauthSchemas = oauthCredentialSchemas(filteredAuth);
	const filteredModels = filterModels(options.models, approvedProviderIds);
	const runtimeRoot = join(
		runRoot,
		"scratch",
		"workflow-supervisors",
		options.runtimeNamespace,
	);
	const paths = runtimePaths(runtimeRoot);
	const settings = {
		defaultProjectTrust: "never",
		packages: [
			{
				source: paths.agentToolkitPackageRoot,
				autoload: false,
				extensions: [],
				skills: ["**"],
				prompts: [],
				themes: [],
			},
		],
	};
	const piExecutable = resolvePiExecutable(
		options.piExecutable,
		options.sourceEnvironment.PATH,
	);
	const gitExecutable = resolveRuntimeExecutable(
		"git",
		options.gitExecutable,
		options.sourceEnvironment.PATH,
	);
	const immutablePayloads = {
		"immutable/pi-agent/models.json": jsonFile(filteredModels),
		"immutable/pi-agent/settings.json": jsonFile(settings),
		"immutable/gitconfig": credentialFreeGitConfig(),
		"immutable/bin/pi": piShim(piExecutable),
		"immutable/bin/git": gitShim(gitExecutable),
	};
	const approvedEnvironmentDigests = Object.fromEntries(
		Object.entries(filteredSourceEnvironment(options))
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, value]) => [key, sha256(value)]),
	);
	const inputDigest = sha256(
		canonicalJson({
			runtimeNamespace: options.runtimeNamespace,
			approvedProviderIds,
			authCredentialTypes,
			immutableApiKeyDigests,
			oauthSchemas,
			immutablePayloads,
			approvedEnvironmentDigests,
			agentToolkitDigest: sourcePackageDigest,
			agentToolkitVersion: toolkitIdentity.version,
			agentToolkitSourceRevision: options.agentToolkit.sourceRevision,
		}),
	);

	if (existsSync(runtimeRoot)) {
		verifyExistingRuntime(
			paths,
			options.runtimeNamespace,
			inputDigest,
			sourcePackageDigest,
			authCredentialTypes,
			immutablePayloads,
			immutableApiKeyDigests,
			oauthSchemas,
		);
	} else {
		materializeNewRuntime(
			paths,
			options.runtimeNamespace,
			sourcePackageRoot,
			filteredAuth,
			immutablePayloads,
			inputDigest,
			sourcePackageDigest,
			toolkitIdentity.version,
			options.agentToolkit.sourceRevision,
			authCredentialTypes,
			immutableApiKeyDigests,
			oauthSchemas,
		);
	}

	return runtimeResult(
		options,
		paths,
		sourcePackageDigest,
		toolkitIdentity.version,
		options.agentToolkit.sourceRevision,
		inputDigest,
	);
}

/** Digest a package's complete path/content tree while rejecting link escapes. */
export function digestWorkflowRuntimePackage(packageRoot: string): string {
	const root = validatedRoot(packageRoot, "package");
	const hash = createHash("sha256");
	for (const entry of packageEntries(root)) {
		hash.update(entry.kind);
		hash.update("\0");
		hash.update(entry.relativePath);
		hash.update("\0");
		if (entry.kind === "file") hash.update(readFileSync(entry.absolutePath));
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** Re-verify the immutable runtime seal inside the sandbox before scheduling. */
export function verifyWorkflowSupervisorRuntimeSeal(
	runtimeRoot: string,
	expected: {
		readonly materializationDigest: string;
		readonly agentToolkitDigest: string;
		readonly agentToolkitVersion: string;
		readonly agentToolkitSourceRevision: string;
	},
): void {
	const paths = runtimePaths(validatedRoot(runtimeRoot, "workflow runtime"));
	const manifest = parseObjectFile(
		join(paths.runtimeRoot, MANIFEST_NAME),
	) as Partial<RuntimeManifest>;
	if (
		manifest.version !== 1 ||
		!RUNTIME_NAMESPACE_PATTERN.test(manifest.runtimeNamespace ?? "") ||
		manifest.runtimeNamespace !== basename(paths.runtimeRoot) ||
		manifest.inputDigest !== expected.materializationDigest ||
		manifest.agentToolkitDigest !== expected.agentToolkitDigest ||
		manifest.agentToolkitVersion !== expected.agentToolkitVersion ||
		manifest.agentToolkitSourceRevision !== expected.agentToolkitSourceRevision
	)
		throw new Error("workflow supervisor immutable runtime seal mismatch");
	if (
		typeof manifest.immutableFiles !== "object" ||
		manifest.immutableFiles === null ||
		Array.isArray(manifest.immutableFiles)
	)
		throw new Error("workflow supervisor immutable file seal is invalid");
	const expectedFiles = [
		"immutable/bin/git",
		"immutable/bin/pi",
		"immutable/gitconfig",
		"immutable/pi-agent/models.json",
		"immutable/pi-agent/settings.json",
	];
	if (!sameJson(Object.keys(manifest.immutableFiles).sort(), expectedFiles))
		throw new Error("workflow supervisor immutable file set changed");
	for (const relativePath of expectedFiles) {
		const target = join(paths.runtimeRoot, relativePath);
		const metadata = lstatSync(target);
		if (
			!metadata.isFile() ||
			metadata.isSymbolicLink() ||
			sha256(readFileSync(target)) !== manifest.immutableFiles[relativePath]
		)
			throw new Error(
				`workflow supervisor immutable file changed: ${relativePath}`,
			);
	}
	if (
		digestWorkflowRuntimePackage(paths.agentToolkitPackageRoot) !==
		expected.agentToolkitDigest
	)
		throw new Error("workflow supervisor immutable toolkit changed");
	const identity = readAgentToolkitIdentity(paths.agentToolkitPackageRoot);
	if (identity.version !== expected.agentToolkitVersion)
		throw new Error("workflow supervisor immutable toolkit identity changed");
}

function materializeNewRuntime(
	paths: ReturnType<typeof runtimePaths>,
	runtimeNamespace: string,
	sourcePackageRoot: string,
	filteredAuth: Readonly<Record<string, WorkflowRuntimeJson>>,
	immutablePayloads: Readonly<Record<string, string>>,
	inputDigest: string,
	agentToolkitDigest: string,
	agentToolkitVersion: string,
	agentToolkitSourceRevision: string,
	authCredentialTypes: Readonly<Record<string, string>>,
	immutableApiKeyDigests: Readonly<Record<string, string>>,
	oauthSchemas: Readonly<Record<string, Record<string, string>>>,
): void {
	const scratchContainer = dirname(paths.runtimeRoot);
	mkdirPrivate(scratchContainer);
	const stagingRoot = join(
		scratchContainer,
		`.workflow-supervisor-stage-${process.pid}-${Date.now()}`,
	);
	const stagingPaths = runtimePaths(stagingRoot);
	try {
		for (const directory of [
			stagingPaths.runtimeRoot,
			stagingPaths.homeDir,
			join(stagingPaths.homeDir, ".config"),
			join(stagingPaths.homeDir, ".cache"),
			stagingPaths.tmpDir,
			stagingPaths.agentDir,
			stagingPaths.sessionDir,
			stagingPaths.binDir,
			dirname(stagingPaths.agentToolkitPackageRoot),
		])
			mkdirPrivate(directory);

		cpSync(sourcePackageRoot, stagingPaths.agentToolkitPackageRoot, {
			recursive: true,
			dereference: false,
			errorOnExist: true,
		});
		privatizePackageTree(stagingPaths.agentToolkitPackageRoot);
		if (
			digestWorkflowRuntimePackage(stagingPaths.agentToolkitPackageRoot) !==
			agentToolkitDigest
		)
			throw new Error(
				"copied agent-toolkit package failed digest verification",
			);

		for (const [relativePath, payload] of Object.entries(immutablePayloads))
			writePrivateFile(join(stagingRoot, relativePath), payload);
		if (process.platform !== "win32") {
			chmodSync(stagingPaths.piShimFile, 0o700);
			chmodSync(stagingPaths.gitShimFile, 0o700);
		}
		writePrivateFile(stagingPaths.workflowAuthFile, jsonFile(filteredAuth));

		const manifest: RuntimeManifest = {
			version: 1,
			runtimeNamespace,
			inputDigest,
			agentToolkitDigest,
			agentToolkitVersion,
			agentToolkitSourceRevision,
			immutableFiles: Object.fromEntries(
				Object.entries(immutablePayloads).map(([path, payload]) => [
					path,
					sha256(payload),
				]),
			),
			authCredentialTypes,
			immutableApiKeyDigests,
			oauthSchemas,
		};
		writePrivateFile(join(stagingRoot, MANIFEST_NAME), jsonFile(manifest));
		renameSync(stagingRoot, paths.runtimeRoot);
	} catch (error) {
		rmSync(stagingRoot, { recursive: true, force: true });
		throw error;
	}
}

function verifyExistingRuntime(
	paths: ReturnType<typeof runtimePaths>,
	runtimeNamespace: string,
	inputDigest: string,
	agentToolkitDigest: string,
	authCredentialTypes: Readonly<Record<string, string>>,
	immutablePayloads: Readonly<Record<string, string>>,
	immutableApiKeyDigests: Readonly<Record<string, string>>,
	oauthSchemas: Readonly<Record<string, Record<string, string>>>,
): void {
	const manifestPath = join(paths.runtimeRoot, MANIFEST_NAME);
	if (!existsSync(manifestPath))
		throw new Error("workflow supervisor runtime is partial or unsealed");
	const manifest = parseObjectFile(manifestPath) as Partial<RuntimeManifest>;
	if (
		manifest.version !== 1 ||
		manifest.runtimeNamespace !== runtimeNamespace ||
		manifest.inputDigest !== inputDigest ||
		manifest.agentToolkitDigest !== agentToolkitDigest
	)
		throw new Error("workflow supervisor runtime resume input does not match");
	if (!sameJson(manifest.authCredentialTypes, authCredentialTypes))
		throw new Error("workflow supervisor runtime auth declaration changed");
	if (!sameJson(manifest.immutableApiKeyDigests, immutableApiKeyDigests))
		throw new Error("workflow supervisor runtime API-key declaration changed");
	if (!sameJson(manifest.oauthSchemas, oauthSchemas))
		throw new Error("workflow supervisor runtime OAuth schema changed");
	const expectedImmutableFiles = Object.fromEntries(
		Object.entries(immutablePayloads).map(([path, payload]) => [
			path,
			sha256(payload),
		]),
	);
	if (!sameJson(manifest.immutableFiles, expectedImmutableFiles))
		throw new Error(
			"workflow supervisor runtime immutable declaration changed",
		);
	for (const [relativePath, digest] of Object.entries(expectedImmutableFiles)) {
		const target = join(paths.runtimeRoot, relativePath);
		if (!existsSync(target) || sha256(readFileSync(target)) !== digest)
			throw new Error(
				`workflow supervisor runtime immutable file changed: ${relativePath}`,
			);
	}
	if (
		digestWorkflowRuntimePackage(paths.agentToolkitPackageRoot) !==
		agentToolkitDigest
	)
		throw new Error("workflow supervisor runtime package changed");
	const resumedAuth = parseObjectFile(paths.workflowAuthFile);
	if (!sameJson(credentialTypes(resumedAuth), authCredentialTypes))
		throw new Error("workflow supervisor runtime auth providers changed");
	if (!sameJson(apiKeyDigests(resumedAuth), immutableApiKeyDigests))
		throw new Error("workflow supervisor runtime API-key credential changed");
	if (!sameJson(oauthCredentialSchemas(resumedAuth), oauthSchemas))
		throw new Error(
			"workflow supervisor runtime OAuth credential schema changed",
		);
	assertPrivateRuntimeModes(paths);
}

function runtimeResult(
	options: MaterializeWorkflowSupervisorRuntimeOptions,
	paths: ReturnType<typeof runtimePaths>,
	agentToolkitDigest: string,
	agentToolkitVersion: string,
	agentToolkitSourceRevision: string,
	materializationDigest: string,
): WorkflowSupervisorRuntimeMaterialization {
	const environment = filteredSourceEnvironment(options);
	Object.assign(environment, {
		PATH: `${paths.binDir}:${environment.PATH ?? ""}`,
		HOME: paths.homeDir,
		TMPDIR: paths.tmpDir,
		TMP: paths.tmpDir,
		TEMP: paths.tmpDir,
		XDG_CONFIG_HOME: join(paths.homeDir, ".config"),
		XDG_CACHE_HOME: join(paths.homeDir, ".cache"),
		PI_CODING_AGENT_DIR: paths.agentDir,
		PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
		PI_WORKFLOW_AUTH_FILE: paths.workflowAuthFile,
		GIT_CONFIG_GLOBAL: paths.gitConfigFile,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "Never",
		...WORKFLOW_CREDENTIAL_RESET_ENV,
	});
	return {
		...paths,
		agentToolkitDigest,
		agentToolkitVersion,
		agentToolkitSourceRevision,
		materializationDigest,
		environment,
		scratchRoots: [
			paths.homeDir,
			paths.tmpDir,
			paths.sessionDir,
			paths.workflowAuthFile,
		],
	};
}

function filteredSourceEnvironment(
	options: MaterializeWorkflowSupervisorRuntimeOptions,
): Record<string, string> {
	const environment = buildWorkflowChildEnvironment(
		options.sourceEnvironment,
		workflowChildEnvironmentPolicy(options.allowedEnvironmentKeys),
	);
	for (const key of Object.keys(environment)) {
		if (
			isWorkflowPublicationEnvironmentKey(key) ||
			key === "GIT_CONFIG_COUNT" ||
			INHERITED_GIT_CONFIG_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
		)
			delete environment[key];
	}
	return environment;
}

function runtimePaths(runtimeRoot: string) {
	const mutableRoot = join(runtimeRoot, "mutable");
	const immutableRoot = join(runtimeRoot, "immutable");
	const homeDir = join(mutableRoot, "home");
	const agentDir = join(immutableRoot, "pi-agent");
	const binDir = join(immutableRoot, "bin");
	return {
		runtimeRoot,
		homeDir,
		tmpDir: join(mutableRoot, "tmp"),
		agentDir,
		sessionDir: join(mutableRoot, "sessions"),
		workflowAuthFile: join(agentDir, "auth.json"),
		settingsFile: join(agentDir, "settings.json"),
		modelsFile: join(agentDir, "models.json"),
		gitConfigFile: join(immutableRoot, "gitconfig"),
		binDir,
		piShimFile: join(binDir, "pi"),
		gitShimFile: join(binDir, "git"),
		agentToolkitPackageRoot: join(agentDir, "packages", "agent-toolkit"),
	};
}

function filterAuth(
	source: Readonly<Record<string, WorkflowRuntimeJson>>,
	approvedProviderIds: readonly string[],
): Record<string, WorkflowRuntimeJson> {
	const filtered: Record<string, WorkflowRuntimeJson> = {};
	for (const providerId of approvedProviderIds) {
		const credential = source[providerId];
		if (credential !== undefined) filtered[providerId] = cloneJson(credential);
	}
	credentialTypes(filtered);
	return filtered;
}

function credentialTypes(
	auth: Readonly<Record<string, WorkflowRuntimeJson>>,
): Record<string, string> {
	const types: Record<string, string> = {};
	for (const [providerId, credential] of Object.entries(auth)) {
		if (
			typeof credential !== "object" ||
			credential === null ||
			Array.isArray(credential)
		)
			throw new Error(`invalid model credential for provider ${providerId}`);
		const record = credential as Record<string, WorkflowRuntimeJson>;
		if (record.type !== "api_key" && record.type !== "oauth")
			throw new Error(`invalid model credential for provider ${providerId}`);
		if (
			record.type === "api_key" &&
			(typeof record.key !== "string" || record.key.length === 0)
		)
			throw new Error(`invalid API-key credential for provider ${providerId}`);
		types[providerId] = record.type;
	}
	return types;
}

function apiKeyDigests(
	auth: Readonly<Record<string, WorkflowRuntimeJson>>,
): Record<string, string> {
	const digests: Record<string, string> = {};
	for (const [providerId, credential] of Object.entries(auth)) {
		const record = credential as Record<string, WorkflowRuntimeJson>;
		if (record.type === "api_key")
			digests[providerId] = sha256(canonicalJson(credential));
	}
	return digests;
}

function oauthCredentialSchemas(
	auth: Readonly<Record<string, WorkflowRuntimeJson>>,
): Record<string, Record<string, string>> {
	const schemas: Record<string, Record<string, string>> = {};
	for (const [providerId, credential] of Object.entries(auth)) {
		const record = credential as Record<string, WorkflowRuntimeJson>;
		if (record.type !== "oauth") continue;
		if (
			typeof record.access !== "string" ||
			typeof record.refresh !== "string" ||
			typeof record.expires !== "number" ||
			!Number.isFinite(record.expires)
		)
			throw new Error(`invalid OAuth credential for provider ${providerId}`);
		schemas[providerId] = Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, jsonShape(record[key])]),
		);
	}
	return schemas;
}

function jsonShape(value: WorkflowRuntimeJson | undefined): string {
	if (value === null) return "null";
	if (Array.isArray(value))
		return `array<${[...new Set(value.map(jsonShape))].sort().join("|")}>`;
	if (typeof value === "object") {
		const record = value as Record<string, WorkflowRuntimeJson>;
		return `object<{${Object.keys(record)
			.sort()
			.map((key) => `${key}:${jsonShape(record[key])}`)
			.join(",")}}>`;
	}
	return typeof value;
}

function filterModels(
	models: WorkflowRuntimeJson,
	approvedProviderIds: readonly string[],
): WorkflowRuntimeJson {
	if (typeof models !== "object" || models === null || Array.isArray(models))
		throw new Error("workflow runtime models must be an object");
	const root = models as Record<string, WorkflowRuntimeJson>;
	if (Object.keys(root).some((key) => key !== "providers"))
		throw new Error("workflow runtime models only supports providers");
	const providers = root.providers;
	if (
		typeof providers !== "object" ||
		providers === null ||
		Array.isArray(providers)
	)
		throw new Error("workflow runtime models requires a providers object");
	const sourceProviders = providers as Record<string, WorkflowRuntimeJson>;
	const selected: Record<string, WorkflowRuntimeJson> = {};
	for (const providerId of approvedProviderIds) {
		const provider = sourceProviders[providerId];
		if (provider === undefined) continue;
		if (
			typeof provider !== "object" ||
			provider === null ||
			Array.isArray(provider)
		)
			throw new Error(`invalid model configuration for provider ${providerId}`);
		assertCredentialBlindModelConfig(provider, providerId);
		selected[providerId] = cloneJson(provider);
	}
	return { providers: selected };
}

function assertCredentialBlindModelConfig(
	value: WorkflowRuntimeJson,
	providerId: string,
): void {
	if (Array.isArray(value)) {
		for (const item of value)
			assertCredentialBlindModelConfig(item, providerId);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value as Record<string, WorkflowRuntimeJson>;
	for (const [key, nested] of Object.entries(record)) {
		if (isCredentialFieldName(key))
			throw new Error(
				`model configuration for provider ${providerId} contains credential field ${key}`,
			);
		if (key.toLowerCase().endsWith("url") && typeof nested === "string") {
			const parsed = new URL(nested);
			const sensitiveQuery = [...parsed.searchParams.keys()].find((name) =>
				/(?:auth|credential|key|password|secret|token)/i.test(name),
			);
			if (parsed.username || parsed.password || sensitiveQuery)
				throw new Error(
					`model configuration for provider ${providerId} contains URL credentials`,
				);
		}
		assertCredentialBlindModelConfig(nested, providerId);
	}
}

function isCredentialFieldName(key: string): boolean {
	const tokens = key
		.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	const normalized = tokens.join("");
	return (
		tokens.some((token) =>
			/^(?:secret|token|password|credential|authorization|auth|header|headers|cookie|key)$/.test(
				token,
			),
		) ||
		/^(?:apikey|clientsecret|clientkey|privatekey|accesskey|authtoken|bearertoken)$/.test(
			normalized,
		) ||
		normalized === "access" ||
		normalized === "refresh" ||
		normalized === "env"
	);
}

function normalizedProviderIds(providerIds: readonly string[]): string[] {
	const normalized = providerIds.map((providerId) => providerId.trim());
	if (normalized.some((providerId) => providerId.length === 0))
		throw new Error("approved provider ids must be non-empty");
	return [...new Set(normalized)].sort();
}

function assertPackageShape(packageRoot: string): void {
	const packageFile = join(packageRoot, "package.json");
	if (!existsSync(packageFile))
		throw new Error("agent-toolkit snapshot requires package.json");
	const packageJson = parseObjectFile(packageFile);
	if (packageJson.name !== "@vegardx/agent-toolkit")
		throw new Error(
			"agent-toolkit package identity must be @vegardx/agent-toolkit",
		);
	if (typeof packageJson.version !== "string" || !packageJson.version.trim())
		throw new Error("agent-toolkit package requires a version");
	if (!existsSync(join(packageRoot, "skills")))
		throw new Error("agent-toolkit package requires a skills directory");
}

function readAgentToolkitIdentity(packageRoot: string): { version: string } {
	const packageJson = parseObjectFile(join(packageRoot, "package.json"));
	if (
		packageJson.name !== "@vegardx/agent-toolkit" ||
		typeof packageJson.version !== "string"
	)
		throw new Error("invalid agent-toolkit package identity");
	return { version: packageJson.version };
}

function packageEntries(root: string): Array<{
	kind: "directory" | "file";
	relativePath: string;
	absolutePath: string;
}> {
	const entries: Array<{
		kind: "directory" | "file";
		relativePath: string;
		absolutePath: string;
	}> = [];
	const visit = (directory: string): void => {
		for (const name of readdirSync(directory).sort()) {
			const absolutePath = join(directory, name);
			const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
			const stats = lstatSync(absolutePath);
			if (stats.isSymbolicLink())
				throw new Error(
					`agent-toolkit package cannot contain symlink: ${relativePath}`,
				);
			if (stats.isDirectory()) {
				entries.push({ kind: "directory", relativePath, absolutePath });
				visit(absolutePath);
			} else if (stats.isFile()) {
				entries.push({ kind: "file", relativePath, absolutePath });
			} else {
				throw new Error(
					`agent-toolkit package contains unsupported entry: ${relativePath}`,
				);
			}
		}
	};
	visit(root);
	return entries;
}

function privatizePackageTree(root: string): void {
	for (const entry of packageEntries(root)) {
		if (process.platform === "win32") continue;
		if (entry.kind === "directory") chmodSync(entry.absolutePath, 0o700);
		else {
			const executable = statSync(entry.absolutePath).mode & 0o111;
			chmodSync(entry.absolutePath, executable ? 0o700 : 0o600);
		}
	}
	if (process.platform !== "win32") chmodSync(root, 0o700);
}

function assertPrivateRuntimeModes(
	paths: ReturnType<typeof runtimePaths>,
): void {
	if (process.platform === "win32") return;
	for (const directory of [
		paths.runtimeRoot,
		paths.homeDir,
		join(paths.homeDir, ".config"),
		join(paths.homeDir, ".cache"),
		paths.tmpDir,
		paths.agentDir,
		paths.sessionDir,
		paths.binDir,
		dirname(paths.agentToolkitPackageRoot),
		paths.agentToolkitPackageRoot,
	]) {
		if ((statSync(directory).mode & 0o777) !== 0o700)
			throw new Error(
				`workflow supervisor runtime directory is not private: ${directory}`,
			);
	}
	for (const file of [
		paths.workflowAuthFile,
		paths.settingsFile,
		paths.modelsFile,
		paths.gitConfigFile,
		join(paths.runtimeRoot, MANIFEST_NAME),
	]) {
		if ((statSync(file).mode & 0o777) !== 0o600)
			throw new Error(
				`workflow supervisor runtime file is not private: ${file}`,
			);
	}
	if ((statSync(paths.piShimFile).mode & 0o777) !== 0o700)
		throw new Error(
			"workflow supervisor Pi shim is not private and executable",
		);
	if ((statSync(paths.gitShimFile).mode & 0o777) !== 0o700)
		throw new Error(
			"workflow supervisor Git shim is not private and executable",
		);
	for (const entry of packageEntries(paths.agentToolkitPackageRoot)) {
		const mode = statSync(entry.absolutePath).mode & 0o777;
		if (entry.kind === "directory" && mode !== 0o700)
			throw new Error(
				`workflow supervisor runtime package directory is not private: ${entry.relativePath}`,
			);
		if (entry.kind === "file" && mode !== 0o600 && mode !== 0o700)
			throw new Error(
				`workflow supervisor runtime package file is not private: ${entry.relativePath}`,
			);
	}
}

function mkdirPrivate(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") chmodSync(path, 0o700);
}

function writePrivateFile(path: string, payload: string): void {
	mkdirPrivate(dirname(path));
	writeFileSync(path, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
	if (process.platform !== "win32") chmodSync(path, 0o600);
}

function credentialFreeGitConfig(): string {
	return "[credential]\n\thelper =\n\tinteractive = false\n";
}

function resolvePiExecutable(
	explicit: string | undefined,
	path: string | undefined,
): string {
	return resolveRuntimeExecutable("pi", explicit, path);
}

function resolveRuntimeExecutable(
	name: string,
	explicit: string | undefined,
	path: string | undefined,
): string {
	const candidates = explicit
		? [explicit]
		: (path ?? "")
				.split(process.platform === "win32" ? ";" : ":")
				.filter(Boolean)
				.map((directory) =>
					join(directory, process.platform === "win32" ? `${name}.cmd` : name),
				);
	for (const candidate of candidates) {
		try {
			const resolved = realpathSync(candidate);
			if (!statSync(resolved).isFile()) continue;
			accessSync(resolved, constants.X_OK);
			return resolved;
		} catch {
			// Continue to the next explicitly bounded PATH candidate.
		}
	}
	throw new Error(
		`workflow supervisor runtime cannot resolve the real ${name} executable`,
	);
}

function piShim(piExecutable: string): string {
	return `#!/bin/sh\nexec ${shellLiteral(piExecutable)} "$@" --no-approve\n`;
}

/**
 * Protect against an agent accidentally publishing with credentials embedded
 * in a repository URL. GIT_ALLOW_PROTOCOL denies every transport even when a
 * configured alias reaches push; this PATH guard also gives a useful error.
 * The outer sandbox cannot distinguish model API traffic from Git network
 * traffic. These are accident boundaries, not a
 * hostile-process claim: deliberate invocation of the underlying absolute Git
 * path remains outside the stated threat model.
 */
function gitShim(gitExecutable: string): string {
	return `#!/bin/sh
for arg in "$@"; do
	case "$arg" in
		push|send-pack|receive-pack|credential|credential-store|credential-cache)
			echo "maestro workflow: remote Git and credential operations are reserved for the seat" >&2
			exit 126
			;;
	esac
done
exec ${shellLiteral(gitExecutable)} "$@"
`;
}

function shellLiteral(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseObjectFile(path: string): Record<string, WorkflowRuntimeJson> {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`expected JSON object in ${path}`);
	return parsed as Record<string, WorkflowRuntimeJson>;
}

function jsonFile(value: unknown): string {
	return `${canonicalJson(value)}\n`;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function cloneJson<T extends WorkflowRuntimeJson>(value: T): T {
	return JSON.parse(canonicalJson(value)) as T;
}

function sameJson(left: unknown, right: unknown): boolean {
	try {
		return canonicalJson(left) === canonicalJson(right);
	} catch {
		return false;
	}
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("runtime JSON requires finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
			.join(",")}}`;
	}
	throw new Error("runtime value must be JSON");
}

function validatedRoot(input: string, label: string): string {
	if (!isAbsolute(input)) throw new Error(`${label} root must be absolute`);
	let cursor = resolve(input);
	const missing: string[] = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		missing.unshift(basename(cursor));
		cursor = parent;
	}
	const normalized = resolve(realpathSync(cursor), ...missing);
	if (normalized === parse(normalized).root)
		throw new Error(`${label} root must not be the filesystem root`);
	return normalized;
}
