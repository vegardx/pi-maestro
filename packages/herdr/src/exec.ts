// Low-level CLI wrapper: exec herdr binary, parse JSON stdout.

import { execFile } from "node:child_process";
import { HerdrError } from "./types.js";

export interface ExecOptions {
	readonly cwd?: string;
	readonly timeout?: number;
}

/**
 * Execute a herdr CLI command and return parsed JSON result.
 * Throws HerdrError on herdr-level errors (JSON with error.code).
 * Throws Error on process-level failures (non-zero exit, timeout).
 */
export async function herdrExec<T = unknown>(
	args: readonly string[],
	options?: ExecOptions,
): Promise<T> {
	const { stdout, stderr } = await exec(args, options);
	const raw = stdout.trim() || stderr.trim();
	if (!raw) {
		return undefined as T;
	}
	let parsed: { result?: T; error?: { code?: string; message?: string } };
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Some commands (pane read) return plain text, not JSON.
		return raw as T;
	}
	if (parsed.error) {
		throw new HerdrError(
			parsed.error.code ?? "unknown",
			parsed.error.message ?? "unknown herdr error",
		);
	}
	return parsed.result as T;
}

/**
 * Execute herdr and return raw stdout/stderr (for commands that return text).
 */
export async function herdrExecRaw(
	args: readonly string[],
	options?: ExecOptions,
): Promise<string> {
	const { stdout } = await exec(args, options);
	return stdout;
}

function exec(
	args: readonly string[],
	options?: ExecOptions,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			"herdr",
			args as string[],
			{
				cwd: options?.cwd,
				timeout: options?.timeout ?? 30_000,
				maxBuffer: 10 * 1024 * 1024,
				env: process.env,
			},
			(error, stdout, stderr) => {
				if (error) {
					// Try to parse herdr JSON error from stderr/stdout.
					const raw = (stdout || stderr || "").trim();
					try {
						const parsed = JSON.parse(raw) as {
							error?: { code?: string; message?: string };
						};
						if (parsed.error) {
							reject(
								new HerdrError(
									parsed.error.code ?? "unknown",
									parsed.error.message ?? "unknown herdr error",
								),
							);
							return;
						}
					} catch {
						// Not JSON — fall through to generic error.
					}
					reject(
						new Error(
							`herdr ${args[0]} failed: ${error.message}${stderr ? `\n${stderr}` : ""}`,
						),
					);
					return;
				}
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
			},
		);
	});
}
