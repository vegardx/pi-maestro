// Opening a read-only child over pi's own RPC.
//
// Kept out of the entry point on purpose: an extension's entry builds
// module-lifetime singletons, so anything that imports it inherits them. This
// is the one piece of the agent surface the maestro side also needs, and it has
// no business dragging a registration side effect along with it.

import { RpcClient } from "@earendil-works/pi-coding-agent";
import {
	buildReadOnlyInvocation,
	type ReadOnlySessionFactory,
	type ReadOnlySpawn,
} from "./spawn.js";

export interface ReadOnlyLaunchOptions {
	readonly extensions: readonly string[];
	readonly cliPath?: string;
	readonly model?: string;
	readonly agentDir?: string;
}

/**
 * Open a read-only child over pi's own RPC.
 *
 * `RpcClient` already has the four methods a read-only run needs, so there is
 * nothing to adapt — the narrow `ReadOnlySession` interface exists so the
 * calling code can be tested without a child process, not because the real
 * thing needs wrapping.
 */
export function createReadOnlySessionFactory(
	options: ReadOnlyLaunchOptions,
): ReadOnlySessionFactory {
	return async (spawn: ReadOnlySpawn) => {
		const invocation = buildReadOnlyInvocation(spawn, options);
		return new RpcClient({
			cwd: invocation.cwd,
			args: [...invocation.args],
			env: invocation.env,
			...(invocation.model ? { model: invocation.model } : {}),
			...(options.cliPath ? { cliPath: options.cliPath } : {}),
		});
	};
}
