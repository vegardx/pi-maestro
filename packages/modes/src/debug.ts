import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Answer, AskCapabilityV1, Question } from "@vegardx/pi-contracts";
import { redactSecrets } from "@vegardx/pi-core";
import type { DebugProposalMessage, DebugResultMessage } from "@vegardx/pi-rpc";
import type { ExecutionHandle } from "./exec/index.js";
import type { PlanEngineV2, PlanRepairOperation } from "./plan/engine.js";
import {
	findNodeV2,
	type PlanNode,
	type PlanV2,
	planFingerprintV2,
	walkNodes,
} from "./plan/schema.js";

/** v1 workerSessionGeneration, per node (absent hydrates as generation 0). */
function nodeSessionGeneration(
	node: Pick<PlanNode, "sessionGeneration">,
): number {
	return node.sessionGeneration ?? 0;
}

export type DebugFactSource =
	| "session-manager"
	| "runtime"
	| "plan"
	| "executor"
	| "environment"
	| "platform";

export interface DebugFact<T> {
	readonly value: T;
	readonly source: DebugFactSource;
}

export interface DebugFailureFact {
	readonly at?: string;
	readonly error: string;
	readonly source: "crash-snapshot" | "tool-result";
}

export interface DebugSnapshot {
	readonly capturedAt: string;
	readonly sessionPath?: DebugFact<string>;
	readonly role: DebugFact<"maestro" | "worker" | "standalone">;
	readonly mode: DebugFact<string>;
	readonly cwd: DebugFact<string>;
	readonly plan?: {
		readonly slug: string;
		readonly path: string;
		readonly fingerprint: string;
	};
	readonly execution: {
		readonly stage: string;
		readonly activeDeliverableId?: string;
		readonly blocked?: string;
		readonly pendingQuestions: number;
	};
	readonly worker?: {
		readonly agentId?: string;
		readonly generation: number;
		readonly sessionPath?: string;
		readonly previousSessionPaths: readonly string[];
		readonly sessionName?: string;
		readonly status?: string;
		readonly worktreePath?: string;
		readonly branch?: string;
	};
	readonly recentFailures: readonly DebugFailureFact[];
	readonly runtime: {
		readonly node: string;
		readonly platform: string;
		readonly architecture: string;
		readonly maestroRevision: string;
	};
	readonly executorFacts: ReadonlyArray<{
		readonly key: string;
		readonly status: string;
		readonly turns: number;
	}>;
}

export type DebugRecoveryKind =
	| "steer"
	| "retry-activation"
	| "restart-resume"
	| "restart-fresh"
	| "repair"
	| "none";

export type DebugContinuation =
	| "retry-activation"
	| "restart-resume"
	| "restart-fresh"
	| "none";

export interface DebugRecoveryProposal {
	readonly id: string;
	readonly kind: DebugRecoveryKind;
	readonly targetDeliverableId?: string;
	readonly expectedGeneration?: number;
	readonly basePlanFingerprint?: string;
	readonly guidance?: string;
	readonly repairReason?: string;
	readonly repairOperations?: readonly PlanRepairOperation[];
	readonly continuation?: DebugContinuation;
	readonly confidence: number;
	readonly rationale: string;
}

export interface DebugDiagnosis {
	readonly observed: readonly string[];
	readonly likelyCause: string;
	readonly recoveries: readonly DebugRecoveryProposal[];
	readonly recommendation: string;
}

export interface DebugOperationResult {
	readonly action: DebugRecoveryKind;
	readonly attemptedAt: string;
	readonly ok: boolean;
	readonly detail: string;
}

export interface DebugEpisode {
	readonly version: 1;
	readonly id: string;
	readonly createdAt: string;
	readonly snapshot: DebugSnapshot;
	readonly diagnosis: DebugDiagnosis;
	readonly sourceProposalId?: string;
	selectedRecoveryId?: string;
	attemptedAt?: string;
	result?: DebugOperationResult;
	issueReview?: import("./debug-issue.js").DebugIssueReviewState;
}

