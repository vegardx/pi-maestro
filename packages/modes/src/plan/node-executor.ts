// NodeExecutor (plan-schema cutover PR-5a): DeliverableExecutor's completion
// lattice ported VERBATIM, re-keyed from deliverableId/agentName to nodeId —
// the state machines are ports, not re-derivations (risk R1). Unwired: the
// v2 adapter (PR-5b) instantiates it; until the flip only tests do.
//
// The tree changes WHO the participants are, not the lattice:
//   v1 deliverable   → v2 root worker node (usually branch-owning)
//   v1 worker        → the node's own work (gating tasks)
//   v1 support agent → child node (first-class ledger entry)
//
// One deliberate transformation, mandated by the design: v1's "one agent
// type active per deliverable" invariant derived from agents SHARING the
// deliverable's single worktree. v2 gives every worker node its OWN worktree
// (worktree iff write; candidates get cand/<parent>/<id> branches), so the
// ported invariant is one-writer-per-worktree: worker children run
// concurrently (ensembles require it), read children share the parent's
// tree concurrently, and fan-out is bounded by envelope.maxConcurrent.
//
// Durable state lives on the LEDGER (sessionPath/sessionName/generation/
// summary/handoff/worktreePath via PlanEngineV2) — what v1 kept in-memory
// for support agents and lost on crash. The in-memory map here holds only
// live-process bookkeeping (status, sessionId, display name, in-flight
// guards).

import { existsSync } from "node:fs";
import {
	commitPolicyInstruction,
	detectCommitPolicy,
} from "../exec/commit-policy.js";
import type { PlanEngineV2 } from "./engine.js";
import {
	defaultBranchForNode,
	deriveBase,
	findNodeV2,
	gatingNodeTasks,
	isBranchOwner,
	PARENT_AFTER_TOKEN,
	type PlanNode,
	parentOfNode,
	readyChildren,
	shippableNodes,
	walkNodes,
} from "./schema.js";

// ─── Runtime state (in-memory: live-process bookkeeping only) ────────────────

export type NodeAgentStatus =
	| "pending"
	| "spawning"
	| "working"
	| "summarizing"
	| "restarting"
	| "done"
	| "failed";

export interface NodeRunState {
	nodeId: string;
	status: NodeAgentStatus;
	/** Monotonic process epoch (mirrors the ledger's sessionGeneration). */
	generation: number;
	displayName?: string;
	sessionId?: string;
	/** Session JSONL path — retained across kills for resurrection/respawn. */
	sessionFile?: string;
	summary?: string;
	startedAt?: string;
	completedAt?: string;
	error?: string;
	/** Set when the node can't proceed; user action clears it. */
	blocked?: string;
	worktreePath?: string;
	branch?: string;
}

/** Blocked-reason prefix for nodes parked by restart hydration (verbatim). */
export const RESTART_BLOCK_PREFIX = "maestro restarted";

// ─── Deps seam (v1's ExecutorDeps, re-keyed) ─────────────────────────────────

export interface SpawnedNodeAgent {
	sessionId: string;
	sessionFile: string;
}

export interface SpawnNodeOpts {
	nodeId: string;
	agent: PlanNode["agent"];
	persona: string;
	displayName: string;
	/** Derived from agent type: workers write, explorers/reviewers read. */
	mode: "full" | "read-only";
	skills: readonly string[];
	worktreePath: string;
	seed: string;
	/** Resolved launch model (deps.resolveModel); absent = inherit. */
	model?: string;
	effort?: string;
	freshRecovery?: boolean;
	resumeSessionFile?: string;
	kickoffMessage?: string;
}

export interface CreateNodeWorktreeOpts {
	nodeId: string;
	branch: string;
	baseBranch: string;
	repoPath: string;
}

export interface ShipNodeOpts {
	nodeId: string;
	branch: string;
	title: string;
	body: string;
	worktreePath: string;
}

