// The persona-command registration loop: a maestro slash command is registered
// for every agent kind that declares a `command`, and only those. The generic
// handler itself spawns a real persona (needs a live model), so it is exercised
// by the e2e/dogfood path, not here — this pins the wiring that decides *which*
// commands exist.

import { CAPABILITIES } from "@vegardx/pi-contracts";
import { describe, expect, it } from "vitest";
import { registerPersonaCommands } from "../packages/modes/src/runtime/commands.js";
import type { RuntimeContext } from "../packages/modes/src/runtime/context.js";

function kind(id: string, command?: unknown): unknown {
	return {
		id,
		routingSummary: "",
		prompt: "",
		runtimePolicy: "review",
		modelRole: id,
		contracts: [],
		watchdog: {},
		sequencing: { mode: "parallel", guidance: "" },
		reducer: "identity",
		...(command ? { command } : {}),
	};
}

function fakeRt(kinds: unknown[] | undefined): {
	rt: RuntimeContext;
	registered: { name: string; description: string }[];
} {
	const registered: { name: string; description: string }[] = [];
	const rt = {
		pi: {
			registerCommand: (name: string, spec: { description: string }) =>
				registered.push({ name, description: spec.description }),
		},
		maestro: {
			capabilities: {
				get: (id: string) =>
					id === CAPABILITIES.agents && kinds
						? { kinds: () => kinds }
						: undefined,
			},
		},
	};
	return { rt: rt as unknown as RuntimeContext, registered };
}

describe("persona-command registration", () => {
	it("registers a command for kinds that declare one, and skips the rest", () => {
		const { rt, registered } = fakeRt([
			kind("correctness-review", {
				name: "code-review",
				description: "Review code changes for correctness.",
				instruction: "…",
			}),
			kind("worker"), // no command
			kind("general"), // no command
		]);
		registerPersonaCommands(rt);
		expect(registered).toEqual([
			{
				name: "code-review",
				description: "Review code changes for correctness.",
			},
		]);
	});

	it("is a no-op when the agents capability is absent", () => {
		const { rt, registered } = fakeRt(undefined);
		registerPersonaCommands(rt);
		expect(registered).toEqual([]);
	});
});
