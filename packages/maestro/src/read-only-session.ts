// Opening a read-only child over pi's own RPC.
//
// Kept out of the entry point on purpose: an extension's entry builds
// module-lifetime singletons, so anything that imports it inherits them. This
// is the one piece of the agent surface the maestro side also needs, and it has
// no business dragging a registration side effect along with it.

import { RpcClient } from "@earendil-works/pi-coding-agent";
import {
	buildReadOnlyInvocation,
	currentPiCommand,
	type ReadOnlySessionFactory,
	type ReadOnlySpawn,
} from "./spawn.js";

export interface ReadOnlyLaunchOptions {
	readonly extensions: readonly string[];
	/**
	 * Which pi to start. Defaults to the one THIS process is running, for the
	 * same reason a worker does: left to resolve `pi` itself, a child started
	 * from a worktree finds a shim symlinked at `../dist/cli.js` and dies with
	 * MODULE_NOT_FOUND. A live drive hit it on the worker path first; this is
	 * the same bug in the reader path, and both were fixed by the same rule —
	 * an agent runs the pi its maestro is running.
	 */
	readonly cliPath?: string;
	readonly model?: string;
	readonly agentDir?: string;
}

/** How often to check whether the child died while we waited on its turn. */
const DEAD_POLL_MS = 250;

/**
 * Resolve when the child's turn settles, or reject when the child dies.
 *
 * `RpcClient.prompt` returns as soon as the message is SENT, which is the whole
 * reason this exists: reading the last assistant text straight after it reads a
 * turn that has not happened, and the answer is empty. A live drive found this
 * the expensive way — a reviewer that had genuinely been asked appeared to have
 * returned nothing.
 *
 * The death poll is not belt-and-braces either: `RpcClient` rejects outstanding
 * requests when its child exits but never tells `onEvent` subscribers, so a
 * child dying with no request in flight would leave a bare event wait hanging
 * for good.
 */
function settled(client: RpcClient): Promise<void> {
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const done = (): void => {
			if (timer) clearInterval(timer);
			unsubscribe();
		};
		const unsubscribe = client.onEvent((event) => {
			if (event.type === "agent_settled") {
				done();
				resolve();
			}
		});
		timer = setInterval(() => {
			const error = (client as unknown as { exitError?: Error | null })
				.exitError;
			if (error) {
				done();
				reject(error);
			}
		}, DEAD_POLL_MS);
	});
}

/**
 * Open a read-only child over pi's own RPC.
 *
 * The wrapper is thin but not optional: `prompt` has to mean "the turn is
 * over", because `askReadOnly` reads the answer the moment it returns.
 */
export function createReadOnlySessionFactory(
	options: ReadOnlyLaunchOptions,
): ReadOnlySessionFactory {
	return async (spawn: ReadOnlySpawn) => {
		const invocation = buildReadOnlyInvocation(spawn, options);
		const client = new RpcClient({
			cwd: invocation.cwd,
			args: [...invocation.args],
			env: invocation.env,
			...(invocation.model ? { model: invocation.model } : {}),
			cliPath: options.cliPath ?? (currentPiCommand()[1] as string),
		});
		return {
			start: () => client.start(),
			prompt: async (text: string) => {
				const turn = settled(client);
				await client.prompt(text);
				await turn;
			},
			getLastAssistantText: () => client.getLastAssistantText(),
			stop: () => client.stop(),
		};
	};
}
