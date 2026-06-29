// Public API for @vegardx/pi-herdr

export {
	agentFocus,
	agentList,
	agentRead,
	agentRename,
	agentSend,
	agentWait,
	paneClose,
	paneRead,
	paneRun,
	paneSendText,
	workspaceClose,
	workspaceFocus,
	worktreeCreate,
	worktreeRemove,
} from "./commands.js";
export { isHerdrAvailable } from "./detect.js";
export {
	type EventClientOptions,
	HerdrEventClient,
	resolveSocketPath,
} from "./events.js";
export { type ExecOptions, herdrExec, herdrExecRaw } from "./exec.js";
export {
	type AgentInfo,
	type AgentStatus,
	type AgentStatusChangedEvent,
	HerdrError,
	type HerdrEvent,
	type HerdrResult,
	type PaneReadOptions,
	type PaneReadSource,
	type Subscription,
	type WorktreeCreateOptions,
	type WorktreeCreateResult,
	type WorktreeRemoveOptions,
} from "./types.js";
