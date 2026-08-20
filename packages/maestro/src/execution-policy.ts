// The interactive seat's bash classification and confirmation policy.
//
// Pi-maestro has no execution backend or OS sandbox. These settings only decide
// whether a classified host command is allowed, confirmed, or refused.

import { readLayeredExtensionConfig, readPath } from "@vegardx/pi-settings";

export type ExecutionPolicyPreset = "guided" | "strict" | "permissive";

// There is no `isolation` tier here. The policy classifies and explains shell
// effects; auto and hack deliberately provide no OS write boundary. A preset is
// stricter by classifying more strictly, never by naming an execution backend.

export interface ExecutionPolicySettings {
	preset: ExecutionPolicyPreset | "custom";
	toolGuidance: "mode-aware" | "advisory" | "off";
	modeRoutes: "protected-research" | "direct";
	consequential: "confirm" | "confirm-mutations" | "allow";
	privilegedRemote: "hack-only" | "confirm" | "deny";
	githubReads: "allow-apparent-reads" | "confirm";
	/** `allow` runs it on the host. */
	unknowns: "allow" | "confirm" | "deny";
}

const POLICY_PRESETS: Record<
	ExecutionPolicyPreset,
	Omit<ExecutionPolicySettings, "preset">
> = {
	guided: {
		toolGuidance: "mode-aware",
		modeRoutes: "protected-research",
		consequential: "confirm",
		privilegedRemote: "hack-only",
		githubReads: "allow-apparent-reads",
		unknowns: "allow",
	},
	strict: {
		toolGuidance: "mode-aware",
		modeRoutes: "protected-research",
		consequential: "confirm-mutations",
		privilegedRemote: "confirm",
		githubReads: "confirm",
		unknowns: "deny",
	},
	permissive: {
		toolGuidance: "advisory",
		modeRoutes: "direct",
		consequential: "allow",
		privilegedRemote: "hack-only",
		githubReads: "allow-apparent-reads",
		unknowns: "confirm",
	},
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

/** Validated layered policy. Invalid values fall back to the selected preset. */
/**
 * A named preset as settings.
 *
 * The presets existed and nothing could reach them: every caller had to go
 * through `readExecutionPolicySettings`, which needs a working directory and
 * real settings on disk. Anything wanting "the guided defaults" — a test, a
 * seat with no configuration yet — had no way to say so.
 */
export function executionPolicyPreset(
	preset: ExecutionPolicyPreset,
): ExecutionPolicySettings {
	return { preset, ...POLICY_PRESETS[preset] };
}

export function readExecutionPolicySettings(
	cwd: string,
	agentDir?: string,
): ExecutionPolicySettings {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const config = merged.maestro;
	const preset = choice(
		readPath(config, "execution.preset"),
		["guided", "strict", "permissive"] as const,
		"guided",
	);
	const defaults = POLICY_PRESETS[preset];
	const read = <T extends string>(
		key: string,
		allowed: readonly T[],
		fallback: T,
	) => choice(readPath(config, `execution.${key}`), allowed, fallback);
	const resolved = {
		toolGuidance: read(
			"toolGuidance",
			["mode-aware", "advisory", "off"],
			defaults.toolGuidance,
		),
		modeRoutes: read(
			"modeRoutes",
			["protected-research", "direct"],
			defaults.modeRoutes,
		),
		consequential: read(
			"consequential",
			["confirm", "confirm-mutations", "allow"],
			defaults.consequential,
		),
		privilegedRemote: read(
			"privilegedRemote",
			["hack-only", "confirm", "deny"],
			defaults.privilegedRemote,
		),
		githubReads: read(
			"githubReads",
			["allow-apparent-reads", "confirm"],
			defaults.githubReads,
		),
		unknowns: read("unknowns", ["allow", "confirm", "deny"], defaults.unknowns),
	};
	const custom = Object.keys(resolved).some((key) => {
		const raw = readPath(config, `execution.${key}`);
		return raw !== undefined && raw === resolved[key as keyof typeof resolved];
	});
	return { preset: custom ? "custom" : preset, ...resolved };
}

/**
 * How the effective execution policy differs from the shipped default (the
 * `guided` preset), key by key. Empty means the default is in force.
 */
export function describePolicyDeviations(
	cwd: string,
	agentDir?: string,
): string[] {
	const effective = readExecutionPolicySettings(cwd, agentDir);
	const base = POLICY_PRESETS.guided;
	const out: string[] = [];
	for (const key of Object.keys(base) as (keyof typeof base)[]) {
		if (effective[key] !== base[key])
			out.push(`${key}: ${effective[key]} (default ${base[key]})`);
	}
	return out;
}
