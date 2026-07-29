// The extension entry.
//
// One process runs either a maestro or a worker, and which one is decided here,
// from the environment, once. The old system had a `disableExtensions` env kill
// switch for this: a child was told which parts of its parent to switch off,
// which meant the parent had to remember to tell it, and a forgotten entry gave
// a worker the maestro's whole surface. Here the surface is not switched off —
// it is never registered, because this process knows what it is.
//
// Registration is synchronous and the connection is not. Tools go in at load
// time, before pi has finished starting, and the link resolves behind them; a
// tool called before the handshake completes says so, instead of hanging.

import { defineExtension } from "@vegardx/pi-core";
import {
	type AgentWiring,
	declareAgentTools,
	dialHome,
	type Reporter,
	readWiring,
} from "./agent-runtime.js";
import type { AgentLink } from "./link.js";
import {
	createReadOnlySessionFactory,
	type ReadOnlyLaunchOptions,
} from "./read-only-session.js";
import { ToolRegistry } from "./tool-registry.js";

/**
 * Register the agent surface and start dialling home.
 *
 * Exported so a test can hand it a fake `pi` — the alternative is asserting on
 * a module's load-time side effects, which is how an entry point becomes the
 * thing nobody dares change.
 */
export function startWorker(
	pi: { registerTool(tool: unknown): void },
	wiring: AgentWiring,
	launch: ReadOnlyLaunchOptions,
): Promise<AgentLink> {
	let link: AgentLink | undefined;

	const reporter = (): Reporter => {
		if (!link)
			throw new Error(
				"not connected to maestro yet — the handshake has not completed",
			);
		return link;
	};

	const registry = ToolRegistry.declare(
		declareAgentTools({
			reporter,
			delegate: {
				cwd: () => process.cwd(),
				depth: () => wiring.depth,
				openSession: createReadOnlySessionFactory(launch),
				briefFor: (agent, persona) =>
					`You are a ${agent}. Persona: ${persona}.`,
			},
		}),
	);

	// A worker holds worker tools. There is no list to keep in step with this
	// one — the holder is the whole selector.
	for (const tool of registry.definitionsFor("worker")) pi.registerTool(tool);

	return dialHome(wiring).then((connected) => {
		link = connected;
		connected.status("working");
		return connected;
	});
}

export default defineExtension(
	{
		name: "maestro",
		path: "packages/maestro/src/extension.ts",
		doc: "Plans as a DAG of deliverables, workers that build them, and the maestro that owns both ends.",
	},
	(pi) => {
		const wiring = readWiring();
		// No wiring means no maestro to report to, so this is the seat. Its
		// surface — commands, narration, the executor — lands next; nothing is
		// registered here rather than registering something half-wired.
		if (!wiring) return;

		void startWorker(pi, wiring, {
			extensions: [],
		});
	},
);
