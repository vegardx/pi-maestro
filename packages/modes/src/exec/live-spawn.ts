// Live spawn wiring (v2): the production spawnAgent the runtime injects into
// createExecution. Ports the v1 execution-adapter spawn closure verbatim onto
// the node seam: session naming, persona seed head, session-file assembly
// (knowledge fork), commit-policy/install notes, post-freeze research refs,
// crash capture, stale-session reaping, and the real tmux launch. Model and
// effort arrive ALREADY RESOLVED on SpawnNodeOpts (the adapter's resolveModel
// seam records the NodeResolution before spawn) — this module only decides
// whether to pass --model (cache-warm omission when it matches the session).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PersonasCapabilityV1 } from "@vegardx/pi-contracts";
import { missingIdentityMessage, resolveGitIdentity } from "@vegardx/pi-git";
import { type BashActor, renderBashRuleset } from "../bash-policy.js";
import { AGENT_OPERATIONS_BRIEF } from "../plan/agent-operations.js";
import type { PlanEngineV2 } from "../plan/engine.js";
import type { NodeExecutorDeps, SpawnNodeOpts } from "../plan/node-executor.js";
import { personaSeedHead } from "../plan/node-periphery.js";
import {
	findNodeV2,
	isBranchOwner,
	planFingerprintV2,
} from "../plan/schema.js";
import { reportsNotInText, researchReportsDir } from "../research.js";
import {
	commitPolicyInstruction,
	detectCommitPolicy,
} from "./commit-policy.js";
import {
	buildAgentSessionFile,
	buildSpawnSpec,
	defaultAgentDir,
} from "./provisioner.js";

/** The tmux surface live spawning needs (realTmux satisfies it). */
export interface LiveSpawnTmux {
	spawn(
		name: string,
		cwd: string,
		command: string | string[],
		opts?: {
			width?: number;
			height?: number;
			env?: Record<string, string>;
		},
	): Promise<void>;
	hasSession(name: string): Promise<boolean>;
	kill(name: string): Promise<void>;
}

export interface LiveSpawnWiring {
	readonly engine: PlanEngineV2;
	readonly ctx: ExtensionContext;
	readonly tmux: LiveSpawnTmux;
	/** Launch transport: `headless` (detached child process) or `tmux`
	 *  (default). Governs whether buildSpawnSpec emits the tmux crash wrapper. */
	readonly transport?: "tmux" | "headless";
	readonly planDir: string;
	/** Repeated `-e` extension paths for the child pi. */
	readonly extensionPaths: readonly string[];
	/** RPC socket + run token — must match the adapter's own. */
	readonly socketPath: string;
	readonly token: string;
	/** personas.v1 capability; absent degrades to seed without a persona
	 *  head (v1 behavior) — the plan validator flags unknown personas. */
	readonly personas?: Pick<PersonasCapabilityV1, "get">;
}

/** Fresh-spawn kickoff by agent type (v1 texture; explorer added in v2). */
function kickoffFor(spawn: SpawnNodeOpts, scratch: boolean): string {
	if (spawn.agent === "worker") {
		return scratch
			? "Complete the tasks described in your seed. Toggle tasks when done."
			: "Implement the tasks described in your seed. Commit as you go. Toggle tasks when done.";
	}
	if (spawn.agent === "explorer") {
		return "Research the assignment described in your seed and report your findings.";
	}
	return "Review the code and report your findings. Follow the focus instructions in your seed.";
}

/**
 * Build the production spawnAgent implementation. One instance per execution:
 * it closes over the engine, the RPC socket, and the persona registry.
 */
