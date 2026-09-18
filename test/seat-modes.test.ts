// The plan tool is a posture, not a fixture.
//
// Plan mode is a conversation: the document is written on the way out, so the
// `plan` tool is withheld there and offered everywhere else — plus the exit
// window, which is the one moment plan mode holds it. The window has two
// moments now, because the exit no longer changes the mode to open it: a record
// with no agreed description holds `plan_intent` alone, and only an agreed one
// holds `plan`. The defect these tests stand against is the registry's own: a
// tool whose availability is decided in one place and remembered in another. So
// every case below asks the SAME predicate's question through a different door
// — the registry, the live tool set Pi holds, the block reason — and demands
// the same answer.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_INTENT_TOOL } from "../packages/maestro/src/authoring.js";
import {
	PLAN_MODE_RUN_REFUSAL,
	type SeatHost,
	seatToolBlockReason,
	startSeat,
} from "../packages/maestro/src/extension.js";
import type { ModeName } from "../packages/maestro/src/mode.js";
import {
	createSeat,
	type ExitWindow,
	intentToolAvailable,
	planToolAvailable,
} from "../packages/maestro/src/seat.js";
import { fakeHost } from "./fake-host.js";

const dirs: string[] = [];
afterEach(() => {
	for (const directory of dirs.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function temp(name: string): string {
	const path = mkdtempSync(join(tmpdir(), name));
	dirs.push(path);
	return path;
}

function seatOptions() {
	return { cwd: temp("maestro-cwd-"), agentDir: temp("maestro-agent-") };
}

/**
 * A host that keeps a live tool set, the way Pi does: `registerTool` has no
 * inverse, so withdrawal has to travel through `setActiveTools`. The seeded
 * names stand in for everything the seat does not own — Pi's own tools and the
 * workflow runtime's.
 */
function host(seed: readonly string[] = ["read", "workflow_run"]) {
	const registered: string[] = [];
	let active = [...seed];
	const commands = new Map<
		string,
		{ handler(args: string, ctx: unknown): Promise<void> }
	>();
	// Pi's loader stubs both action methods to throw until `Runner.bindCore()`
	// runs, after every extension has loaded. The fake keeps that rule.
	let bound = false;
	const notInitialized = () => {
		throw new Error(
			"Extension runtime not initialized. Action methods cannot be called during extension loading.",
		);
	};
	const pi: SeatHost = {
		registerTool: (tool) => registered.push((tool as { name: string }).name),
		registerCommand: (name, spec) =>
			commands.set(
				name,
				spec as { handler(args: string, ctx: unknown): Promise<void> },
			),
		getActiveTools: () => (bound ? [...active] : notInitialized()),
		setActiveTools: (names) => {
			if (!bound) notInitialized();
			active = [...names];
		},
	};
	return {
		pi,
		registered,
		bind: () => {
			bound = true;
		},
		active: () => [...active],
		mode: (args: string) => {
			const command = commands.get("mode");
			if (!command) throw new Error("no /mode registered");
			return command.handler(args, { ui: { notify() {} } });
		},
	};
}

/**
 * ONE HOST, TWO READERS. The `plan` tool refuses a document this session
 * cannot honour and the store refuses to save one; they are the same refusal,
 * so the seat hands both the same port. If they were given different ones, a
 * plan the tool accepted would throw out of `savePlan` — which is what this
 * asserts by storing one and refusing another through the tool alone.
 */
describe("one host answers for the plan tool and the store", () => {
	const pinned = (model: string) => ({
		slug: "arc",
		title: "Arc",
		deliverables: [
			{
				id: "api",
				title: "The API",
				tasks: [{ id: "build", title: "Build it" }],
				reviews: [{ lens: "c", model }],
			},
		],
	});

	const planTool = (seat: ReturnType<typeof createSeat>) => {
		seat.setMode("auto");
		const definition = seat.tools
			.definitionsFor("maestro")
			.find((tool) => tool.name === "plan");
		if (!definition) throw new Error("no plan tool");
		return (document: unknown) =>
			(
				definition.execute as unknown as (
					id: string,
					p: unknown,
				) => Promise<{
					content: { text: string }[];
					details: { stored: boolean; errors: readonly string[] };
				}>
			)("call-1", document);
	};

	it("stores what the host has and refuses what it does not", async () => {
		// A real repository, because `repos` defaults to the seat's cwd and a
		// plan's repository path is checked against the world.
		const cwd = temp("maestro-seat-repo-");
		execFileSync("git", ["init", "--quiet"], { cwd, stdio: "ignore" });
		const seat = createSeat({
			cwd,
			agentDir: temp("maestro-agent-"),
			host: () => fakeHost({ models: ["anthropic/opus-5"] }),
		});
		const write = planTool(seat);

		const stored = await write(pinned("anthropic/opus-5"));
		expect(stored.details.stored).toBe(true);
		expect(seat.store.loadPlan("arc")?.deliverables[0]?.reviews).toEqual([
			{ lens: "c", model: "anthropic/opus-5" },
		]);

		const refused = await write(pinned("anthropic/opus-9"));
		expect(refused.details.stored).toBe(false);
		expect(refused.details.errors.join("\n")).toContain(
			"is not a model this host has",
		);
	});

	// A seat with no host is every seat in a test and every headless check.
	// It refuses a pin rather than storing what nothing verified.
	it("refuses a pinned model when the seat was built without a host", async () => {
		const cwd = temp("maestro-seat-repo-");
		execFileSync("git", ["init", "--quiet"], { cwd, stdio: "ignore" });
		const seat = createSeat({ cwd, agentDir: temp("maestro-agent-") });

		const refused = await planTool(seat)(pinned("anthropic/opus-5"));
		expect(refused.details.stored).toBe(false);
		expect(refused.details.errors.join("\n")).toContain(
			"there is no model catalogue here to check it against",
		);
	});
});

describe("the plan tool by mode", () => {
	it("is withheld in plan mode and held in auto and hack", () => {
		const seat = createSeat(seatOptions());

		expect(seat.mode().name).toBe("plan");
		expect(seat.tools.grantsFor("maestro")).toEqual(["bash", "delete"]);
		expect(seat.planToolAvailable()).toBe(false);

		for (const name of ["auto", "hack"] as const) {
			seat.setMode(name);
			expect(seat.tools.grantsFor("maestro")).toEqual([
				"bash",
				"delete",
				"plan",
			]);
			expect(seat.planToolAvailable()).toBe(true);
		}

		seat.setMode("plan");
		expect(seat.tools.grantsFor("maestro")).toEqual(["bash", "delete"]);
	});

	it("says the same thing through every door the registry has", () => {
		const seat = createSeat(seatOptions());
		const doors = () => ({
			grants: [...seat.tools.grantsFor("maestro")],
			definitions: seat.tools.definitionsFor("maestro").map(({ name }) => name),
			described: seat.tools.describeFor("maestro").includes("- plan —"),
		});

		expect(doors()).toEqual({
			grants: ["bash", "delete"],
			definitions: ["bash", "delete"],
			described: false,
		});
		seat.setMode("auto");
		expect(doors()).toEqual({
			grants: ["bash", "delete", "plan"],
			definitions: ["bash", "delete", "plan"],
			described: true,
		});
	});

	it("keeps the may-hold list static — availability is the moving half", () => {
		const seat = createSeat(seatOptions());
		expect(seat.tools.declaredFor("maestro")).toEqual([
			"bash",
			"delete",
			"plan",
			PLAN_INTENT_TOOL,
		]);
		expect(seat.tools.names()).toEqual([
			"bash",
			"delete",
			"plan",
			PLAN_INTENT_TOOL,
		]);
		seat.setMode("auto");
		expect(seat.tools.declaredFor("maestro")).toEqual([
			"bash",
			"delete",
			"plan",
			PLAN_INTENT_TOOL,
		]);
		// Identity never depended on the posture: resolving a withheld tool by
		// name still works, which is what keeps the refusal specific.
		seat.setMode("plan");
		expect(seat.tools.has("plan")).toBe(true);
		expect(seat.tools.require("plan").definition.name).toBe("plan");
	});
});

describe("the exit window", () => {
	it("is the one moment plan mode holds the tool, and only once agreed", () => {
		// mode, window, `plan`, `plan_intent`.
		const table: [ModeName, ExitWindow, boolean, boolean][] = [
			["plan", "none", false, false],
			["plan", "intent", false, true],
			["plan", "plan", true, true],
			["auto", "none", true, false],
			["auto", "intent", true, true],
			["auto", "plan", true, true],
			["hack", "none", true, false],
			["hack", "intent", true, true],
			["hack", "plan", true, true],
		];
		for (const [mode, window, plan, intent] of table)
			expect([
				mode,
				window,
				planToolAvailable(mode, window),
				intentToolAvailable(mode, window),
			]).toEqual([mode, window, plan, intent]);
	});

	it("reaches the registry through the injected record", () => {
		let window: ExitWindow = "none";
		const seat = createSeat({ ...seatOptions(), exitWindow: () => window });
		const grants = () => seat.tools.grantsFor("maestro");

		expect(grants()).not.toContain("plan");
		expect(grants()).not.toContain(PLAN_INTENT_TOOL);
		// The exit flow writes its pending record and `plan_intent` appears
		// without the mode having moved. `plan` does not: there is nothing yet
		// for a blind reviewer to check a plan against.
		window = "intent";
		expect(grants()).not.toContain("plan");
		expect(grants()).toContain(PLAN_INTENT_TOOL);
		expect(seat.planToolAvailable()).toBe(false);
		expect(seat.intentToolAvailable()).toBe(true);
		// The description is agreed, and the window opens.
		window = "plan";
		expect(grants()).toContain("plan");
		expect(seat.planToolAvailable()).toBe(true);
		window = "none";
		expect(grants()).not.toContain("plan");
		expect(grants()).not.toContain(PLAN_INTENT_TOOL);
	});

	it("defends the tool call itself, in case a host kept a stale set", () => {
		expect(seatToolBlockReason("plan", "plan")).toContain("not held in plan");
		// The refusal names the step that is missing, not only the tool.
		expect(seatToolBlockReason("plan", "plan", "intent")).toContain(
			"`plan_intent`",
		);
		expect(seatToolBlockReason("plan", "plan", "plan")).toBeUndefined();
		expect(seatToolBlockReason("auto", "plan")).toBeUndefined();
		expect(seatToolBlockReason("hack", "plan")).toBeUndefined();
		// `plan_intent` belongs to the exit in every posture, not to auto/hack.
		for (const mode of ["plan", "auto", "hack"] as const) {
			expect(seatToolBlockReason(mode, PLAN_INTENT_TOOL)).toContain(
				"plan-mode exit",
			);
			expect(
				seatToolBlockReason(mode, PLAN_INTENT_TOOL, "intent"),
			).toBeUndefined();
			expect(
				seatToolBlockReason(mode, PLAN_INTENT_TOOL, "plan"),
			).toBeUndefined();
		}
	});
});

describe("Pi's live tool set follows the mode", () => {
	it("adds and withdraws `plan` on /mode, registering it once", async () => {
		const h = host();
		const entry = startSeat(h.pi, seatOptions());
		entry.seat();

		// Loading registers and touches nothing else: the live set is Pi's until
		// the runtime is bound, and reading it before then throws.
		expect(h.registered).toEqual(["bash", "delete"]);
		h.bind();
		expect(h.active()).toEqual(["read", "workflow_run"]);
		entry.runtimeBound();
		expect(h.active()).toEqual(["read", "workflow_run", "bash", "delete"]);

		await h.mode("auto");
		expect(h.registered).toEqual(["bash", "delete", "plan"]);
		expect(h.active()).toContain("plan");

		await h.mode("plan");
		expect(h.active()).not.toContain("plan");
		// A withdrawal is not a deregistration, and the return trip must not
		// register a second implementation of the same name.
		await h.mode("hack");
		expect(h.registered).toEqual(["bash", "delete", "plan"]);
		expect(h.active()).toContain("plan");
	});

	it("leaves every tool it does not declare alone, workflow tools included", async () => {
		const h = host(["read", "workflow_run", "workflow_validate", "plan_b"]);
		const entry = startSeat(h.pi, seatOptions());
		entry.seat();
		h.bind();
		entry.runtimeBound();

		const foreign = () =>
			h.active().filter((name) => !["bash", "delete", "plan"].includes(name));
		for (const mode of ["auto", "plan", "hack", "plan"] as const) {
			await h.mode(mode);
			expect(foreign()).toEqual([
				"read",
				"workflow_run",
				"workflow_validate",
				"plan_b",
			]);
		}
		// The seat still declares none of them, and still moves none of them:
		// withdrawal is not how a run is refused.
		expect(entry.seat().tools.declaredFor("maestro")).not.toContain(
			"workflow_run",
		);
	});

	it("refuses a model-started run in plan mode, and only those two tools", () => {
		// The guidance was written three times and a model reviewed its own plan
		// from plan mode twice anyway, so it is a refusal now. The refusal names
		// both ways a run does start, because "no" alone is unactionable.
		for (const name of ["workflow_run", "workflow_propose"]) {
			const reason = seatToolBlockReason("plan", name);
			expect(reason).toBe(PLAN_MODE_RUN_REFUSAL);
			expect(reason).toContain("/workflow run <ref>");
			expect(reason).toContain("plan-mode exit");
			// Only plan mode. Auto and hack are postures that act.
			expect(seatToolBlockReason("auto", name)).toBeUndefined();
			expect(seatToolBlockReason("hack", name)).toBeUndefined();
		}
		// Reading a run is planning, so every read stays open — including in the
		// exit window, which changes nothing about runs either way.
		for (const name of [
			"workflow_list",
			"workflow_validate",
			"workflow_inspect",
			"workflow_wait",
			"workflow_logs",
			"workflow_runs",
			"workflow_status",
			// Already human-only in the runtime; the seat adds nothing to it.
			"workflow_decide",
		]) {
			expect(seatToolBlockReason("plan", name)).toBeUndefined();
			expect(seatToolBlockReason("plan", name, "plan")).toBeUndefined();
		}
	});

	it("survives a host that binds the live tool set only after loading", async () => {
		// The real failure: Pi threw "Extension runtime not initialized" out of
		// the seat's first sync, and the whole extension failed to load.
		const h = host();
		const entry = startSeat(h.pi, seatOptions());
		expect(() => entry.seat()).not.toThrow();
		expect(h.registered).toEqual(["bash", "delete"]);
		// A mode change before binding still only registers.
		await h.mode("auto");
		expect(h.registered).toEqual(["bash", "delete", "plan"]);
		h.bind();
		entry.runtimeBound();
		expect(h.active()).toEqual([
			"read",
			"workflow_run",
			"bash",
			"delete",
			"plan",
		]);
		await h.mode("plan");
		expect(h.active()).not.toContain("plan");
	});

	it("still hands a host without a live tool set what it can hold", async () => {
		const registered: string[] = [];
		const commands = new Map<
			string,
			{ handler(args: string, ctx: unknown): Promise<void> }
		>();
		const pi: SeatHost = {
			registerTool: (tool) => registered.push((tool as { name: string }).name),
			registerCommand: (name, spec) =>
				commands.set(
					name,
					spec as { handler(args: string, ctx: unknown): Promise<void> },
				),
		};
		const entry = startSeat(pi, seatOptions());
		entry.seat();
		expect(registered).toEqual(["bash", "delete"]);
		await commands.get("mode")?.handler("auto", { ui: { notify() {} } });
		expect(registered).toEqual(["bash", "delete", "plan"]);
	});
});

describe("the mode-exit seam", () => {
	it("fires on a real change, before the posture moves", async () => {
		const seen: [ModeName, ModeName, ModeName][] = [];
		const h = host();
		const entry = startSeat(h.pi, {
			...seatOptions(),
			beginModeExit: (previous, next) => {
				seen.push([previous, next, entry.currentMode()]);
			},
		});
		entry.seat();

		await h.mode("auto");
		// The third element is the mode observed from inside the hook: phase 1
		// gathers what the human knows while the session is still in plan mode.
		expect(seen).toEqual([["plan", "auto", "plan"]]);
		expect(entry.currentMode()).toBe("auto");
	});

	it("stays silent when nothing changes", async () => {
		const seen: string[] = [];
		const h = host();
		const entry = startSeat(h.pi, {
			...seatOptions(),
			beginModeExit: (previous, next) => {
				seen.push(`${previous}->${next}`);
			},
		});
		entry.seat();

		await h.mode("");
		await h.mode("plan");
		await h.mode("sideways");
		expect(seen).toEqual([]);
		expect(entry.currentMode()).toBe("plan");

		await h.mode("auto");
		await h.mode("auto");
		expect(seen).toEqual(["plan->auto"]);
	});

	it("does not change the switch it straddles while it is empty", async () => {
		const h = host();
		const entry = startSeat(h.pi, seatOptions());
		entry.seat();
		await h.mode("auto");
		expect(entry.currentMode()).toBe("auto");
		expect(entry.exitWindow()).toBe("none");
	});
});
