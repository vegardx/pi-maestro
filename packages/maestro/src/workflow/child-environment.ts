import { AGENT_ID_ENV, DEPTH_ENV, SOCK_ENV, TOKEN_ENV } from "../depth.js";

/**
 * Process settings a workflow child may need before provider-specific
 * credentials are considered. This is an allowlist, not a list of values to
 * synthesize: keys absent from the source environment remain absent.
 */
export const WORKFLOW_CHILD_RUNTIME_ENV_KEYS = [
	"PATH",
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
] as const;

/** Existing maestro process identity declarations are the authority here. */
export const WORKFLOW_CHILD_IDENTITY_ENV_KEYS = [
	SOCK_ENV,
	TOKEN_ENV,
	AGENT_ID_ENV,
	DEPTH_ENV,
] as const;

/**
 * Control state inherited from a previous workflow process must not choose the
 * next process role. pi-workflow 0.11.0 does not publicly export this name, so
 * keep the pinned-package protocol reference beside the single declaration.
 */
export const WORKFLOW_CHILD_STALE_CONTROL_ENV_KEYS = [
	"PI_WORKFLOW_ROLE",
] as const;

/**
 * Prefixes whose values override repository-scoped Git identity. Matching the
 * family, rather than today's NAME/EMAIL/DATE members, also blocks future Git
 * author or committer overrides without growing a second list.
 */
export const WORKFLOW_CHILD_BLOCKED_ENV_PREFIXES = [
	"GIT_AUTHOR_",
	"GIT_COMMITTER_",
] as const;

const WORKFLOW_CHILD_BLOCKED_EXACT_ENV_KEYS = new Set<string>([
	...WORKFLOW_CHILD_IDENTITY_ENV_KEYS,
	...WORKFLOW_CHILD_STALE_CONTROL_ENV_KEYS,
]);

export interface WorkflowChildEnvironmentPolicy {
	readonly allowedKeys: readonly string[];
}

/**
 * Declare the complete environment contract for one workflow child.
 *
 * Provider and extension credentials/configuration vary by installed Pi
 * package, so their keys must be supplied by the selected launch profile. They
 * are deliberately not inferred from suffixes such as `_TOKEN` or `_API_KEY`.
 */
export function workflowChildEnvironmentPolicy(
	requiredKeys: readonly string[] = [],
): WorkflowChildEnvironmentPolicy {
	return {
		allowedKeys: [
			...new Set([...WORKFLOW_CHILD_RUNTIME_ENV_KEYS, ...requiredKeys]),
		],
	};
}

function isBlocked(key: string): boolean {
	return (
		WORKFLOW_CHILD_BLOCKED_EXACT_ENV_KEYS.has(key) ||
		WORKFLOW_CHILD_BLOCKED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
	);
}

/**
 * Build a replacement environment for a workflow child from an explicit
 * policy. Undefined values are omitted, as required by Node's spawn API.
 *
 * Integration boundary: `@agwab/pi-subagent@0.4.8` merges its launch env over
 * `process.env`. Passing this object as that merge overlay would reintroduce
 * every omitted value. Until subagent offers replacement-env semantics, use
 * this at a wrapper/process boundary whose `spawn` receives it as the complete
 * `env`, then start the workflow runtime inside that clean process.
 */
export function buildWorkflowChildEnvironment(
	source: Readonly<NodeJS.ProcessEnv>,
	policy: WorkflowChildEnvironmentPolicy,
): Record<string, string> {
	const environment: Record<string, string> = {};

	for (const key of policy.allowedKeys) {
		if (isBlocked(key)) continue;
		const value = source[key];
		if (value !== undefined) environment[key] = value;
	}

	return environment;
}
