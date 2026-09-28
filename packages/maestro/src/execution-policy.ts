import {
	type ExtensionConfig,
	readLayeredExtensionConfig,
	readPath,
} from "@vegardx/pi-settings";
import {
	BASH_ACTIONS,
	BASH_EFFECTS,
	type BashAction,
	type BashModePolicies,
	type BashPolicyKey,
	type ModeBashPolicy,
} from "./bash-contracts.js";
import { MODE_NAMES, type ModeName } from "./mode.js";

export interface BashAuditorSettings {
	readonly enabled: boolean;
	readonly tier: "light" | "standard" | "heavy";
	readonly model?: string;
	readonly timeoutMs: number;
	readonly maxTokens: number;
}

export interface ExecutionPolicySettings {
	readonly auditor: BashAuditorSettings;
	readonly exactToolEquivalent: "redirect" | "advisory" | "off";
	readonly modes: BashModePolicies;
}

const PLAN: ModeBashPolicy = {
	"filesystem-read": "allow",
	"workspace-write": "refuse",
	"host-write": "refuse",
	"remote-read": "allow",
	"remote-write": "refuse",
	"code-execution": "refuse",
	privileged: "refuse",
	destructive: "refuse",
	uncertain: "refuse",
};

/**
 * `ask` and `auto` share one table, bound to the same constant.
 *
 * They are the same permissions — the two modes differ only in what happens
 * when a plan run ends — so two tables here would be two places to change and
 * one of them would be forgotten. `DEFAULT_BASH_POLICIES` names both.
 */
const WRITE_GUARDED: ModeBashPolicy = {
	"filesystem-read": "allow",
	"workspace-write": "allow",
	"host-write": "confirm",
	"remote-read": "allow",
	"remote-write": "confirm",
	"code-execution": "allow",
	privileged: "confirm",
	destructive: "confirm",
	uncertain: "confirm",
};

const HACK: ModeBashPolicy = {
	"filesystem-read": "allow",
	"workspace-write": "allow",
	"host-write": "allow",
	"remote-read": "allow",
	"remote-write": "allow",
	"code-execution": "allow",
	privileged: "confirm",
	destructive: "confirm",
	uncertain: "allow",
};

export const DEFAULT_BASH_POLICIES: BashModePolicies = {
	plan: PLAN,
	ask: WRITE_GUARDED,
	auto: WRITE_GUARDED,
	hack: HACK,
};

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicySettings = {
	auditor: {
		enabled: true,
		tier: "light",
		timeoutMs: 120_000,
		maxTokens: 50_000,
	},
	exactToolEquivalent: "redirect",
	modes: DEFAULT_BASH_POLICIES,
};

function choice<T extends string>(
	raw: unknown,
	allowed: readonly T[],
	fallback: T,
): T {
	return typeof raw === "string" && allowed.includes(raw as T)
		? (raw as T)
		: fallback;
}

function boundedNumber(
	raw: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	return typeof raw === "number" && Number.isFinite(raw)
		? Math.min(maximum, Math.max(minimum, Math.floor(raw)))
		: fallback;
}

function readModePolicy(
	config: ExtensionConfig | undefined,
	mode: ModeName,
	defaults: ModeBashPolicy,
): ModeBashPolicy {
	const out = { ...defaults } as Record<BashPolicyKey, BashAction>;
	for (const key of [...BASH_EFFECTS, "uncertain"] as const) {
		out[key] = choice(
			readPath(config, `bash.policy.${mode}.${key}`),
			BASH_ACTIONS,
			defaults[key],
		);
	}
	return out;
}

export function readExecutionPolicySettings(
	cwd: string,
	agentDir?: string,
): ExecutionPolicySettings {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const config = merged.maestro as ExtensionConfig | undefined;
	const model = readPath(config, "bash.auditor.model");
	return {
		auditor: {
			enabled: readPath(config, "bash.auditor.enabled") !== false,
			tier: choice(
				readPath(config, "bash.auditor.tier"),
				["light", "standard", "heavy"] as const,
				DEFAULT_EXECUTION_POLICY.auditor.tier,
			),
			...(typeof model === "string" && model.includes("/") ? { model } : {}),
			timeoutMs: boundedNumber(
				readPath(config, "bash.auditor.timeoutMs"),
				DEFAULT_EXECUTION_POLICY.auditor.timeoutMs,
				1_000,
				300_000,
			),
			maxTokens: boundedNumber(
				readPath(config, "bash.auditor.maxTokens"),
				DEFAULT_EXECUTION_POLICY.auditor.maxTokens,
				1_000,
				100_000,
			),
		},
		exactToolEquivalent: choice(
			readPath(config, "bash.guidance.exactToolEquivalent"),
			["redirect", "advisory", "off"] as const,
			DEFAULT_EXECUTION_POLICY.exactToolEquivalent,
		),
		// Derived from `MODE_NAMES` rather than written out, so a mode cannot be
		// added to the table without becoming configurable here as well.
		modes: Object.fromEntries(
			MODE_NAMES.map((name) => [
				name,
				readModePolicy(config, name, DEFAULT_BASH_POLICIES[name]),
			]),
		) as BashModePolicies,
	};
}

export function describePolicyDeviations(
	cwd: string,
	agentDir?: string,
): string[] {
	const effective = readExecutionPolicySettings(cwd, agentDir);
	const out: string[] = [];
	for (const mode of MODE_NAMES) {
		for (const key of [...BASH_EFFECTS, "uncertain"] as const) {
			if (effective.modes[mode][key] !== DEFAULT_BASH_POLICIES[mode][key])
				out.push(
					`${mode}.${key}: ${effective.modes[mode][key]} (default ${DEFAULT_BASH_POLICIES[mode][key]})`,
				);
		}
	}
	return out;
}