/** What provisioning resolved: the workspace plus the base facts it stamped. */
export interface ProvisionedWorkspace {
	worktreePath: string;
	branch?: string;
	baseBranch?: string;
	baseSha?: string;
	stacked?: boolean;
}

export interface NodeExecutorDeps {
	spawnAgent: (opts: SpawnNodeOpts) => Promise<SpawnedNodeAgent>;
	killSession: (sessionId: string) => Promise<void>;
	createWorktree: (opts: CreateNodeWorktreeOpts) => Promise<string>;
	/**
	 * The commit `branch` was cut from, for the provisioning stamp. Injected so
	 * the executor stays git-free; the adapter wires the real implementation.
	 */
	resolveBaseSha?: (
		repoPath: string,
		branch: string,
		baseBranch: string,
	) => string | undefined;
	/** Plain dir for repo-less plans (v1 scratch provisioning path). */
	createScratchWorkspace?: (nodeId: string) => Promise<string>;
	shipNode: (opts: ShipNodeOpts) => Promise<string>;
	requestSummary: (
		sessionId: string,
		consumer: string,
		preamble: string,
	) => Promise<string>;
	/**
	 * Collect the node's typed contract result while the agent is still
	 * alive (between summary and kill). Implementations record it on the
	 * ledger; failures must not block completion (fail-visible, never wedge).
	 */
	collectResult?: (nodeId: string, sessionId: string) => Promise<void>;
	/**
	 * Spawn-time model resolution: returns the ledger record to persist and
	 * the model/effort to launch with. Absent → inherit silently (the v1
	 * seam's behavior).
	 */
	resolveModel?: (
		node: PlanNode,
	) => Promise<{ model: string; effort?: string } | undefined>;
	defaultBranch?: string;
	defaultBranchFor?: (repoPath: string) => string | null;
	canActivate?: () => boolean;
	now: () => string;
}

// ─── Executor ────────────────────────────────────────────────────────────────

export class NodeExecutor {
	private readonly runStates = new Map<string, NodeRunState>();
	/** In-flight markAgentDone per nodeId — concurrent callers share it. */
	private readonly doneInFlight = new Map<string, Promise<void>>();
	/** Nodes mid-activation — a concurrent tick must not activate them again. */
	private readonly activating = new Set<string>();

	constructor(
		private readonly engine: PlanEngineV2,
		private readonly deps: NodeExecutorDeps,
	) {
		// Hydrate already-active nodes (resumed session). A maestro restart
		// ends the run: orphaned pi processes may still live in tmux, so
		// hydrated nodes come up BLOCKED instead of auto-respawning (verbatim).
		for (const { node } of walkNodes(engine.get())) {
			if (node.status === "active" && !this.runStates.has(node.id))
				this.hydrateActiveNode(node);
		}
	}

	private hydrateActiveNode(node: PlanNode): void {
		this.runStates.set(node.id, {
			nodeId: node.id,
			status: "pending",
			generation: node.sessionGeneration ?? 0,
			blocked: `${RESTART_BLOCK_PREFIX} — /recover resumes the interrupted agents`,
			...(node.sessionPath ? { sessionFile: node.sessionPath } : {}),
			...(node.worktreePath ? { worktreePath: node.worktreePath } : {}),
			...(node.branch ? { branch: node.branch } : {}),
		});
	}

	getStates(): ReadonlyMap<string, NodeRunState> {
		return this.runStates;
	}

	getRunState(nodeId: string): NodeRunState | undefined {
		return this.runStates.get(nodeId);
	}

