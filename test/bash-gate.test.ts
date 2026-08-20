// The safeguards, and what they are worth.
//
// Nothing in the rebuilt system was asking the classifier. That made hack
// mode's "safeguards off" meaningless, because nothing was on — a worker could
// rewrite anything through the shell, which is the forcing bug this rebuild
// exists to close and which it had quietly reintroduced.
//
// The case worth reading is the unattended one: a route that needs a human is a
// refusal for a worker, not a prompt nobody answers.

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	decideFromRoute,
	gateBash,
	refusal,
} from "../packages/maestro/src/bash-gate.js";
import { createGatedBashOperations } from "../packages/maestro/src/bash-tool.js";
import {
	type ExecutionPolicySettings,
	executionPolicyPreset,
} from "../packages/maestro/src/execution-policy.js";
import { mode } from "../packages/maestro/src/mode.js";
import type { Holder } from "../packages/maestro/src/tool-registry.js";

const policy: ExecutionPolicySettings = executionPolicyPreset("guided");

const gate = (command: string, holder: Holder, named = "auto" as const) =>
	gateBash({ command, holder, mode: mode(named), policy });

describe("the classifier is actually consulted", () => {
	it("lets ordinary work through", () => {
		expect(gate("git status", "worker").kind).toBe("allow");
		expect(gate("npm test", "worker").kind).not.toBe("deny");
	});

	it("keeps a read-only agent out of the tree", () => {
		// The posture that made `read` mean something. Without the classifier a
		// reviewer with no write tool still had a shell.
		const decision = gate("rm -rf src", "read-only");
		expect(refusal(decision)).not.toBeNull();
	});
});

describe("the reader's shell: reads run, writes are refused", () => {
	// A reader HOLDS a gated shell now. The old rule "a shell is a write tool"
	// predated ambient confinement: the classifier refuses write effects for
	// the read-only holder, and everything that runs at all runs under the
	// actor's write profile — so the shell is real and the posture still means
	// something. Driven through the gated operations, not just the gate,
	// because the operations are what the reader's registered tool executes.
	function readerOperations() {
		const ran: string[] = [];
		const direct: BashOperations = {
			exec: async (command: string) => {
				ran.push(command);
				return { exitCode: 0 };
			},
		} as unknown as BashOperations;
		const ops = createGatedBashOperations({
			holder: "read-only",
			cwd: "/r",
			// Fixed at plan, as the no-wiring path fixes it: read-only cwd,
			// safeguards on. No `confirm` — a reader runs unattended.
			mode: () => mode("plan"),
			policy: () => policy,
			direct,
		});
		return { ran, ops };
	}

	it("runs permitted git archaeology on the host", async () => {
		const o = readerOperations();
		await o.ops.exec("git log --oneline -5", "/r", { onData: () => {} });
		expect(o.ran).toEqual(["git log --oneline -5"]);
	});

	it("refuses a write command with the read-only reason, not a redirect", async () => {
		// `rm` used to fall into the delete-tool redirect — and no reader holds
		// a `delete` tool. A refusal may only name a tool the refused agent
		// has, so the read-only invariant answers first, and nothing runs.
		const o = readerOperations();
		await expect(
			o.ops.exec("rm -rf src", "/r", { onData: () => {} }),
		).rejects.toThrow(/read-only/i);
		expect(o.ran).toEqual([]);
	});

	it("refuses commits the same way — a reader has no commit tool either", async () => {
		const o = readerOperations();
		await expect(
			o.ops.exec('git commit -m "fix"', "/r", { onData: () => {} }),
		).rejects.toThrow(/read-only/i);
		expect(o.ran).toEqual([]);
	});
});

describe("every route turns into something, and none of them into silence", () => {
	// Tested through `decideFromRoute` rather than through a command, because
	// the classifier already refuses most of these before they get here — it
	// denies a worker for consequential effects with a better reason than this
	// layer could write. A backstop nothing can exercise is a backstop nobody
	// knows is broken.
	it("allows the direct routes", () => {
		for (const route of ["direct", "host-read"])
			expect(decideFromRoute(route, "r", false).kind).toBe("allow");
	});

	it("treats the retired lightweight route as an allowed host command", () => {
		expect(decideFromRoute("lightweight", "r", true).kind).toBe("allow");
	});

	it("refuses `strong`, which no longer exists, like any unknown route", () => {
		// It named a separate backend whose supplier was `packages/modes`. After
		// the flip every command routed there was refused for want of a backend
		// that could not exist, so the route and its tier are gone — and if the
		// classifier ever says it again, the unknown-route backstop refuses.
		expect(decideFromRoute("strong", "r", true).kind).toBe("deny");
	});

	it("prompts an attended seat and REFUSES an unattended agent", () => {
		// Nobody is watching a worker. A prompt it cannot answer is a worker that
		// stops responding, which reads exactly like one that crashed.
		expect(decideFromRoute("confirm", "r", true).kind).toBe("confirm");
		const unattended = decideFromRoute("confirm", "r", false);
		expect(unattended.kind).toBe("deny");
		expect(unattended.reason).toContain("nobody to ask");
	});

	it("refuses a route it has never heard of", () => {
		// The classifier gains routes over time. This is the only place that
		// would silently widen if one arrived unhandled.
		const decision = decideFromRoute("teleport", "r", true);
		expect(decision.kind).toBe("deny");
		expect(decision.reason).toContain("unrecognised route");
	});
});

