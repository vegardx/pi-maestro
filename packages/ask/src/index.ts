// @vegardx/pi-ask — the questionnaire engine. Provides:
//   * a blocking `ask` tool (the model asks the user, waits for answers);
//   * the ask.v1 capability (ask = blocking, queue = deferred) other
//     extensions resolve by id (modes plan gates, commit confirmations);
//   * a queued plan-mode driver: questions accumulated during a turn are
//     flushed as one combined dialog at turn_end.
//
// The engine renders through whatever ExtensionContext was last seen on a
// lifecycle event — captured below — since the capability methods carry none.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CAPABILITIES } from "@vegardx/pi-contracts";
import { defineExtension } from "@vegardx/pi-core";
import { AskEngine } from "./engine.js";
import { createAskTool } from "./tool.js";

export { AskEngine } from "./engine.js";
export { createAskTool } from "./tool.js";

export default defineExtension(
	{
		name: "ask",
		path: "packages/ask/src/index.ts",
		doc: "Questionnaire engine: blocking ask tool + queued plan-mode driver.",
	},
	(pi, maestro) => {
		const engine = new AskEngine();

		// Capture the freshest context so capability calls have a UI to render
		// through. These fire before any consumer would call ask().
		const capture = (_e: unknown, ctx: ExtensionContext) =>
			engine.setContext(ctx);
		pi.on("session_start", capture);
		pi.on("turn_start", capture);
		pi.on("input", capture);

		pi.registerTool(createAskTool(engine));

		maestro.capabilities.register(CAPABILITIES.ask, {
			ask: (questions) => engine.present(questions),
			queue: (questions) => engine.queue(questions),
		});

		// Plan-mode driver: flush whatever was queued as one dialog when the
		// turn ends, so nudges batch into a single interruption.
		pi.on("turn_end", async () => {
			if (engine.hasQueued) await engine.flush();
		});
	},
);