	/**
	 * Main tick — advances the state machine over the TREE. Same three-phase
	 * structure as v1: activate ready roots, advance active nodes' children,
	 * ship in chain order until a pass makes no progress.
	 */
	async tick(nodeIds?: readonly string[]): Promise<string[]> {
		const plan = this.engine.get();
		const shipped: string[] = [];
		const selected = nodeIds ? new Set(nodeIds) : undefined;

		// 1. Activate ready ROOT nodes (gated: plan edits outside an autonomous
		// mode never start work; explicit selection never broadens).
		if (this.deps.canActivate?.() !== false) {
			for (const root of readyChildren(plan.nodes)) {
				if (!selected || selected.has(root.id)) await this.activateNode(root);
			}
		}

		// 2. Advance every active node: spawn its ready children.
		for (const { node } of walkNodes(this.engine.get())) {
			if (node.status !== "active") continue;
			await this.advanceNode(node);
		}

		// 3. Ship complete branch owners in chain order (verbatim loop shape).
		const attempted = new Set<string>();
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (const node of shippableNodes(this.engine.get())) {
				if (attempted.has(node.id)) continue;
				attempted.add(node.id);
				const url = await this.shipNodeIfReady(node);
				if (url !== null) {
					shipped.push(node.id);
					progressed = true;
				}
			}
		}

