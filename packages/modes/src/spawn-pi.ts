import { spawn } from "node:child_process";

export interface SpawnResult {
	stdout: string;
	exitCode: number;
}

export type SpawnFn = (
	args: string[],
	opts: { cwd: string },
) => Promise<SpawnResult>;

/**
 * Spawn `pi` with the maestro env stripped and extensions/session disabled,
 * so a child pi can never load the orchestrator extension or become a rogue
 * agent. The single choke point for child-pi hygiene.
 */
export const spawnCleanPi: SpawnFn = (args, opts) => {
	const env = { ...process.env };
	delete env.PI_MAESTRO_SOCK;
	delete env.PI_MAESTRO_AGENT_ID;
	return new Promise((resolve) => {
		const child = spawn("pi", ["-ne", "--no-session", ...args], {
			cwd: opts.cwd,
			env,
			stdio: ["ignore", "pipe", "ignore"],
		});
		let stdout = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (c: string) => {
			stdout += c;
		});
		child.on("error", () => resolve({ stdout: "", exitCode: -1 }));
		child.on("close", (code) => resolve({ stdout, exitCode: code ?? 0 }));
	});
};
