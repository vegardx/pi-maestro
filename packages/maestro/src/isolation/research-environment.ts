import { resolve } from "node:path";
import type { ResearchWorkspace } from "./workspace.js";

const CONTROL_ENV =
	/^(?:PI_MAESTRO_|TMUX(?:_|$)|SSH_AUTH_SOCK$|GPG_AGENT_INFO$)/u;
const SECRET_ENV =
	/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|COOKIE|AUTH$)/iu;
const SAFE_ENV =
	/^(?:PATH|LANG|LC_[A-Z_]+|TERM|COLORTERM|CI|NO_COLOR|FORCE_COLOR|SHELL|EDITOR|VISUAL|TZ|NODE_OPTIONS)$/u;

/** Construct a research child environment from an allowlist, never a denylist. */
export function createResearchEnvironment(
	base: NodeJS.ProcessEnv,
	requested: NodeJS.ProcessEnv | undefined,
	workspace: ResearchWorkspace,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	// The Pi tool supplies a resolved shell environment. It is authoritative;
	// falling back to the controller environment is only for direct adapter use.
	const sources = requested ? [requested] : [base];
	for (const source of sources) {
		for (const [key, value] of Object.entries(source)) {
			if (
				value !== undefined &&
				SAFE_ENV.test(key) &&
				!CONTROL_ENV.test(key) &&
				!SECRET_ENV.test(key)
			)
				env[key] = value;
		}
	}
	return {
		...env,
		HOME: workspace.home,
		TMPDIR: workspace.tmp,
		TMP: workspace.tmp,
		TEMP: workspace.tmp,
		XDG_CACHE_HOME: workspace.cache,
		XDG_CONFIG_HOME: resolve(workspace.home, ".config"),
		XDG_DATA_HOME: resolve(workspace.home, ".local", "share"),
		NPM_CONFIG_CACHE: resolve(workspace.cache, "npm"),
		YARN_CACHE_FOLDER: resolve(workspace.cache, "yarn"),
		PNPM_HOME: resolve(workspace.home, ".local", "share", "pnpm"),
		GIT_TERMINAL_PROMPT: "0",
		GH_PROMPT_DISABLED: "1",
		PAGER: "cat",
		GIT_PAGER: "cat",
		MAESTRO_RESEARCH_ISOLATION: "lightweight",
	};
}
