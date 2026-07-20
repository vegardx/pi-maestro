import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentTarget,
	descendantsOf,
	resolveAgentTarget,
	type SubagentsCapabilityV1,
	type WatchRecord,
} from "@vegardx/pi-contracts";
import type { ExecutionHandle } from "../exec/index.js";

/** The watch projection the target registry needs: list + cancel only —
 *  watches are subagents in the HUD sense, never attach/steer targets. */
export interface WatchTargetSource {
	list(): readonly WatchRecord[];
	cancel(id: string, reason?: string): boolean;
}

/** Clip a watch goal for one-line displays. */
export function clipWatchGoal(goal: string, max = 48): string {
	const flat = goal.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Build the single normalized control registry used by agent commands. */
export function listAgentTargets(input: {
	readonly execution?: ExecutionHandle;
	readonly subagents?: SubagentsCapabilityV1;
	readonly host?: ExtensionContext;
	readonly watches?: WatchTargetSource;
}): AgentTarget[] {
	const targets: AgentTarget[] = [];
	if (input.host) {
		const now = Date.now();
		targets.push({
			id: "host:current",
			kind: "host",
			displayName: "current",
			role: "maestro",
			status: input.host.isIdle() ? "idle" : "working",
			transport: "host",
			cwd: input.host.cwd,
			createdAt: now,
			updatedAt: now,
			capabilities: {
				view: false,
				capture: false,
				steer: false,
				interrupt: true,
				shutdown: true,
			},
		});
	}
	for (const [key, agent] of input.execution?.snapshot().agents ?? []) {
		const session = input.execution?.resolveSessionName(key);
		targets.push({
			id: `worker:${key}`,
			kind: "worker",
			displayName: key,
			role: key.split("/")[1] ?? "worker",
			status: agent.status,
			transport: "tmux",
			...(session ? { tmuxSession: session } : {}),
			model: agent.model,
			createdAt: agent.startedAt,
			updatedAt: agent.completedAt ?? Date.now(),
			...(agent.completedAt !== undefined
				? { completedAt: agent.completedAt }
				: {}),
			capabilities: {
				view: Boolean(session),
				capture: Boolean(session),
				steer: true,
				interrupt: true,
				shutdown: true,
			},
		});
	}
	const projected = input.execution?.projectedRuns?.() ?? [];
	const localRuns = input.subagents?.list() ?? [];
	const localIds = new Set(localRuns.map((run) => run.id));
	for (const run of [
		...localRuns,
		...projected.filter((run) => !localIds.has(run.id)),
	]) {
		const metadata = run.metadata;
		const role = metadata?.role ?? run.profile.role ?? run.profile.profile;
		const displayName =
			metadata?.displayName ?? run.profile.displayName ?? `${role}-${run.id}`;
		const projection = run.profile.meta as
			| { ownerId?: string; confirmed?: boolean; kind?: string }
			| undefined;
		const projectedOwner = projection?.ownerId;
		targets.push({
			id: `run:${run.id}`,
			kind: "run",
			agentKind: projection?.kind as AgentTarget["agentKind"],
			displayName,
			role,
			status: run.status,
			transport: metadata?.transport ?? run.profile.transport ?? "headless",
			...(projectedOwner
				? { parentId: `worker:${projectedOwner}` }
				: run.parent
					? { parentId: `run:${run.parent}` }
					: {}),
			rootTurnId: metadata?.rootTurnId ?? run.profile.rootTurnId,
			pid: metadata?.pid,
			processGroup: metadata?.processGroup,
			tmuxSession: metadata?.tmuxSession,
			tmuxPane: metadata?.tmuxPane,
			sessionFile: metadata?.sessionFile,
			cwd: metadata?.cwd ?? run.profile.cwd,
			model: run.profile.model,
			createdAt: run.createdAt,
			updatedAt: run.lastEventAt ?? run.updatedAt,
			...(run.completedAt !== undefined
				? { completedAt: run.completedAt }
				: {}),
			capabilities: {
				view: Boolean(metadata?.tmuxSession),
				capture: projection?.confirmed !== false,
				steer:
					projection?.confirmed !== false &&
					["queued", "starting", "running", "blocked"].includes(run.status),
				interrupt:
					projection?.confirmed !== false &&
					["queued", "starting", "running", "blocked"].includes(run.status),
				shutdown: projection?.confirmed !== false,
			},
		});
	}
	// Watches ride the same registry as rows "watch:<id>": status word, goal
	// (clipped), probe interval, refinement count. List + cancel only — no
	// attach, no steer; cancel maps to WatchManager.cancel via shutdown.
	for (const record of input.watches?.list() ?? []) {
		targets.push({
			id: `watch:${record.id}`,
			kind: "watch",
			displayName: clipWatchGoal(record.goal),
			role: "watch",
			status: record.status,
			transport: "headless",
			createdAt: Date.parse(record.createdAt),
			updatedAt: Date.parse(record.updatedAt),
			...(record.endedAt ? { completedAt: Date.parse(record.endedAt) } : {}),
			capabilities: {
				view: false,
				capture: false,
				steer: false,
				interrupt: false,
				shutdown: record.status === "active",
			},
		});
	}
	return targets;
}

export async function captureAgentTarget(
	target: AgentTarget,
	execution: ExecutionHandle | undefined,
	subagents: SubagentsCapabilityV1 | undefined,
	lines = 200,
): Promise<string | undefined> {
	if (target.kind === "worker") {
		const [deliverableId, name] = target.id.slice("worker:".length).split("/");
		return deliverableId
			? execution?.capture?.(deliverableId, name, lines)
			: undefined;
	}
	if (target.kind !== "run") return undefined;
	const runId = target.id.slice("run:".length) as never;
	const local = subagents?.list().find((run) => run.id === runId);
	return local
		? subagents?.capture?.(local.id, lines)
		: execution?.captureProjectedRun?.(runId, lines);
}

export async function stopAgentTarget(
	target: AgentTarget,
	execution: ExecutionHandle | undefined,
	subagents: SubagentsCapabilityV1 | undefined,
	reason = "user stop",
	watches?: WatchTargetSource,
): Promise<boolean> {
	if (target.kind === "watch") {
		return watches?.cancel(target.id.slice("watch:".length), reason) ?? false;
	}
	if (target.kind === "worker") {
		const [deliverableId, name] = target.id.slice("worker:".length).split("/");
		return deliverableId
			? ((await execution?.stop?.(deliverableId, name, reason)) ?? false)
			: false;
	}
	if (target.kind !== "run") return false;
	const runId = target.id.slice("run:".length) as never;
	const local = subagents?.list().find((run) => run.id === runId);
	if (local) {
		subagents?.stop(local.id, reason);
		return true;
	}
	return execution?.stopProjectedRun?.(runId, reason) ?? false;
}

export { descendantsOf, resolveAgentTarget };

export function renderTargetResolutionError(
	resolution: Exclude<ReturnType<typeof resolveAgentTarget>, { ok: true }>,
): string {
	if (resolution.reason === "not-found")
		return `No agent target matches "${resolution.selector}".`;
	return `Ambiguous agent target "${resolution.selector}": ${resolution.matches
		.map((target) => target.id)
		.join(", ")}. Use an exact opaque id.`;
}