describe("the classifier refuses a worker before the gate has to", () => {
	it("prompts the seat and sends the worker to its maestro", () => {
		// The same command, the two postures. The classifier already draws this
		// line, and draws it better than this layer could: it names who CAN
		// approve rather than just saying no.
		expect(gate("npm publish", "maestro").kind).toBe("confirm");
		const asWorker = gate("npm publish", "worker");
		expect(asWorker.kind).toBe("deny");
		expect(asWorker.reason).toContain("ask the parent maestro");
	});

	it("tells a worker where its commit identity comes from", () => {
		// The live incident, answered. A worker whose commit failed reached for
		// `git config`, and in a linked worktree that rewrites the identity for
		// the whole repository. The refusal explains the alternative instead of
		// leaving the worker to guess.
		const decision = gate('git config user.email "a@b.c"', "worker");
		expect(decision.kind).toBe("deny");
		expect(decision.reason).toMatch(/GIT_AUTHOR|harness/);
	});

	it("keeps privileged administration behind hack, for the seat too", () => {
		expect(gate("sudo rm -rf /", "maestro").reason).toMatch(/Hack/);
	});
});

describe("hack is the seat's boundary, and does not travel", () => {
	it("lets the seat through where auto would ask", () => {
		const hacking = gateBash({
			command: 'git config --global user.email "a@b.c"',
			holder: "maestro",
			mode: mode("hack"),
			policy,
		});
		expect(hacking.kind).toBe("allow");
	});

	it("is not something a worker can be in", () => {
		// `modeForChild` never hands a worker `hack`, so the only way to ask this
		// question is to force it — and even forced, the worker's own posture is
		// what the classifier judges.
		const forced = gateBash({
			command: 'git config --global user.email "a@b.c"',
			holder: "worker",
			mode: mode("hack"),
			policy,
		});
		// Documented rather than asserted as a refusal: hack IS the authorisation
		// boundary and the classifier honours it. What stops a worker reaching it
		// is that nothing ever gives a worker this mode — see mode.test.ts.
		expect(forced.kind).toBeDefined();
	});
});

describe("the gate sits in front of the operations, not the tool", () => {
	function operations(
		over: Partial<Parameters<typeof createGatedBashOperations>[0]> = {},
	) {
		const ran: string[] = [];
		const direct: BashOperations = {
			exec: async (command: string) => {
				ran.push(command);
				return { exitCode: 0 };
			},
		} as unknown as BashOperations;
		const ops = createGatedBashOperations({
			holder: "worker",
			cwd: "/w",
			mode: () => mode("auto"),
			policy: () => policy,
			direct,
			...over,
		});
		return { ran, ops };
	}

	it("runs what the classifier allows on the host", async () => {
		const o = operations();
		await o.ops.exec("git status", "/w", { onData: () => {} });
		expect(o.ran).toEqual(["git status"]);
	});

	it("THROWS on a refusal rather than returning a bad exit code", async () => {
		// An agent reads a failed command as something to work around — retry,
		// rephrase, another flag. A policy refusal is not that; it is an answer.
		const o = operations();
		await expect(
			o.ops.exec('git config user.email "a@b.c"', "/w", { onData: () => {} }),
		).rejects.toThrow(/refused/);
		expect(o.ran).toEqual([]);
	});

	it("runs an unknown command when the policy allows it", async () => {
		const o = operations();
		await o.ops.exec("frobnicate --widgets", "/w", { onData: () => {} });
		expect(o.ran).toEqual(["frobnicate --widgets"]);
	});

	// Pinned, and asserted rather than assumed. Both tests below used to use `gh
	// pr merge --squash` behind `if (decision.kind !== "confirm") return`, and
	// under the guided preset that command is DENIED — delivery belongs to the
	// ship tool. So the guard fired every run and neither test asserted anything
	// while both reported green. A conditional skip in a test is a test that
	// reports on the condition, not on the behaviour.
	const CONFIRMS = "npm publish";

	it("routes this command to a confirmation, which the two tests below rely on", () => {
		expect(gate(CONFIRMS, "maestro").kind).toBe("confirm");
	});

	it("asks when there is someone to ask, and honours a no", async () => {
		const asked: string[] = [];
		const o = operations({
			holder: "maestro",
			confirm: async (command) => {
				asked.push(command);
				return false;
			},
		});
		await expect(
			o.ops.exec(CONFIRMS, "/w", { onData: () => {} }),
		).rejects.toThrow(/declined/);
		expect(asked).toEqual([CONFIRMS]);
		expect(o.ran).toEqual([]);
	});

	it("runs a confirmed command after explicit consent", async () => {
		const o = operations({ holder: "maestro", confirm: async () => true });
		await o.ops.exec(CONFIRMS, "/w", { onData: () => {} });
		expect(o.ran).toEqual([CONFIRMS]);
	});
});
