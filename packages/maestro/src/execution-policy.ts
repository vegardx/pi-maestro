// The execution policy: how much the harness confirms, isolates, or refuses.
//
// This is the FIRST thing to land in packages/maestro, and only because of
// where it sits in the dependency graph: both `isolation/*` and the whole bash
// engine import `ExecutionPolicySettings`, so while it lived inside
// packages/modes nothing else could move out. Splitting it unblocks ~3.5k lines.
//
// NOTE ON THE SETTINGS NAMESPACE: these knobs are still read from
// `extensionConfig.modes.execution.*`. The reading code moved; the key did not,
// because `modes` is still the registered extension and still declares and
// writes them. The namespace follows the manifest at the cutover, not before —
// changing it now would orphan every existing setting mid-migration.

import { readLayeredExtensionConfig, readPath } from "@vegardx/pi-settings";

export type ExecutionPolicyPreset = "guided" | "strict" | "permissive";
export type IsolationTier = "lightweight" | "strong" | "none";

export interface ExecutionPolicySettings {
	preset: ExecutionPolicyPreset | "custom";
	toolGuidance: "mode-aware" | "advisory" | "off";
	modeRoutes: "protected-research" | "direct";
	isolation: IsolationTier;
	delivery: "dedicated-tools";
	consequential: "confirm" | "confirm-mutations" | "allow";
	privilegedRemote: "hack-only" | "confirm" | "deny";
	githubReads: "allow-apparent-reads" | "confirm";
	unknowns: "isolate" | "confirm" | "deny";
	fallback: "fail-closed" | "confirm";
}

const POLICY_PRESETS: Record<
	ExecutionPolicyPreset,
	Omit<ExecutionPolicySettings, "preset">
> = {
	guided: {
		toolGuidance: "mode-aware",
		modeRoutes: "protected-research",
		isolation: "lightweight",
		delivery: "dedicated-tools",
		consequential: "confirm",
		privilegedRemote: "hack-only",
		githubReads: "allow-apparent-reads",
		unknowns: "isolate",
		fallback: "fail-closed",
	},
	strict: {
		toolGuidance: "mode-aware",
		modeRoutes: "protected-research",
		isolation: "strong",
		delivery: "dedicated-tools",
		consequential: "confirm-mutations",
		privilegedRemote: "confirm",
		githubReads: "confirm",
		unknowns: "deny",
		fallback: "fail-closed",
	},
	permissive: {
		toolGuidance: "advisory",
		modeRoutes: "direct",
		isolation: "none",
		delivery: "dedicated-tools",
		consequential: "allow",
		privilegedRemote: "hack-only",
		githubReads: "allow-apparent-reads",
		unknowns: "confirm",
		fallback: "confirm",
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
export function readExecutionPolicySettings(
	cwd: string,
	agentDir?: string,
): ExecutionPolicySettings {
	const { merged } = readLayeredExtensionConfig(cwd, agentDir);
	const config = merged.modes;
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
		isolation: read(
			"isolation",
			["lightweight", "strong", "none"],
			defaults.isolation,
		),
		delivery: read("delivery", ["dedicated-tools"], defaults.delivery),
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
		unknowns: read(
			"unknowns",
			["isolate", "confirm", "deny"],
			defaults.unknowns,
		),
		fallback: read("fallback", ["fail-closed", "confirm"], defaults.fallback),
	};
	const custom = Object.keys(resolved).some((key) => {
		const raw = readPath(config, `execution.${key}`);
		return raw !== undefined && raw === resolved[key as keyof typeof resolved];
	});
	return { preset: custom ? "custom" : preset, ...resolved };
}

/**
 * How the EFFECTIVE execution policy differs from the shipped default (the
 * `guided` preset), key by key, plus whether write-enforcement is disabled via
 * MAESTRO_SANDBOX. Empty = the default is in force. Surfaced at session start so
 * a loosened policy is visible every session instead of silently permanent.
 */
export function describePolicyDeviations(
	cwd: string,
	agentDir?: string,
): string[] {
	const effective = readExecutionPolicySettings(cwd, agentDir);
	const base = POLICY_PRESETS.guided;
	const out: string[] = [];
	if (process.env.MAESTRO_SANDBOX === "off")
		out.push("sandbox: OFF — bash write-enforcement is disabled");
	for (const key of Object.keys(base) as (keyof typeof base)[]) {
		if (effective[key] !== base[key])
			out.push(`${key}: ${effective[key]} (default ${base[key]})`);
	}
	return out;
}
