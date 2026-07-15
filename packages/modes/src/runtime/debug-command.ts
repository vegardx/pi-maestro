import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { createIssue } from "@vegardx/pi-github";
import type { DebugProposalMessage, DebugResultMessage } from "@vegardx/pi-rpc";
import {
	askAndExecuteDebugRecovery,
	collectDebugSnapshot,
	DebugEpisodeStore,
	debugEpisodePath,
	debugResultForError,
	diagnoseDebugSnapshot,
	validateWorkerDebugProposal,
} from "../debug.js";
import {
	buildDiagnosticIssueDraft,
	type DebugIssueEvidence,
	reviewAndPostDiagnosticIssue,
} from "../debug-issue.js";
import { createDebugIssueReviser } from "../debug-reviser.js";
import { planFingerprint } from "../engine.js";
import { plansRoot } from "../storage.js";
import type { RuntimeContext } from "./context.js";

function configureStore(rt: RuntimeContext): void {
	const plan = rt.engine?.get();
	if (plan)
		rt.debug.setStore(
			new DebugEpisodeStore(debugEpisodePath(`${plansRoot()}/${plan.slug}`)),
		);
}

export function hydrateDebugEpisode(rt: RuntimeContext): void {
	configureStore(rt);
}

function snapshot(rt: RuntimeContext, ctx: ExtensionContext) {
	return collectDebugSnapshot({
		cwd: ctx.cwd,
		mode: rt.state.mode,
		executionStage: rt.state.execution.stage,
		activeDeliverableId: rt.state.execution.deliverableId,
		sessionPath: ctx.sessionManager.getSessionFile(),
		entries: ctx.sessionManager.getEntries(),
		engine: rt.engine,
		execution: rt.execution,
		planRoot: plansRoot(),
		agentId: process.env.PI_MAESTRO_AGENT_ID,
		now: rt.now,
	});
}

function issueEvidence(
	episode: NonNullable<ReturnType<RuntimeContext["debug"]["get"]>>,
): DebugIssueEvidence {
	const result = episode.result;
	if (!result) throw new Error("debug recovery result is unavailable");
	return {
		observed: episode.diagnosis.observed,
		likelyCause: episode.diagnosis.likelyCause,
		recentFailures: episode.snapshot.recentFailures.map(
			(failure) => `${failure.source}: ${failure.error}`,
		),
		runtime: {
			role: episode.snapshot.role.value,
			mode: episode.snapshot.mode.value,
			stage: episode.snapshot.execution.stage,
			cwd: episode.snapshot.cwd.value,
			...(episode.snapshot.sessionPath
				? { sessionPath: episode.snapshot.sessionPath.value }
				: {}),
			...(episode.snapshot.plan
				? { planSlug: episode.snapshot.plan.slug }
				: {}),
			...(episode.snapshot.execution.activeDeliverableId
				? {
						deliverableId: episode.snapshot.execution.activeDeliverableId,
					}
				: {}),
			...(episode.snapshot.worker
				? { generation: episode.snapshot.worker.generation }
				: {}),
			node: episode.snapshot.runtime.node,
			platform: episode.snapshot.runtime.platform,
			architecture: episode.snapshot.runtime.architecture,
			maestroRevision: episode.snapshot.runtime.maestroRevision,
		},
		recovery: {
			attemptedAction: result.action,
			attemptedAt: result.attemptedAt,
			status: result.ok ? "succeeded" : "failed",
			detail: result.detail,
		},
	};
}

async function reviewDebugIssue(
	rt: RuntimeContext,
	ctx: ExtensionContext,
): Promise<void> {
	const episode = rt.debug.get();
	if (!episode?.result) return;
	const evidence = issueEvidence(episode);
	const review = await reviewAndPostDiagnosticIssue({
		id: episode.id,
		controller: rt.debug,
		ask: rt.maestro.capabilities.get(CAPABILITIES.ask),
		reviser: createDebugIssueReviser(ctx),
		evidence,
		initialDraft: buildDiagnosticIssueDraft(evidence),
		post: (draft) =>
			createIssue(ctx.cwd, {
				title: draft.title,
				body: draft.body,
				target: {
					host: "github.com",
					owner: "vegardx",
					repo: "pi-maestro",
				},
			}),
		now: rt.now,
		onRevisionError: (error) => ctx.ui.notify(error, "warning"),
	});
	switch (review.status) {
		case "posted":
			ctx.ui.notify(
				review.url
					? `Created pi-maestro issue: ${review.url}`
					: "Created pi-maestro issue.",
				"info",
			);
			break;
		case "post-failed":
			ctx.ui.notify(
				`Recovery was not rolled back. GitHub issue creation failed and was not retried: ${review.error}`,
				"error",
			);
			break;
		case "canceled":
			ctx.ui.notify("Issue review canceled; nothing was posted.", "info");
			break;
		case "unavailable":
			ctx.ui.notify(review.error, "warning");
			break;
	}
}