export function createLiveSpawnAgent(
	wiring: LiveSpawnWiring,
): NodeExecutorDeps["spawnAgent"] {
	return async (spawn) => {
		const plan = wiring.engine.get();
		const node = findNodeV2(plan, spawn.nodeId);
		if (!node) throw new Error(`node ${spawn.nodeId} not found in plan`);
		// Node ids are agent keys AND tmux-name seeds; the executor dedupes
		// display names across live run states, so the display name is the
		// session name (v1's agentName picks, same generator).
		const sessionName = spawn.displayName;
		const cwd = spawn.worktreePath;
		const scratch = !isBranchOwner(node) && node.agent === "worker";

		// Share the maestro's agent dir so agents inherit auth credentials.
		const agentDir = defaultAgentDir();
		const agentSessionDir = join(
			process.env.PI_CODING_AGENT_SESSION_DIR ?? join(agentDir, "sessions"),
			"agents",
			sessionName,
		);
		mkdirSync(agentSessionDir, { recursive: true });

		let sessionFile: string;
		let kickoffMessage: string;
		if (spawn.resumeSessionFile) {
			// Resurrection/crash-respawn: pi appends to the existing session file
			// in place, so resuming it is cache-hot by construction. Skip seeding
			// and session assembly entirely.
			sessionFile = spawn.resumeSessionFile;
			kickoffMessage =
				spawn.kickoffMessage ??
				"Your session was resumed. Review your progress and continue.";
		} else {
			// Persona head + the executor's framed seed, then the operational
			// notes v1 attached adapter-side: commit policy (a bare "Add …"
			// subject in a semantic-release repo publishes nothing) and the
			// fresh-worktree install warning (workers burned a cycle discovering
			// "biome: command not found" before figuring out to install).
			const persona = wiring.personas?.get(spawn.persona);
			const commitNote =
				spawn.agent === "worker" && !scratch
					? (commitPolicyInstruction(detectCommitPolicy(cwd)) ?? undefined)
					: undefined;
			const needsInstall =
				spawn.agent === "worker" &&
				!scratch &&
				existsSync(join(cwd, "package.json")) &&
				!existsSync(join(cwd, "node_modules"));
			const setupNote = needsInstall
				? "This is a fresh git worktree: dependencies are NOT installed " +
					"(node_modules is not shared with the main checkout). Run the " +
					"repo's install (bun install / npm ci / pnpm install — match " +
					"the lockfile) before running any checks or tests."
				: undefined;
			// Post-freeze research refs: reports on disk that the frozen
			// knowledge doc's Research Index does not cover ride the per-agent
			// seed (after the shared prefix) so later agents see the expanding
			// picture without the base ever changing bytes.
			const knowledgeSessionPath = join(wiring.planDir, "base-knowledge.jsonl");
			const researchRefs = reportsNotInText(
				researchReportsDir(wiring.planDir),
				readKnowledgeContent(knowledgeSessionPath),
			);
			const refsNote =
				researchRefs.length > 0
					? "# Research Since the Knowledge Base Froze\n" +
						researchRefs.map((r) => `- ${r.ref}: ${r.question}`).join("\n")
					: undefined;
			// Persona head → harness operations brief → the enforced shell
			// ruleset (same rows the bash fastpath enforces — one source of
			// truth) → the assignment. All pushed, never left to inference.
			const bashActor: BashActor =
				spawn.agent === "worker" ? "worker" : "reviewer";
			const seed = [
				personaSeedHead(persona, spawn.skills) +
					`${AGENT_OPERATIONS_BRIEF}\n\n${renderBashRuleset(bashActor)}\n\n---\n\n` +
					spawn.seed,
				commitNote,
				setupNote,
				refsNote,
			]
				.filter(Boolean)
				.join("\n\n");

			const session = buildAgentSessionFile({
				agentKey: spawn.nodeId,
				agentMode: spawn.mode,
				seed,
				cwd,
				outDir: agentSessionDir,
				...(existsSync(knowledgeSessionPath) ? { knowledgeSessionPath } : {}),
			});
			sessionFile = session.path;
			kickoffMessage = spawn.kickoffMessage ?? kickoffFor(spawn, scratch);
		}

		// Cache-warm omission: fresh spawns matching the maestro's own model
		// launch without --model so they inherit it; resumes ALWAYS pass the
		// resolved model — pi otherwise restores a possibly-stale model from
		// the session file (the v1 #250 fix, verbatim).
		const sessionModelId = wiring.ctx.model
			? `${wiring.ctx.model.provider}/${wiring.ctx.model.id}`
			: undefined;
		const modelOverride =
			spawn.model === sessionModelId && !spawn.resumeSessionFile
				? undefined
				: spawn.model;

		// Identity preflight: resolve what the DEVELOPER configured and carry it
		// as env. Workers may not set it themselves — a worktree shares the
		// repo config, so an agent "fixing" this would re-author the developer's
		// checkout (which is exactly how `Test <test@example.com>` got in).
		// Writing agents fail loudly here rather than committing as a guess.
		const identityRepo = plan.repoPath ?? cwd;
		const gitIdentity = resolveGitIdentity(identityRepo) ?? undefined;
		if (!gitIdentity && spawn.mode === "full") {
			throw new Error(missingIdentityMessage(identityRepo));
		}

		try {
			mkdirSync(join(wiring.planDir, "crashes"), { recursive: true });
		} catch {}
		const spec = buildSpawnSpec({
			sessionName,
			worktreePath: cwd,
			sessionFile,
			extensionPaths: [...wiring.extensionPaths],
			env: {
				sock: wiring.socketPath,
				agentId: spawn.nodeId,
				agentMode: spawn.mode,
				...(node.sessionGeneration !== undefined
					? { generation: node.sessionGeneration }
					: {}),
				planFingerprint: planFingerprintV2Safe(plan),
				agentDir,
				sessionDir: agentSessionDir,
				token: wiring.token,
				planDir: wiring.planDir,
				...(gitIdentity ? { gitIdentity } : {}),
			},
			kickoffMessage,
			crashFile: join(wiring.planDir, "crashes", `${sessionName}.log`),
			...(wiring.transport ? { transport: wiring.transport } : {}),
			...(modelOverride ? { model: modelOverride } : {}),
			...(spawn.effort ? { thinking: spawn.effort } : {}),
		});

		// A previous maestro run's agent may still be running under this name
		// (crash orphan) — its RPC socket is dead, so it can never report.
		// Kill it before spawning the replacement. Also covers the persisted
		// sessionName from a prior process epoch.
		for (const stale of new Set(
			[node.sessionName, sessionName].filter(
				(name): name is string => typeof name === "string",
			),
		)) {
			if (await wiring.tmux.hasSession(stale)) {
				await wiring.tmux.kill(stale).catch(() => {});
			}
		}

		const cols = process.stdout.columns || 200;
		const rows = process.stdout.rows || 50;
		await wiring.tmux.spawn(spec.sessionName, spec.cwd, spec.command, {
			width: cols,
			height: rows,
			env: spec.env,
		});

		return { sessionId: sessionName, sessionFile };
	};
}

/** The plan fingerprint env var; failures never block a spawn. */
function planFingerprintV2Safe(
	plan: Parameters<typeof planFingerprintV2>[0],
): string {
	try {
		return planFingerprintV2(plan);
	} catch {
		return "";
	}
}

/** Text content of the knowledge session, "" when unreadable (v1 verbatim). */
function readKnowledgeContent(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}
