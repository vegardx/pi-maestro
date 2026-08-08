/** Legacy environment names are denied at the workflow boundary. */
export const DEPTH_ENV = "PI_MAESTRO_DEPTH";
export const SOCK_ENV = "PI_MAESTRO_SOCK";
export const TOKEN_ENV = "PI_MAESTRO_TOKEN";
export const AGENT_ID_ENV = "PI_MAESTRO_AGENT_ID";

export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[DEPTH_ENV];
	if (!raw) return 0;
	const parsed = Number.parseInt(raw, 10);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}