export async function runDebugCommand(
	rt: RuntimeContext,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	configureStore(rt);
	const active = rt.debug.get();
	if (active?.result) {
		await reviewDebugIssue(rt, ctx);
		return;
	}
	const hint =
		args.trim() ||
		(await ctx.ui.input(
			"What is going wrong?",
			"Optional symptom or expected behavior...",
		));
	if (hint === undefined) {
		rt.debug.cancel();
		ctx.ui.notify("Debug canceled; no recovery was attempted.", "info");
		return;
	}
	const snap = snapshot(rt, ctx);
	const diagnosis = diagnoseDebugSnapshot(snap, hint);
	const episode = rt.debug.begin(snap, diagnosis);
	if (!episode) return;
	const result = await askAndExecuteDebugRecovery(
		rt.debug,
		rt.maestro.capabilities.get(CAPABILITIES.ask),
		{ engine: rt.engine, execution: rt.execution, now: rt.now },
	);
	if (!result) {
		ctx.ui.notify(
			"Debug deferred or canceled; no recovery was attempted.",
			"info",
		);
		return;
	}
	ctx.ui.notify(
		`${result.ok ? "Recovery completed" : "Recovery failed"}: ${result.detail}`,
		result.ok ? "info" : "warning",
	);
	await reviewDebugIssue(rt, ctx);
}

export function installDebugProposalHandler(
	rt: RuntimeContext,
	ctx: ExtensionContext,
): void {
	rt.execution?.setDebugProposalHandler?.(async (agentId, message) =>
		handleWorkerDebugProposal(rt, ctx, agentId, message),
	);
}

async function handleWorkerDebugProposal(
	rt: RuntimeContext,
	ctx: ExtensionContext,
	agentId: string,
	message: DebugProposalMessage,
): Promise<DebugResultMessage> {
	const checked = validateWorkerDebugProposal({
		message,
		authenticatedAgentId: agentId,
		engine: rt.engine,
		execution: rt.execution,
	});
	if (!checked.ok) return debugResultForError(message, checked.error);
	configureStore(rt);
	const snap = snapshot(rt, ctx);
	const diagnosis = diagnoseDebugSnapshot(
		snap,
		message.likelyCause,
		checked.recovery,
	);
	const episode = rt.debug.begin(snap, diagnosis, message.proposalId);
	if (!episode)
		return debugResultForError(
			message,
			"duplicate debug proposal; no action repeated",
		);
	const result = await askAndExecuteDebugRecovery(
		rt.debug,
		rt.maestro.capabilities.get(CAPABILITIES.ask),
		{ engine: rt.engine, execution: rt.execution, now: rt.now },
	);
	if (result) await reviewDebugIssue(rt, ctx);
	return {
		type: "debugResult",
		id: message.id,
		proposalId: message.proposalId,
		accepted: Boolean(result),
		episodeId: episode.id,
		...(result
			? {
					recovery: {
						action: result.action,
						ok: result.ok,
						detail: result.detail,
					},
				}
			: { error: "user deferred or canceled; no recovery was attempted" }),
	};
}

/** Worker-side command: collect only local bounded facts and ask maestro. */
export async function runWorkerDebugCommand(
	rt: RuntimeContext,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const bridge = rt.agentBridge;
	const agentId = process.env.PI_MAESTRO_AGENT_ID;
	const generation = Number(process.env.PI_MAESTRO_GENERATION);
	const fingerprint = process.env.PI_MAESTRO_PLAN_FINGERPRINT;
	if (!bridge || !agentId || !Number.isInteger(generation) || !fingerprint) {
		ctx.ui.notify(
			"Maestro is unavailable. Copy this local guidance to the maestro: inspect the current worker session and workspace; no recovery was attempted.",
			"warning",
		);
		return;
	}
	const local = collectDebugSnapshot({
		cwd: ctx.cwd,
		mode: rt.state.mode,
		executionStage: rt.state.execution.stage,
		activeDeliverableId: agentId.split("/")[0],
		sessionPath: ctx.sessionManager.getSessionFile(),
		entries: ctx.sessionManager.getEntries(),
		agentId,
		now: rt.now,
	});
	const diagnosis = diagnoseDebugSnapshot(local, args);
	const recommendation = diagnosis.recoveries.find(
		(r) => r.id === diagnosis.recommendation,
	);
	const result = await bridge.proposeDebug({
		generation,
		planFingerprint: fingerprint,
		observed: diagnosis.observed,
		likelyCause: diagnosis.likelyCause,
		...(recommendation ? { recovery: recommendation } : {}),
	});
	ctx.ui.notify(
		result.recovery
			? `Maestro recovery result: ${result.recovery.detail}`
			: `Local debug proposal not applied: ${result.error ?? "no result"}`,
		result.recovery?.ok ? "info" : "warning",
	);
}

export function currentPlanFingerprint(rt: RuntimeContext): string | undefined {
	return rt.engine ? planFingerprint(rt.engine.get()) : undefined;
}