export interface DebugSnapshotInput {
	readonly now?: () => string;
	readonly cwd: string;
	readonly mode: string;
	readonly executionStage: string;
	readonly activeDeliverableId?: string;
	readonly sessionPath?: string;
	readonly entries: readonly SessionEntry[];
	readonly engine?: PlanEngineV2;
	readonly execution?: ExecutionHandle;
	readonly planRoot?: string;
	readonly agentId?: string;
	/** Worker-local generation binding (from the spawn environment). */
	readonly workerGeneration?: number;
	readonly maestroRevision?: string;
}

/** First active node in tree order, if any. */
function firstActiveNodeId(plan: Pick<PlanV2, "nodes">): string | undefined {
	for (const { node } of walkNodes(plan))
		if (node.status === "active") return node.id;
	return undefined;
}

export function normalizeDebugPath(value: string): string {
	const home = homedir();
	return value === home
		? "~"
		: value.startsWith(`${home}/`)
			? `~/${value.slice(home.length + 1)}`
			: value;
}

function boundedFailures(entries: readonly SessionEntry[]): DebugFailureFact[] {
	const failures: DebugFailureFact[] = [];
	for (let i = entries.length - 1; i >= 0 && failures.length < 8; i--) {
		const entry = entries[i] as unknown as Record<string, unknown>;
		if (
			entry.type === "custom_message" &&
			entry.customType === "maestro.crash.snapshot"
		) {
			const details = entry.details as Record<string, unknown> | undefined;
			if (details && typeof details.error === "string") {
				failures.push({
					...(typeof details.at === "string" ? { at: details.at } : {}),
					error: redactSecrets(details.error).slice(0, 2000),
					source: "crash-snapshot",
				});
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as Record<string, unknown> | undefined;
		if (message?.role !== "toolResult" || message.isError !== true) continue;
		const text =
			typeof message.content === "string"
				? message.content
				: JSON.stringify(message.content ?? "");
		failures.push({
			error: redactSecrets(text).slice(0, 2000),
			source: "tool-result",
		});
	}
	return failures.reverse();
}

export function collectDebugSnapshot(input: DebugSnapshotInput): DebugSnapshot {
	const plan = input.engine?.get();
	// v2: the authenticated agent key IS the node id (no "<id>/<agent>" split).
	const requestedDeliverableId = input.activeDeliverableId ?? input.agentId;
	const deliverableId =
		(plan && requestedDeliverableId
			? findNodeV2(plan, requestedDeliverableId)?.id
			: undefined) ??
		(plan ? firstActiveNodeId(plan) : undefined) ??
		// Worker-local snapshots have no plan to verify against; the node
		// identity comes from the authenticated agent id, never from model input.
		input.agentId;
	const deliverable =
		plan && deliverableId ? findNodeV2(plan, deliverableId) : undefined;
	// v2: one run state per node (the v1 per-deliverable agents map is gone).
	const worker = deliverableId
		? input.execution?.getExecutor().getRunState(deliverableId)
		: undefined;
	const snapshot = input.execution?.snapshot();
	const role = input.agentId ? "worker" : plan ? "maestro" : "standalone";
	return {
		capturedAt: (input.now ?? (() => new Date().toISOString()))(),
		...(input.sessionPath
			? {
					sessionPath: {
						value: normalizeDebugPath(input.sessionPath),
						source: "session-manager",
					},
				}
			: {}),
		role: { value: role, source: input.agentId ? "environment" : "runtime" },
		mode: { value: input.mode, source: "runtime" },
		cwd: { value: normalizeDebugPath(input.cwd), source: "runtime" },
		...(plan
			? {
					plan: {
						slug: plan.slug,
						path: normalizeDebugPath(
							join(input.planRoot ?? "", plan.slug, "plan.json"),
						),
						fingerprint: planFingerprintV2(plan),
					},
				}
			: {}),
		execution: {
			stage: input.executionStage,
			...(deliverableId ? { activeDeliverableId: deliverableId } : {}),
			...(worker?.blocked ? { blocked: redactSecrets(worker.blocked) } : {}),
			pendingQuestions: input.execution?.questionQueue.all().length ?? 0,
		},
		...(deliverable
			? {
					worker: {
						...(input.agentId ? { agentId: input.agentId } : {}),
						generation:
							worker?.generation ?? nodeSessionGeneration(deliverable),
						...(deliverable.sessionPath
							? { sessionPath: normalizeDebugPath(deliverable.sessionPath) }
							: {}),
						previousSessionPaths: (deliverable.previousSessionPaths ?? []).map(
							normalizeDebugPath,
						),
						...(deliverable.sessionName
							? { sessionName: deliverable.sessionName }
							: {}),
						...(worker?.status ? { status: worker.status } : {}),
						...(deliverable.worktreePath
							? { worktreePath: normalizeDebugPath(deliverable.worktreePath) }
							: {}),
						...(deliverable.branch ? { branch: deliverable.branch } : {}),
					},
				}
			: input.agentId && input.workerGeneration !== undefined
				? {
						// Worker-local facts: enough for the diagnosis to propose real
						// recoveries (restart-resume/-fresh) instead of only "none".
						// The maestro revalidates every binding before anything runs.
						worker: {
							agentId: input.agentId,
							generation: input.workerGeneration,
							...(input.sessionPath
								? { sessionPath: normalizeDebugPath(input.sessionPath) }
								: {}),
							previousSessionPaths: [],
						},
					}
				: {}),
		recentFailures: boundedFailures(input.entries),
		runtime: {
			node: process.version,
			platform: platform(),
			architecture: arch(),
			maestroRevision:
				input.maestroRevision ?? process.env.PI_MAESTRO_REVISION ?? "unknown",
		},
		executorFacts: snapshot
			? [...snapshot.agents.entries()].slice(0, 32).map(([key, value]) => ({
					key,
					status: value.status,
					turns: value.tokens.turns,
				}))
			: [],
	};
}

function proposal(
	input: Omit<DebugRecoveryProposal, "id">,
): DebugRecoveryProposal {
	return { id: `${input.kind}-${randomUUID()}`, ...input };
}

export function diagnoseDebugSnapshot(
	snapshot: DebugSnapshot,
	hint = "",
	workerRecovery?: Omit<DebugRecoveryProposal, "id">,
): DebugDiagnosis {
	const target = snapshot.execution.activeDeliverableId;
	const generation = snapshot.worker?.generation;
	const fingerprint = snapshot.plan?.fingerprint;
	const recoveries: DebugRecoveryProposal[] = [];
	const blocked = snapshot.execution.blocked ?? "";
	if (workerRecovery) recoveries.push(proposal(workerRecovery));
	if (target && /^activation failed:/i.test(blocked)) {
		recoveries.push(
			proposal({
				kind: "retry-activation",
				targetDeliverableId: target,
				expectedGeneration: generation,
				basePlanFingerprint: fingerprint,
				confidence: 0.9,
				rationale:
					"The executor recorded a retryable activation failure; this clears only that block and ticks the scheduler.",
			}),
		);
	} else if (
		target &&
		snapshot.worker?.status &&
		// v2 NodeAgentStatus has no "idle" — "working" is the live state.
		["working", "summarizing"].includes(snapshot.worker.status)
	) {
		recoveries.push(
			proposal({
				kind: "steer",
				targetDeliverableId: target,
				expectedGeneration: generation,
				basePlanFingerprint: fingerprint,
				guidance:
					hint.trim() ||
					"Pause, inspect the latest failure and current workspace state, then continue only after verifying the next step.",
				confidence: 0.75,
				rationale:
					"The current worker is still live, so steering preserves its process, transcript, and workspace.",
			}),
		);
	}
	if (target && snapshot.worker?.sessionPath) {
		recoveries.push(
			proposal({
				kind: "restart-resume",
				targetDeliverableId: target,
				expectedGeneration: generation,
				basePlanFingerprint: fingerprint,
				confidence: blocked ? 0.8 : 0.55,
				rationale:
					"Replace the worker process through the generation barrier and append to the same JSONL.",
			}),
		);
		recoveries.push(
			proposal({
				kind: "restart-fresh",
				targetDeliverableId: target,
				expectedGeneration: generation,
				basePlanFingerprint: fingerprint,
				confidence: 0.35,
				rationale:
					"Replace the process and JSONL while preserving the validated workspace and prior transcript history.",
			}),
		);
	}
	recoveries.push(
		proposal({
			kind: "none",
			confidence: target ? 0.2 : 1,
			rationale: "Leave runtime and plan state unchanged.",
		}),
	);
	const sorted = [...recoveries].sort((a, b) => b.confidence - a.confidence);
	const likelyCause =
		snapshot.recentFailures.at(-1)?.error ??
		(blocked ||
			(hint.trim()
				? `User-reported symptom: ${redactSecrets(hint.trim()).slice(0, 1000)}`
				: "No bounded failure evidence was found; diagnosis is limited to current runtime state."));
	return {
		observed: [
			`role=${snapshot.role.value}, mode=${snapshot.mode.value}, stage=${snapshot.execution.stage}`,
			...(target
				? [`deliverable=${target}, generation=${generation ?? "unknown"}`]
				: []),
			...(blocked ? [`blocked=${blocked}`] : []),
			`recentFailures=${snapshot.recentFailures.length}, pendingQuestions=${snapshot.execution.pendingQuestions}`,
		],
		likelyCause,
		recoveries: sorted,
		recommendation: sorted[0]?.id ?? "",
	};
}

export function renderRecoveryQuestion(episode: DebugEpisode): Question {
	const labels: Record<DebugRecoveryKind, string> = {
		steer: "Steer current worker",
		"retry-activation": "Retry activation",
		"restart-resume": "Restart and resume session",
		"restart-fresh": "Restart with fresh session",
		repair: "Apply plan repair and continue",
		none: "No recovery",
	};
	return {
		id: `debug-recovery-${episode.id}`,
		header: "Recovery",
		question:
			"Choose one recovery action. Nothing runs until you submit this selection.",
		context: `Likely cause (inference): ${episode.diagnosis.likelyCause}\n\nObserved facts:\n${episode.diagnosis.observed.map((f) => `- ${f}`).join("\n")}`,
		blocking: true,
		whyBlocking:
			"Recovery can replace a worker or mutate the plan, so explicit consent is required.",
		recommendation: episode.diagnosis.recommendation,
		options: episode.diagnosis.recoveries.map((r) => ({
			label: labels[r.kind],
			value: r.id,
			description: `${Math.round(r.confidence * 100)}% confidence — ${r.rationale}`,
			body: renderRecoveryPreview(r),
			dimensions: {
				process:
					r.kind === "steer" ||
					r.kind === "none" ||
					r.kind === "retry-activation"
						? "preserved"
						: "replaced",
				session: r.kind === "restart-fresh" ? "new JSONL" : "preserved",
				workspace: r.kind === "none" ? "unchanged" : "reused",
			},
		})),
	};
}

export function renderRecoveryPreview(recovery: DebugRecoveryProposal): string {
	const lines = [
		`## Exact action`,
		`- Kind: \`${recovery.kind}\``,
		`- Target: \`${recovery.targetDeliverableId ?? "none"}\``,
		`- Expected generation: \`${recovery.expectedGeneration ?? "n/a"}\``,
		`- Plan fingerprint: \`${recovery.basePlanFingerprint ?? "n/a"}\``,
		``,
		`## Effect`,
		recovery.rationale,
	];
	if (recovery.guidance) lines.push("", "## Guidance", recovery.guidance);
	if (recovery.repairOperations)
		lines.push(
			"",
			"## Atomic repair diff",
			"```json",
			JSON.stringify(recovery.repairOperations, null, 2),
			"```",
			`Continuation: \`${recovery.continuation ?? "none"}\``,
		);
	return lines.join("\n");
}

export class DebugEpisodeStore {
	constructor(private readonly file: string) {}
	load(): DebugEpisode | undefined {
		try {
			const parsed = JSON.parse(
				readFileSync(this.file, "utf8"),
			) as DebugEpisode;
			return parsed.version === 1 ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	save(episode: DebugEpisode): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(episode, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(tmp, this.file);
	}
	clear(): void {
		rmSync(this.file, { force: true });
	}
	exists(): boolean {
		return existsSync(this.file);
	}
}

export class DebugController {
	private episode?: DebugEpisode;
	private seenProposals = new Set<string>();
	constructor(private store?: DebugEpisodeStore) {}
	setStore(store: DebugEpisodeStore): void {
		this.store = store;
		this.episode = store.load();
	}
	get(): DebugEpisode | undefined {
		return this.episode;
	}
	begin(
		snapshot: DebugSnapshot,
		diagnosis: DebugDiagnosis,
		sourceProposalId?: string,
	): DebugEpisode | undefined {
		if (
			sourceProposalId &&
			(this.seenProposals.has(sourceProposalId) ||
				this.episode?.sourceProposalId === sourceProposalId)
		)
			return undefined;
		if (sourceProposalId) this.seenProposals.add(sourceProposalId);
		this.episode = {
			version: 1,
			id: randomUUID(),
			createdAt: snapshot.capturedAt,
			snapshot,
			diagnosis,
			...(sourceProposalId ? { sourceProposalId } : {}),
		};
		this.store?.save(this.episode);
		return this.episode;
	}
	selectOnce(recoveryId: string, now = new Date().toISOString()): DebugEpisode {
		if (!this.episode) throw new Error("no active debug episode");
		if (this.episode.attemptedAt)
			throw new Error("debug recovery was already attempted");
		if (!this.episode.diagnosis.recoveries.some((r) => r.id === recoveryId))
			throw new Error("unknown recovery selection");
		this.episode.selectedRecoveryId = recoveryId;
		this.episode.attemptedAt = now;
		this.store?.save(this.episode);
		return this.episode;
	}
	record(result: DebugOperationResult): void {
		if (!this.episode || this.episode.result) return;
		this.episode.result = result;
		this.store?.save(this.episode);
	}
	getIssueReview():
		| import("./debug-issue.js").DebugIssueReviewState
		| undefined {
		return this.episode?.issueReview;
	}
	startIssueReview(
		draft: import("./debug-issue.js").DiagnosticIssueDraft,
	): import("./debug-issue.js").DebugIssueReviewState {
		if (!this.episode) throw new Error("no active debug episode");
		if (!this.episode.result)
			throw new Error("debug recovery must finish before issue review");
		if (!this.episode.issueReview) {
			this.episode.issueReview = { draft, revision: 0, history: [] };
			this.store?.save(this.episode);
		}
		return this.episode.issueReview;
	}
	recordIssueRevision(
		draft: import("./debug-issue.js").DiagnosticIssueDraft,
		instruction: string,
		at: string,
	): import("./debug-issue.js").DebugIssueReviewState {
		if (!this.episode?.issueReview)
			throw new Error("no active debug issue review");
		const current = this.episode.issueReview;
		const history = [
			...current.history,
			{
				at,
				instruction: redactSecrets(instruction).slice(0, 1000),
				previousDraftHash: createHash("sha256")
					.update(JSON.stringify(current.draft))
					.digest("hex"),
			},
		].slice(-20);
		this.episode.issueReview = {
			draft,
			revision: current.revision + 1,
			history,
		};
		this.store?.save(this.episode);
		return this.episode.issueReview;
	}
	cancel(): void {
		this.episode = undefined;
		this.store?.clear();
	}
}

export interface ExecuteDebugRecoveryDeps {
	readonly engine?: PlanEngineV2;
	readonly execution?: ExecutionHandle;
	readonly now?: () => string;
}

function assertBinding(
	recovery: DebugRecoveryProposal,
	deps: ExecuteDebugRecoveryDeps,
): void {
	if (
		recovery.basePlanFingerprint &&
		(!deps.engine ||
			planFingerprintV2(deps.engine.get()) !== recovery.basePlanFingerprint)
	)
		throw new Error("plan fingerprint changed since diagnosis");
	if (
		recovery.targetDeliverableId &&
		recovery.expectedGeneration !== undefined
	) {
		const node = deps.engine
			? findNodeV2(deps.engine.get(), recovery.targetDeliverableId)
			: null;
		const current =
			deps.execution?.getExecutor().getRunState(recovery.targetDeliverableId)
				?.generation ?? (node ? nodeSessionGeneration(node) : -1);
		if (current !== recovery.expectedGeneration)
			throw new Error(
				`worker generation changed: expected ${recovery.expectedGeneration}, found ${current}`,
			);
	}
}

export async function executeDebugRecovery(
	recovery: DebugRecoveryProposal,
	deps: ExecuteDebugRecoveryDeps,
): Promise<DebugOperationResult> {
	const attemptedAt = (deps.now ?? (() => new Date().toISOString()))();
	try {
		assertBinding(recovery, deps);
		const execution = deps.execution;
		const target = recovery.targetDeliverableId;
		switch (recovery.kind) {
			case "none":
				return {
					action: "none",
					attemptedAt,
					ok: true,
					detail: "No recovery action was performed.",
				};
			case "steer": {
				if (!execution || !target || !recovery.guidance)
					throw new Error("steering target or guidance is unavailable");
				if (!execution.steer(target, recovery.guidance))
					throw new Error("target worker is not connected");
				return {
					action: recovery.kind,
					attemptedAt,
					ok: true,
					detail: `Steering sent to ${target}; process and session were preserved.`,
				};
			}
			case "retry-activation": {
				if (!execution || !target)
					throw new Error("activation target is unavailable");
				const state = execution.getExecutor().getRunState(target);
				if (
					!state?.blocked?.startsWith("activation failed:") ||
					state.worktreePath !== undefined ||
					state.status !== "pending"
				)
					throw new Error(
						"deliverable is not in a retryable activation-failure state",
					);
				execution.getExecutor().unblockNode(target);
				await execution.tick();
				return {
					action: recovery.kind,
					attemptedAt,
					ok: true,
					detail: `Cleared the retryable activation block on ${target} and ticked the scheduler.`,
				};
			}
			case "restart-resume":
			case "restart-fresh": {
				if (!execution || !target)
					throw new Error("restart target is unavailable");
				const run =
					recovery.kind === "restart-resume"
						? execution.restartWorkerResume
						: execution.restartWorkerFresh;
				if (!run) throw new Error("worker restart API is unavailable");
				const result = await run.call(execution, target);
				if (!result.ok)
					throw new Error(result.error ?? "worker restart failed");
				return {
					action: recovery.kind,
					attemptedAt,
					ok: true,
					detail: `${target} restarted in ${result.mode} mode at generation ${result.generation}.`,
				};
			}
			case "repair": {
				if (
					!deps.engine ||
					!target ||
					!recovery.basePlanFingerprint ||
					!recovery.repairOperations?.length
				)
					throw new Error("repair proposal is incomplete");
				const worker = execution?.getExecutor().getRunState(target);
				if (
					worker &&
					["spawning", "working", "summarizing", "restarting"].includes(
						worker.status,
					)
				)
					throw new Error("affected deliverable is not stopped");
				const applied = deps.engine.applyTaskRepair({
					baseFingerprint: recovery.basePlanFingerprint,
					reason: recovery.repairReason ?? recovery.rationale,
					operations: recovery.repairOperations,
					stoppedDeliverableIds: [target],
				});
				const continuation = recovery.continuation ?? "none";
				if (continuation !== "none") {
					const next: DebugRecoveryProposal = {
						...recovery,
						kind: continuation,
						basePlanFingerprint: applied.fingerprint,
						repairOperations: undefined,
					};
					const continued = await executeDebugRecovery(next, deps);
					if (!continued.ok)
						throw new Error(
							`repair applied, continuation failed: ${continued.detail}`,
						);
				}
				return {
					action: recovery.kind,
					attemptedAt,
					ok: true,
					detail: `Applied atomic repair ${applied.auditId}; continuation=${continuation}.`,
				};
			}
		}
	} catch (error) {
		return {
			action: recovery.kind,
			attemptedAt,
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

function isRepairOperation(value: unknown): value is PlanRepairOperation {
	if (!value || typeof value !== "object") return false;
	const op = value as Record<string, unknown>;
	if (typeof op.type !== "string" || typeof op.deliverableId !== "string")
		return false;
	if (op.type === "clarifyTask")
		return (
			typeof op.taskId === "string" &&
			(typeof op.title === "string" || typeof op.body === "string")
		);
	if (op.type === "reopenTask") return typeof op.taskId === "string";
	if (op.type === "addCorrectiveTask" || op.type === "addManualCheckpoint") {
		const task = op.task as Record<string, unknown> | undefined;
		return Boolean(
			task &&
				typeof task.id === "string" &&
				typeof task.title === "string" &&
				(task.body === undefined || typeof task.body === "string"),
		);
	}
	return false;
}

export function validateWorkerDebugProposal(input: {
	message: DebugProposalMessage;
	authenticatedAgentId: string;
	engine?: PlanEngineV2;
	execution?: ExecutionHandle;
}):
	| { ok: true; recovery?: Omit<DebugRecoveryProposal, "id"> }
	| { ok: false; error: string } {
	const { message, authenticatedAgentId, engine, execution } = input;
	if (message.agentId !== authenticatedAgentId)
		return { ok: false, error: "debug proposal agent identity mismatch" };
	if (!engine || !execution)
		return { ok: false, error: "maestro execution is unavailable" };
	// v2: the authenticated agent key IS the node id; only worker nodes may
	// propose recovery (read agents have no workspace to repair).
	const deliverableId = authenticatedAgentId;
	const deliverable = findNodeV2(engine.get(), deliverableId);
	if (!deliverableId || deliverable?.agent !== "worker")
		return {
			ok: false,
			error: "only a worker node may propose debug recovery",
		};
	if (planFingerprintV2(engine.get()) !== message.planFingerprint)
		return { ok: false, error: "debug proposal plan fingerprint is stale" };
	const generation =
		execution.getExecutor().getRunState(deliverableId)?.generation ??
		nodeSessionGeneration(deliverable);
	if (generation !== message.generation)
		return {
			ok: false,
			error: `debug proposal generation is stale: expected ${generation}, got ${message.generation}`,
		};
	if (
		message.recovery?.targetDeliverableId &&
		message.recovery.targetDeliverableId !== deliverableId
	)
		return { ok: false, error: "worker may only target its own deliverable" };
	if (
		message.recovery?.kind === "repair" &&
		(!message.recovery.repairOperations?.length ||
			!message.recovery.repairOperations.every(isRepairOperation))
	)
		return {
			ok: false,
			error: "worker proposed an invalid or empty repair diff",
		};
	const recovery = message.recovery
		? {
				...message.recovery,
				targetDeliverableId: deliverableId,
				expectedGeneration: generation,
				basePlanFingerprint: message.planFingerprint,
				repairOperations: message.recovery.repairOperations as
					| readonly PlanRepairOperation[]
					| undefined,
			}
		: undefined;
	return { ok: true, ...(recovery ? { recovery } : {}) };
}

export function debugResultForError(
	message: DebugProposalMessage,
	error: string,
): DebugResultMessage {
	return {
		type: "debugResult",
		id: message.id,
		proposalId: message.proposalId,
		accepted: false,
		error,
	};
}

export async function askAndExecuteDebugRecovery(
	controller: DebugController,
	ask: AskCapabilityV1 | undefined,
	deps: ExecuteDebugRecoveryDeps,
): Promise<DebugOperationResult | undefined> {
	const episode = controller.get();
	if (!episode || episode.attemptedAt || !ask) return undefined;
	const answers = await ask.ask([renderRecoveryQuestion(episode)]);
	const answer = answers.find(
		(a: Answer) => a.questionId === `debug-recovery-${episode.id}`,
	);
	if (!answer || answer.deferred || !answer.value) {
		controller.cancel();
		return undefined;
	}
	const selected = episode.diagnosis.recoveries.find(
		(r) => r.id === answer.value,
	);
	if (!selected) {
		controller.cancel();
		return undefined;
	}
	controller.selectOnce(selected.id);
	const result = await executeDebugRecovery(selected, deps);
	controller.record(result);
	return result;
}

export function debugEpisodePath(planDir: string): string {
	return join(planDir, "debug", "active.json");
}

export function planForSnapshot(engine?: PlanEngineV2): PlanV2 | undefined {
	return engine?.get();
}
