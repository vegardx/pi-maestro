import { describe, expect, it } from "vitest";
import {
	buildWorkflowChildEnvironment,
	WORKFLOW_CHILD_BLOCKED_ENV_PREFIXES,
	WORKFLOW_CHILD_IDENTITY_ENV_KEYS,
	WORKFLOW_CHILD_STALE_CONTROL_ENV_KEYS,
	workflowChildEnvironmentPolicy,
} from "../../../packages/maestro/src/workflow/child-environment.js";

const REQUIRED_PROVIDER_AND_EXTENSION_KEYS = [
	"ANTHROPIC_API_KEY",
	"OPENAI_BASE_URL",
	"EXA_API_KEY",
] as const;

describe("workflow child environment", () => {
	it("keeps only declared runtime, provider, and extension settings", () => {
		const policy = workflowChildEnvironmentPolicy(
			REQUIRED_PROVIDER_AND_EXTENSION_KEYS,
		);
		const source: NodeJS.ProcessEnv = {
			PATH: "/tools/bin",
			HOME: "/home/developer",
			PI_CODING_AGENT_DIR: "/config/pi-agent",
			ANTHROPIC_API_KEY: "anthropic-secret",
			OPENAI_BASE_URL: "https://provider.example/v1",
			EXA_API_KEY: "exa-secret",
			UNRELATED_PARENT_STATE: "must-not-leak",
		};

		const environment = buildWorkflowChildEnvironment(source, policy);

		const expectedKeys = policy.allowedKeys.filter(
			(key) => source[key] !== undefined,
		);
		expect(Object.keys(environment).sort()).toEqual([...expectedKeys].sort());
		expect(environment).toMatchObject({
			PATH: source.PATH,
			HOME: source.HOME,
			PI_CODING_AGENT_DIR: source.PI_CODING_AGENT_DIR,
			ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY,
			OPENAI_BASE_URL: source.OPENAI_BASE_URL,
			EXA_API_KEY: source.EXA_API_KEY,
		});
		expect(environment.UNRELATED_PARENT_STATE).toBeUndefined();
	});

	it("cannot leak stale maestro or Git identity even when requested", () => {
		const gitIdentityKeys = WORKFLOW_CHILD_BLOCKED_ENV_PREFIXES.flatMap(
			(prefix) => [`${prefix}NAME`, `${prefix}EMAIL`, `${prefix}DATE`],
		);
		const blockedKeys = [
			...WORKFLOW_CHILD_IDENTITY_ENV_KEYS,
			...WORKFLOW_CHILD_STALE_CONTROL_ENV_KEYS,
			...gitIdentityKeys,
		];
		const source = Object.fromEntries(
			blockedKeys.map((key) => [key, `stale:${key}`]),
		);
		const policy = workflowChildEnvironmentPolicy([
			...blockedKeys,
			...REQUIRED_PROVIDER_AND_EXTENSION_KEYS,
		]);

		const environment = buildWorkflowChildEnvironment(source, policy);

		for (const key of blockedKeys) expect(environment[key]).toBeUndefined();
		expect(environment).toEqual({});
	});

	it("enforces fixed deny rules for a caller-constructed policy", () => {
		const tokenKey = WORKFLOW_CHILD_IDENTITY_ENV_KEYS[1];
		const environment = buildWorkflowChildEnvironment(
			{
				[tokenKey]: "stale-token",
				GIT_AUTHOR_NAME: "Stale Author",
			},
			{
				allowedKeys: [tokenKey, "GIT_AUTHOR_NAME"],
			},
		);

		expect(environment).toEqual({});
	});

	it("does not mutate the parent environment and ignores absent values", () => {
		const source: NodeJS.ProcessEnv = {
			PATH: "/tools/bin",
			ANTHROPIC_API_KEY: undefined,
		};
		const before = { ...source };
		const policy = workflowChildEnvironmentPolicy([
			...REQUIRED_PROVIDER_AND_EXTENSION_KEYS,
		]);

		expect(buildWorkflowChildEnvironment(source, policy)).toEqual({
			PATH: "/tools/bin",
		});
		expect(source).toEqual(before);
	});
});
