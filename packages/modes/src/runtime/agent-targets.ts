import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentTarget,
	descendantsOf,
	resolveAgentTarget,
	type SubagentsCapabilityV1,
} from "@vegardx/pi-contracts";
import type { ExecutionHandle } from "../exec/index.js";

/** Build the single normalized control registry used by agent commands. */
export function listAgentTargets(input: {
	readonly execution?: ExecutionHandle;
	readonly subagents?: SubagentsCapabilityV1;
	readonly host?: ExtensionContext;
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
			updatedAt: Date.now(),
			capabilities: {
				view: Boolean(session),
				capture: Boolean(session),
				steer: true,
				interrupt: true,
				shutdown: true,
			},
		});
	}
	for (const run of input.subagents?.list() ?? []) {
		const metadata = run.metadata;
		const role = metadata?.role ?? run.profile.role ?? run.profile.profile;
		const displayName =
			metadata?.displayName ?? run.profile.displayName ?? `${role}-${run.id}`;
		targets.push({
			id: `run:${run.id}`,
			kind: "run",
			displayName,
			role,
			status: run.status,
			transport: metadata?.transport ?? run.profile.transport ?? "headless",
			...(run.parent ? { parentId: `run:${run.parent}` } : {}),
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
			capabilities: {
				view: Boolean(metadata?.tmuxSession),
				capture: Boolean(metadata?.tmuxSession),
				steer: ["queued", "running", "blocked"].includes(run.status),
				interrupt: ["queued", "running", "blocked"].includes(run.status),
				shutdown: true,
			},
		});
	}
	return targets;
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
