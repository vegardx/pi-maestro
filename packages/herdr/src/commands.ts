// Typed command wrappers for herdr CLI operations.

import { herdrExec, herdrExecRaw } from "./exec.js";
import type {
	AgentInfo,
	PaneReadOptions,
	WorktreeCreateOptions,
	WorktreeCreateResult,
	WorktreeRemoveOptions,
} from "./types.js";

// --- Worktree ---

export async function worktreeCreate(
	opts: WorktreeCreateOptions,
): Promise<WorktreeCreateResult> {
	const args = ["worktree", "create", "--cwd", opts.cwd, "--json"];
	if (opts.branch) args.push("--branch", opts.branch);
	if (opts.base) args.push("--base", opts.base);
	if (opts.label) args.push("--label", opts.label);
	if (opts.focus === true) args.push("--focus");
	if (opts.focus === false) args.push("--no-focus");
	return herdrExec<WorktreeCreateResult>(args);
}

export async function worktreeRemove(
	opts: WorktreeRemoveOptions,
): Promise<void> {
	const args = ["worktree", "remove", "--workspace", opts.workspaceId];
	if (opts.force) args.push("--force");
	args.push("--json");
	await herdrExec(args);
}

// --- Pane ---

export async function paneRun(paneId: string, command: string): Promise<void> {
	await herdrExec(["pane", "run", paneId, command]);
}

export async function paneRead(
	paneId: string,
	opts?: PaneReadOptions,
): Promise<string> {
	const args = ["pane", "read", paneId];
	if (opts?.source) args.push("--source", opts.source);
	if (opts?.lines) args.push("--lines", String(opts.lines));
	return herdrExecRaw(args);
}

export async function paneSendText(
	paneId: string,
	text: string,
): Promise<void> {
	await herdrExec(["pane", "send-text", paneId, text]);
}

export async function paneClose(paneId: string): Promise<void> {
	await herdrExec(["pane", "close", paneId]);
}

// --- Agent ---

export async function agentSend(target: string, text: string): Promise<void> {
	await herdrExec(["agent", "send", target, text]);
}

export async function agentRead(
	target: string,
	opts?: PaneReadOptions,
): Promise<string> {
	const args = ["agent", "read", target];
	if (opts?.source) args.push("--source", opts.source);
	if (opts?.lines) args.push("--lines", String(opts.lines));
	return herdrExecRaw(args);
}

export async function agentList(): Promise<AgentInfo[]> {
	const result = await herdrExec<{ agents?: AgentInfo[] }>(["agent", "list"]);
	return result?.agents ?? [];
}

export async function agentFocus(target: string): Promise<void> {
	await herdrExec(["agent", "focus", target]);
}

export async function agentRename(target: string, name: string): Promise<void> {
	await herdrExec(["agent", "rename", target, name]);
}

export async function agentWait(
	target: string,
	status: string,
	timeoutMs?: number,
): Promise<void> {
	const args = ["agent", "wait", target, "--status", status];
	if (timeoutMs) args.push("--timeout", String(timeoutMs));
	await herdrExec(args, { timeout: (timeoutMs ?? 300_000) + 5_000 });
}

// --- Workspace ---

export async function workspaceFocus(workspaceId: string): Promise<void> {
	await herdrExec(["workspace", "focus", workspaceId]);
}

export async function workspaceClose(workspaceId: string): Promise<void> {
	await herdrExec(["workspace", "close", workspaceId]);
}