		return shipped;
	}

	/**
	 * Externally-triggered completion (RPC done / idle detection). Idempotent;
	 * generation guards verbatim: a stale completion crossing a replacement
	 * must not kill or complete the fresh session.
	 */
	async markAgentDone(
		nodeId: string,
		expected?: { generation: number; sessionId?: string },
	): Promise<void> {
		const run = this.runStates.get(nodeId);
		if (
			expected &&
			(!run ||
				run.generation !== expected.generation ||
				(expected.sessionId !== undefined &&
					run.sessionId !== expected.sessionId))
		)
			return;
		const inFlight = this.doneInFlight.get(nodeId);
		if (inFlight) return inFlight;
		const promise = this.runMarkAgentDone(nodeId, expected).finally(() => {
			this.doneInFlight.delete(nodeId);
		});
		this.doneInFlight.set(nodeId, promise);
		return promise;
	}

	private async runMarkAgentDone(
		nodeId: string,
		expected?: { generation: number },
	): Promise<void> {
		const run = this.runStates.get(nodeId);
		if (!run || run.status === "done" || run.status === "summarizing") return;

		// Capture before any await (verbatim staleness discipline).
		const sessionId = run.sessionId;
		const generation = run.generation;

		if (sessionId) {
			const node = findNodeV2(this.engine.get(), nodeId);
			const consumer = this.nextConsumer(node);
			const preamble = `${run.displayName ?? nodeId} — ${node?.title ?? nodeId}`;
			try {
				run.status = "summarizing";
				run.summary = await this.deps.requestSummary(
					sessionId,
					consumer,
					preamble,
				);
			} catch {
				// Summary extraction failed — continue without it.
			}
			// Contract collection runs while the agent is still ALIVE (the retry
			// steers need someone to answer); its failure never blocks completion.
			if (this.deps.collectResult) {
				try {
					await this.deps.collectResult(nodeId, sessionId);
				} catch {
					// Fail-visible downstream (the ledger shows no result record).
				}
			}
			await this.deps.killSession(sessionId);
		}

		if (
			run.generation !== generation ||
			run.sessionId !== sessionId ||
			(expected && expected.generation !== generation)
		)
			return;

		run.status = "done";
		run.completedAt = this.deps.now();
		// Prune the dead tmux session id (v1 behavior): getWorkerSessions/
		// resolveSessionName must not surface a killed session, or /watch
		// panes never auto-close. sessionFile stays — resurrection needs it.
		run.sessionId = undefined;
		if (run.summary)
			this.engine.setNodeRuntime(nodeId, { summary: run.summary });

		await this.checkNodeCompletion(nodeId);
	}

	markAgentFailed(nodeId: string, error: string): void {
		const run = this.runStates.get(nodeId);
		if (!run) return;
		run.status = "failed";
		run.error = error;
		run.completedAt = this.deps.now();
	}

	blockNode(nodeId: string, reason: string): void {
		const run = this.runStates.get(nodeId);
		if (run) run.blocked = reason;
	}

	unblockNode(nodeId: string): void {
		const run = this.runStates.get(nodeId);
		if (run) run.blocked = undefined;
	}

	/** All gating tasks toggled (worker nodes' own-work completion test). */
	isNodeWorkDone(nodeId: string): boolean {
		const node = findNodeV2(this.engine.get(), nodeId);
		if (!node) return false;
		return gatingNodeTasks(node).every((task) => task.done);
	}

	/**
	 * Recover nodes parked by restart hydration (verbatim): re-provision a
	 * vanished workspace, clear the block, respawn — resumes persisted
	 * session files. Failures re-park with the cause.
	 */
	async recoverInterrupted(nodeIds?: readonly string[]): Promise<{
		recovered: string[];
		failed: Array<{ id: string; error: string }>;
	}> {
		const recovered: string[] = [];
		const failed: Array<{ id: string; error: string }> = [];
		const selected = nodeIds ? new Set(nodeIds) : undefined;
		for (const [id, run] of this.runStates) {
			if (selected && !selected.has(id)) continue;
			if (!run.blocked?.startsWith(RESTART_BLOCK_PREFIX)) continue;
			const node = findNodeV2(this.engine.get(), id);
			if (node?.status !== "active") continue;
			try {
				if (
					this.needsWorkspace(node) &&
					(!run.worktreePath || !existsSync(run.worktreePath))
				) {
					const provisioned = await this.provisionWorkspace(node);
					run.worktreePath = provisioned.worktreePath;
					run.branch = provisioned.branch;
					this.engine.setNodeRuntime(id, provisioned);
				}
				run.blocked = undefined;
				if (run.status === "pending") await this.spawnNode(node, run);
				await this.advanceNode(node);
				recovered.push(id);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				run.blocked = `recovery failed: ${message} — fix the cause, then run /recover ${id}`;
				failed.push({ id, error: message });
			}
		}
		return { recovered, failed };
	}

	/** Respawn a failed/stopped agent, resuming its own transcript. */
	async respawnAgent(nodeId: string): Promise<void> {
		const node = findNodeV2(this.engine.get(), nodeId);
		const run = this.runStates.get(nodeId);
		if (!node || !run) throw new Error(`no run state for node ${nodeId}`);
		run.status = "pending";
		if (node.agent === "worker") {
			run.generation += 1;
			this.engine.setNodeRuntime(nodeId, {
				sessionGeneration: run.generation,
			});
		}
		run.sessionId = undefined;
		run.error = undefined;
		run.completedAt = undefined;
		await this.spawnNode(node, run);
	}

	/**
	 * Replace a stopped worker after the adapter has proven the old process
	 * gone (verbatim semantics incl. the spawn-proof check).
	 */
	async replaceWorker(
		nodeId: string,
		mode: "resume" | "fresh",
		generation: number,
		recoverySeed?: string,
	): Promise<NodeRunState> {
		const node = findNodeV2(this.engine.get(), nodeId);
		const run = this.runStates.get(nodeId);
		if (!node || !run) throw new Error(`no active worker state for ${nodeId}`);
		if (!run.worktreePath) throw new Error(`no workspace for ${nodeId}`);
		run.blocked = undefined;
		run.status = "restarting";
		run.generation = generation;
		this.engine.setNodeRuntime(nodeId, { sessionGeneration: generation });
		run.sessionId = undefined;
		run.summary = undefined;
		run.error = undefined;
		run.completedAt = undefined;
		if (mode === "fresh") run.sessionFile = undefined;
		run.status = "pending";
		await this.spawnNode(
			node,
			run,
			mode === "resume"
				? "Your worker process was safely replaced. Review progress and continue."
				: "Continue from the fresh-session recovery seed. Inspect and preserve existing work before editing.",
			recoverySeed,
		);
		if (this.runStates.get(nodeId)?.status !== "working")
			throw new Error(`replacement worker for ${nodeId} did not spawn`);
		return run;
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	/** Worktree iff write tools: workers get workspaces, read agents borrow. */
	private needsWorkspace(node: PlanNode): boolean {
		return node.agent === "worker";
	}

	private modeFor(node: PlanNode): "full" | "read-only" {
		return node.agent === "worker" ? "full" : "read-only";
	}

	private async activateNode(node: PlanNode): Promise<void> {
		if (this.activating.has(node.id)) return;
		const existing = this.runStates.get(node.id);
		if (existing) {
			const retryableFailure =
				existing.worktreePath === undefined &&
				existing.status === "pending" &&
				!existing.blocked;
			if (!retryableFailure) return;
		}
		this.activating.add(node.id);
		try {
			await this.doActivateNode(node);
		} catch (err) {
			// NEVER let provisioning failures escape the tick (verbatim — that
			// crashed the whole maestro once). Park blocked with the cause.
			const message = err instanceof Error ? err.message : String(err);
			this.runStates.set(node.id, {
				nodeId: node.id,
				status: "pending",
				generation: 0,
				blocked: `activation failed: ${message} — fix the cause, then /start ${node.id}`,
			});
		} finally {
			this.activating.delete(node.id);
		}
	}

	private async doActivateNode(node: PlanNode): Promise<void> {
		const run: NodeRunState = {
			nodeId: node.id,
			status: "pending",
			generation: node.sessionGeneration ?? 0,
		};
		if (this.needsWorkspace(node)) {
			const provisioned = await this.provisionWorkspace(node);
			const { worktreePath, branch } = provisioned;
			run.worktreePath = worktreePath;
			run.branch = branch;
			this.runStates.set(node.id, run);
			this.engine.setNodeStatus(node.id, "active");
			this.engine.setNodeRuntime(node.id, provisioned);
		} else {
			// Read agents borrow the parent's workspace (parent's cwd stance).
			const parent = parentOfNode(this.engine.get(), node.id);
			const parentRun = parent ? this.runStates.get(parent.id) : undefined;
			run.worktreePath = parentRun?.worktreePath ?? this.engine.get().repoPath;
			this.runStates.set(node.id, run);
			this.engine.setNodeStatus(node.id, "active");
		}
		const fresh = findNodeV2(this.engine.get(), node.id);
		if (fresh) await this.spawnNode(fresh, run);
	}

	/**
	 * Workspace provisioning: branch owners get their authored branch on the
	 * derived base (v1 pickBaseBranch semantics via deriveBase); branchless
	 * workers get candidate worktrees on cand/<parent>/<id> from the parent's
	 * branch point (ensemble spike) — worktree ≠ shipping.
	 */
	private async provisionWorkspace(
		node: PlanNode,
	): Promise<ProvisionedWorkspace> {
		const plan = this.engine.get();
		if (!plan.repoPath) {
			if (!this.deps.createScratchWorkspace)
				throw new Error(
					`node ${node.id} needs a workspace but this runtime cannot provision one`,
				);
			return { worktreePath: await this.deps.createScratchWorkspace(node.id) };
		}
		const parent = parentOfNode(plan, node.id);
		const siblings = parent ? (parent.children ?? []) : plan.nodes;
		const defaultBranch =
			this.deps.defaultBranchFor?.(plan.repoPath) ??
			this.deps.defaultBranch ??
			"main";
		if (isBranchOwner(node)) {
			const branch = node.branch ?? defaultBranchForNode(node);
			const baseBranch = deriveBase(node, siblings, defaultBranch);
			const worktreePath = await this.deps.createWorktree({
				nodeId: node.id,
				branch,
				baseBranch,
				repoPath: plan.repoPath,
			});
			return {
				worktreePath,
				branch,
				...this.stampBase(plan.repoPath, branch, baseBranch, defaultBranch),
			};
		}
		// Branchless worker (ensemble candidate / prep node): its own worktree
		// on a candidate branch from the parent's branch point. Its diff is
		// contract output; the branch never ships and is reaped later.
		const parentRun = parent ? this.runStates.get(parent.id) : undefined;
		const branch = `cand/${parent?.id ?? "root"}/${node.id}`;
		const baseBranch = parentRun?.branch ?? defaultBranch;
		const worktreePath = await this.deps.createWorktree({
			nodeId: node.id,
			branch,
			baseBranch,
			repoPath: plan.repoPath,
		});
		return {
			worktreePath,
			branch,
			...this.stampBase(plan.repoPath, branch, baseBranch, defaultBranch),
		};
	}

	/**
	 * Resolve what the base actually became on disk. Recorded because `base` is
	 * authored intent and usually absent: without this, nothing downstream can
	 * tell a correctly-stacked node from one that silently cut from the default
	 * branch — which is exactly the #249 bug, and the reason its live guard
	 * passed vacuously once v2 stopped stamping these.
	 */
	private stampBase(
		repoPath: string,
		branch: string,
		baseBranch: string,
		defaultBranch: string,
	): { baseBranch: string; stacked: boolean; baseSha?: string } {
		const baseSha = this.deps.resolveBaseSha?.(repoPath, branch, baseBranch);
		return {
			baseBranch,
			stacked: baseBranch !== defaultBranch,
			...(baseSha ? { baseSha } : {}),
		};
	}

	private async advanceNode(node: PlanNode): Promise<void> {
		const run = this.runStates.get(node.id);
		if (run?.blocked) return;

		// Hydration resume (v1 parity): an active node whose agent is still
		// pending after an unblock respawns here — the poll/tick path, not
		// only recoverInterrupted, brings it back.
		if (run && run.status === "pending") await this.spawnNode(node, run);

		// Spawn ready children: sibling deps + the parent-gating token, bounded
		// by envelope.maxConcurrent (backpressure — later ticks retry).
		const children = node.children ?? [];
		if (children.length === 0) {
			await this.checkNodeCompletion(node.id);
			return;
		}
		const parentGatingDone = gatingNodeTasks(node).every((task) => task.done);
		const maxConcurrent =
			node.envelope?.maxConcurrent ??
			this.engine.get().defaultEnvelope?.maxConcurrent;
		const liveCount = children.filter((child) => {
			const childRun = this.runStates.get(child.id);
			return (
				childRun &&
				["spawning", "working", "summarizing", "restarting"].includes(
					childRun.status,
				)
			);
		}).length;
		let capacity =
			maxConcurrent === undefined
				? Number.POSITIVE_INFINITY
				: maxConcurrent - liveCount;
		for (const child of readyChildren(children, { parentGatingDone })) {
			if (capacity <= 0) break;
			await this.activateNode(child);
			capacity--;
		}
		await this.checkNodeCompletion(node.id);
	}

	private async spawnNode(
		node: PlanNode,
		run: NodeRunState,
		kickoffMessage?: string,
		seedOverride?: string,
	): Promise<void> {
		if (run.blocked) return;
		if (run.status !== "pending") return;

		const { agentName: genName } = await import("../agent-names.js");
		const taken = new Set(
			[...this.runStates.values()]
				.filter((state) => state.displayName)
				.map((state) => state.displayName as string),
		);
		run.status = "spawning";
		run.displayName ??= genName(node.id, taken);
		run.startedAt = this.deps.now();

		// Resurrection: a prior session file resumes cache-hot (verbatim).
		const resumeSessionFile = run.sessionFile;
		const seed = resumeSessionFile
			? ""
			: (seedOverride ?? this.buildSeed(node));

		// Spawn-time model resolution: the implementation records the
		// NodeResolution on the ledger and hands back the launch choice.
		let resolved: { model: string; effort?: string } | undefined;
		if (this.deps.resolveModel) {
			try {
				resolved = await this.deps.resolveModel(node);
			} catch (err) {
				// Fail-visible: an authored mistake (unknown catalog, bad tier)
				// parks the node blocked instead of spawning on a mystery model.
				run.status = "pending";
				run.blocked = `model resolution failed: ${err instanceof Error ? err.message : String(err)}`;
				return;
			}
		}

		const spawned = await this.deps.spawnAgent({
			nodeId: node.id,
			agent: node.agent,
			persona: node.persona,
			displayName: run.displayName,
			mode: this.modeFor(node),
			skills: node.skills ?? [],
			worktreePath: run.worktreePath ?? this.engine.get().repoPath,
			seed,
			...(resolved ? { model: resolved.model } : {}),
			...(resolved?.effort ? { effort: resolved.effort } : {}),
			...(seedOverride !== undefined ? { freshRecovery: true } : {}),
			...(resumeSessionFile
				? {
						resumeSessionFile,
						kickoffMessage:
							kickoffMessage ??
							"Your previous session ended unexpectedly and has been resumed. Review your progress, then continue the remaining work.",
					}
				: kickoffMessage
					? { kickoffMessage }
					: {}),
		});

		run.sessionId = spawned.sessionId;
		run.sessionFile = spawned.sessionFile;
		run.status = "working";
		this.engine.setNodeRuntime(node.id, {
			sessionPath: spawned.sessionFile,
			sessionName: spawned.sessionId,
		});
	}

	/** v1 buildSeed keyed to nodes: dep handoffs → sibling summaries → own work. */
	private buildSeed(node: PlanNode): string {
		const plan = this.engine.get();
		const parts: string[] = [];
		const parent = parentOfNode(plan, node.id);
		const siblings = parent ? (parent.children ?? []) : plan.nodes;

		// 1. Handoffs from sibling after-deps (cache-stable prefix).
		for (const ref of node.after ?? []) {
			if (ref === PARENT_AFTER_TOKEN) continue;
			const dep = siblings.find((sibling) => sibling.id === ref);
			const handoff = dep?.handoff ?? dep?.summary;
			if (handoff) parts.push(handoff);
		}

		// 2. Completed-sibling summaries within the same group.
		for (const sibling of siblings) {
			if (sibling.id === node.id) continue;
			if (sibling.summary && sibling.status !== "planned")
				parts.push(sibling.summary);
		}

		// 3. Own work, last (v1 shape preserved for prompt-cache continuity).
		if (node.agent === "worker") {
			const policyNote = commitPolicyInstruction(
				detectCommitPolicy(plan.repoPath),
			);
			if (policyNote) parts.push(policyNote);
			parts.push(`## Deliverable: ${node.title ?? node.id}`);
			const tasks = gatingNodeTasks(node);
			if (tasks.length > 0) {
				parts.push("\n## Tasks\n");
				for (const task of tasks) {
					const check = task.done ? "x" : " ";
					// The id is the toggle key — workers that had only titles
					// guessed ids and wedged on the lifecycle pair.
					parts.push(`- [${check}] **${task.title}** (taskId: \`${task.id}\`)`);
					if (task.body) parts.push(`  ${task.body}`);
				}
			}
			parts.push(
				isBranchOwner(node)
					? "\n---\nDo your work. Commit as you go. Toggle tasks when done " +
							"using the EXACT taskId shown above. " +
							"Exit when complete. The maestro handles pushing and opening the PR."
					: "\n---\nDo your work in this worktree. Commit as you go. Toggle " +
							"tasks when done using the EXACT taskId shown above. Exit when " +
							"complete. Your committed diff is " +
							"your deliverable — the parent integrates it; nothing here " +
							"ships directly.",
			);
		} else {
			parts.push(`## Focus\n`);
			for (const task of node.tasks) parts.push(`- ${task.title}`);
		}

		return parts.join("\n\n");
	}

	/** v1 nextConsumer over the tree: dependent siblings, else the parent. */
	private nextConsumer(node: PlanNode | null): string {
		if (!node) return "the next step in the workflow";
		const plan = this.engine.get();
		const parent = parentOfNode(plan, node.id);
		const siblings = parent ? (parent.children ?? []) : plan.nodes;
		const dependents = siblings.filter((sibling) =>
			sibling.after?.includes(node.id),
		);
		if (dependents.length > 0)
			return dependents
				.map((sibling) => sibling.title ?? sibling.id)
				.join("; ");
		if (parent) return `the parent node "${parent.title ?? parent.id}"`;
		return "the project completion summary";
	}

	/**
	 * Node completion (v1 checkDeliverableCompletion over the tree): the
	 * node's own work done (workers: gating tasks; read agents: markAgentDone)
	 * AND every child terminal. Failures propagate with the v1 failure record.
	 */
	private async checkNodeCompletion(nodeId: string): Promise<void> {
		const node = findNodeV2(this.engine.get(), nodeId);
		const run = this.runStates.get(nodeId);
		if (!node || !run || node.status !== "active") return;

		const children = node.children ?? [];
		const childrenTerminal = children.every((child) =>
			["complete", "shipped", "failed", "abandoned", "superseded"].includes(
				child.status,
			),
		);
		if (!childrenTerminal) return;

		const failedChild = children.find((child) => child.status === "failed");
		const ownDone =
			node.agent === "worker"
				? this.isNodeWorkDone(nodeId) && run.status === "done"
				: run.status === "done" || run.status === "failed";
		if (!ownDone && !failedChild) return;

		if (run.status === "failed" || failedChild) {
			const current = findNodeV2(this.engine.get(), nodeId);
			if (current?.status === "active") {
				this.engine.setNodeStatus(nodeId, "failed", {
					code: "agent-failed",
					message:
						run.error ?? `child node ${failedChild?.id ?? "unknown"} failed`,
					failedAt: run.completedAt ?? this.deps.now(),
					recoverable: true,
					attempt: (current.failure?.attempt ?? 0) + 1,
					agentId: run.error ? nodeId : (failedChild?.id ?? nodeId),
				});
			}
			return;
		}

		// Fold child summaries into the node's rollup (v1 assembly).
		const summaries = [
			run.summary,
			...children.map((child) => child.summary),
		].filter((summary): summary is string => Boolean(summary));
		this.engine.setNodeStatus(nodeId, "complete");
		if (summaries.length > 0)
			this.engine.setNodeRuntime(nodeId, {
				summary: summaries.join("\n\n"),
			});

		// A completed child may unblock the parent's completion in turn.
		const parent = parentOfNode(this.engine.get(), nodeId);
		if (parent) await this.checkNodeCompletion(parent.id);
	}

	/** v1 shipDeliverableIfReady: complete branch owners ship; failures park. */
	private async shipNodeIfReady(node: PlanNode): Promise<string | null> {
		const run = this.runStates.get(node.id);
		if (!run) return null;

		const tasks = gatingNodeTasks(node);
		const taskList = tasks.map((task) => `- [x] ${task.title}`).join("\n");
		const childReports = (node.children ?? [])
			.filter((child) => child.summary)
			.map((child) => `### ${child.title ?? child.id}\n${child.summary}`)
			.join("\n\n");
		const body = [
			node.title ?? node.id,
			taskList ? `## Tasks\n${taskList}` : "",
			childReports ? `## Agent Reports\n${childReports}` : "",
		]
			.filter(Boolean)
			.join("\n\n");

		let prUrl: string;
		try {
			prUrl = await this.deps.shipNode({
				nodeId: node.id,
				branch: node.branch ?? defaultBranchForNode(node),
				title: node.title ?? node.id,
				body,
				worktreePath: run.worktreePath ?? this.engine.get().repoPath,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			run.blocked = `shipping failed: ${detail}`;
			return null;
		}

		if (run.blocked?.startsWith("shipping failed:")) run.blocked = undefined;
		this.engine.setNodeStatus(node.id, "shipped");
		this.engine.setNodeRuntime(node.id, { prUrl });
		return prUrl;
	}
}
