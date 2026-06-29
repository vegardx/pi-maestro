// Map a SpawnProfile to a concrete child invocation. This is the heart of the
// "don't make env the interface" rule:
//
//   * pi-native config (model / tools / thinking / mode / session /
//     append-system-prompt / cwd) → RpcClient args + fields. pi consumes
//     these at startup.
//   * our extension enablement + feature kills → env ONLY (PI_EXT_<NAME>,
//     PI_DISABLE / PI_ENABLE). Our defineExtension gate runs at load time,
//     before any RPC or flag registration, so env is the only channel with no
//     load-order dependency.
//
// The env is computed EXPLICITLY per spawn from the resolved profile — never
// read from process.env — so a kill switch propagates to a child (and to its
// children) only by deliberate profile decision, never by accidental
// inheritance. The depth counter rides the same env channel.

import type { SpawnProfile } from "@vegardx/pi-contracts";
import { resolveProfile } from "./profiles.js";

/** Env var carrying the current nesting depth (parent's depth + 1). */
export const DEPTH_ENV = "PI_MAESTRO_DEPTH";

export interface SpawnContext {
	/** cwd of the spawning agent (used when the profile names none). */
	readonly spawnerCwd?: string;
	/** Repo root — the final cwd fallback. */
	readonly repoRoot: string;
	/** Nesting depth of the spawner (0 for the top-level agent). */
	readonly parentDepth: number;
}

export interface ChildInvocation {
	readonly cwd: string;
	readonly model?: string;
	/** Extra CLI args for the RpcClient (pi-native config). */
	readonly args: string[];
	/** Maestro flag env, computed explicitly — merged onto a curated base by
	 *  the runner, never sourced from the parent's process.env. */
	readonly env: Record<string, string>;
	/** Resolved nesting depth of the child. */
	readonly depth: number;
}

function envVarFor(extension: string): string {
	return `PI_EXT_${extension.replace(/-/g, "_").toUpperCase()}`;
}

export function mapProfileToInvocation(
	profile: SpawnProfile,
	ctx: SpawnContext,
): ChildInvocation {
	const resolved = resolveProfile(profile);
	const cwd = resolved.cwd ?? ctx.spawnerCwd ?? ctx.repoRoot;
	const depth = ctx.parentDepth + 1;

	const args: string[] = [];
	if (resolved.tools?.allow?.length) {
		args.push("--tools", resolved.tools.allow.join(","));
	}
	if (resolved.thinking) args.push("--thinking", resolved.thinking);
	if (resolved.mode) args.push("--mode", resolved.mode);
	if (resolved.session === false) args.push("--no-session");
	if (resolved.appendSystemPrompt) {
		args.push("--append-system-prompt", resolved.appendSystemPrompt);
	}

	const env: Record<string, string> = { [DEPTH_ENV]: String(depth) };
	for (const ext of resolved.disableExtensions) env[envVarFor(ext)] = "off";
	if (resolved.sessionDir) {
		env.PI_CODING_AGENT_SESSION_DIR = resolved.sessionDir;
	}
	// Always set both kill-switch vars explicitly so a parent's PI_DISABLE /
	// PI_ENABLE cannot leak through — an empty value means "no opinion".
	env.PI_DISABLE = (resolved.featureFlags?.disable ?? []).join(",");
	env.PI_ENABLE = (resolved.featureFlags?.enable ?? []).join(",");

	return { cwd, model: resolved.model, args, env, depth };
}

/** Read the spawner's own nesting depth from its environment. */
export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[DEPTH_ENV];
	const n = raw ? Number.parseInt(raw, 10) : 0;
	return Number.isFinite(n) && n >= 0 ? n : 0;
}
