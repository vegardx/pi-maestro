// The seat's tool surface, and what a posture does to it.
//
// THERE IS NO PLAN TOOL. The document is not written by a tool call any more:
// the exit asks the model for it directly, outside the agent loop, with no
// tools offered at all. So the seat declares exactly what it holds in every
// posture, and these tests stand against the registry's own defect — a tool
// whose availability is decided in one place and remembered in another — by
// asking the SAME question through every door and demanding the same answer.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	PLAN_MODE_RUN_REFUSAL,
	type SeatHost,
	seatToolBlockReason,
	startSeat,
} from "../packages/maestro/src/extension.js";
import type { ModeName } from "../packages/maestro/src/mode.js";
import type { Plan } from "../packages/maestro/src/plan.js";
import { createSeat } from "../packages/maestro/src/seat.js";
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
	return {
		cwd: temp("maestro-cwd-"),
		agentDir: temp("maestro-agent-"),
		// The store records who wrote a plan and refuses to save without a
		// session to name, so a seat under test is a seat with one.
		sessionId: () => "seat-modes-session",
	};
}

/** Every tool the seat declares, in every posture. */
const SEAT_TOOLS = ["bash", "delete"] as const;

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
 * ONE HOST, ONE READER. The exit validates the document it obtained and the
 * store refuses to save one this session cannot honour; they are the same
 * refusal, so the seat hands the store the port the exit is also given. This
 * asserts the store's half: what the host has is stored, what it does not is
 * refused by name.
 */
describe("the host answers for the store", () => {
	const pinned = (model: string): Plan => ({
		slug: "arc",
		title: "Arc",
		repos: [{ key: "main", path: "." }],
		deliverables: [
			{
				id: "api",
				title: "The API",
				after: [],
				reads: [],
				tasks: [{ id: "build", title: "Build it" }],
				reviews: [{ lens: "c", model }],
			},
		],
	});

	it("stores what the host has and refuses what it does not", () => {
		// A real repository, because a plan's repository path is checked against
		// the world.
		const cwd = temp("maestro-seat-repo-");
		execFileSync("git", ["init", "--quiet"], { cwd, stdio: "ignore" });
		const seat = createSeat({
			cwd,
			agentDir: temp("maestro-agent-"),
			sessionId: () => "seat-modes-session",
			host: () => fakeHost({ models: ["anthropic/opus-5"] }),
		});
		const plan = {
			...pinned("anthropic/opus-5"),
			repos: [{ key: "main", path: cwd }],
		};

		seat.store.savePlan(plan);
		expect(seat.store.loadPlan("arc")?.deliverables[0]?.reviews).toEqual([
			{ lens: "c", model: "anthropic/opus-5" },
		]);

		expect(() =>
			seat.store.savePlan({
				...pinned("anthropic/opus-9"),
				repos: [{ key: "main", path: cwd }],
			}),
		).toThrowError(/is not a model this host has/);
	});

	// A seat with no host is every seat in a test and every headless check.
	// It refuses a pin rather than storing what nothing verified.
	it("refuses a pinned model when the seat was built without a host", () => {
		const cwd = temp("maestro-seat-repo-");
		execFileSync("git", ["init", "--quiet"], { cwd, stdio: "ignore" });
		const seat = createSeat({ cwd, agentDir: temp("maestro-agent-") });

		expect(() =>
			seat.store.savePlan({
				...pinned("anthropic/opus-5"),
				repos: [{ key: "main", path: cwd }],
			}),
		).toThrowError(/there is no model catalogue here to check it against/);
	});
});

describe("the seat's tools, by mode", () => {
	it("holds the same two in every posture", () => {
		const seat = createSeat(seatOptions());

		expect(seat.mode().name).toBe("plan");
		for (const name of ["plan", "auto", "hack"] as const) {
			seat.setMode(name);
			expect([name, seat.tools.grantsFor("maestro")]).toEqual([
				name,
				[...SEAT_TOOLS],
			]);
		}
	});

	it("says the same thing through every door the registry has", () => {
		const seat = createSeat(seatOptions());
		const doors = () => ({
			grants: [...seat.tools.grantsFor("maestro")],
			declared: [...seat.tools.declaredFor("maestro")],
			definitions: seat.tools.definitionsFor("maestro").map(({ name }) => name),
			names: [...seat.tools.names()],
		});

		const expected = {
			grants: [...SEAT_TOOLS],
			declared: [...SEAT_TOOLS],
			definitions: [...SEAT_TOOLS],
			names: [...SEAT_TOOLS],
		};
		expect(doors()).toEqual(expected);
		seat.setMode("auto");
		expect(doors()).toEqual(expected);
	});

	// The two names this exit removed. Nothing declares them, in any posture,
	// so nothing can hand one to a model that would then wait for it.
	it("declares neither `plan` nor `plan_intent`, in any posture", () => {
		const seat = createSeat(seatOptions());
		for (const name of ["plan", "auto", "hack"] as const) {
			seat.setMode(name);
			for (const gone of ["plan", "plan_intent"]) {
				expect([name, gone, seat.tools.has(gone)]).toEqual([name, gone, false]);
				expect([name, gone, seat.tools.names().includes(gone)]).toEqual([
					name,
					gone,
					false,
				]);
				expect([
					name,
					gone,
					seat.tools.describeFor("maestro").includes(`- ${gone} —`),
				]).toEqual([name, gone, false]);
			}
		}
	});
});

describe("Pi's live tool set", () => {
	it("registers the seat's tools once and moves none of them on /mode", async () => {
		const h = host();
		const entry = startSeat(h.pi, seatOptions());
		entry.seat();

		// Loading registers and touches nothing else: the live set is Pi's until
		// the runtime is bound, and reading it before then throws.
		expect(h.registered).toEqual([...SEAT_TOOLS]);
		h.bind();
		expect(h.active()).toEqual(["read", "workflow_run"]);
		entry.runtimeBound();
		expect(h.active()).toEqual(["read", "workflow_run", ...SEAT_TOOLS]);

		for (const mode of ["auto", "plan", "hack", "plan"] as const) {
			await h.mode(mode);
			expect([mode, h.registered]).toEqual([mode, [...SEAT_TOOLS]]);
			expect([mode, h.active()]).toEqual([
				mode,
				["read", "workflow_run", ...SEAT_TOOLS],
			]);
		}
	});

	it("never hands Pi a `plan` or `plan_intent` tool", async () => {
		const h = host();
		const entry = startSeat(h.pi, seatOptions());
		entry.seat();
		h.bind();
		entry.runtimeBound();
		for (const mode of ["auto", "plan", "hack"] as const) {
			await h.mode(mode);
			expect(h.registered).not.toContain("plan");
			expect(h.registered).not.toContain("plan_intent");
			expect(h.active()).not.toContain("plan");
			expect(h.active()).not.toContain("plan_intent");
		}
	});

	it("leaves every tool it does not declare alone, workflow tools included", async () => {
		const h = host(["read", "workflow_run", "workflow_validate", "plan_b"]);
		const entry = startSeat(h.pi, seatOptions());
		entry.seat();
		h.bind();
		entry.runtimeBound();

		const foreign = () =>
			h.active().filter((name) => !SEAT_TOOLS.includes(name as "bash"));
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
		for (const name of ["workflow_run", "workflow_propose"]) {
			const reason = seatToolBlockReason("plan", name);
			expect(reason).toBe(PLAN_MODE_RUN_REFUSAL);
			expect(reason).toContain("/workflow run <ref>");
			expect(seatToolBlockReason("auto", name)).toBeUndefined();
			expect(seatToolBlockReason("hack", name)).toBeUndefined();
		}
		for (const name of [
			"workflow_list",
			"workflow_validate",
			"workflow_inspect",
			"workflow_wait",
			"workflow_logs",
			"workflow_runs",
			"workflow_status",
			"workflow_decide",
		])
			expect(seatToolBlockReason("plan", name)).toBeUndefined();
	});

	it("keeps plan mode read-only at the tool call", () => {
		for (const name of ["write", "edit", "delete"]) {
			expect(seatToolBlockReason("plan", name)).toContain("read-only");
			expect(seatToolBlockReason("auto", name)).toBeUndefined();
		}
	});

	it("survives a host that binds the live tool set only after loading", async () => {
		// The real failure: Pi threw "Extension runtime not initialized" out of
		// the seat's first sync, and the whole extension failed to load.
		const h = host();
		const entry = startSeat(h.pi, seatOptions());
		expect(() => entry.seat()).not.toThrow();
		expect(h.registered).toEqual([...SEAT_TOOLS]);
		await h.mode("auto");
		h.bind();
		entry.runtimeBound();
		expect(h.active()).toEqual(["read", "workflow_run", ...SEAT_TOOLS]);
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
		expect(registered).toEqual([...SEAT_TOOLS]);
		await commands.get("mode")?.handler("auto", { ui: { notify() {} } });
		expect(registered).toEqual([...SEAT_TOOLS]);
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
		// The third element is the mode observed from inside the hook: the exit
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

	it("does not change the switch it straddles on a session with no dialogs", async () => {
		const h = host();
		const entry = startSeat(h.pi, seatOptions());
		entry.seat();
		await h.mode("auto");
		expect(entry.currentMode()).toBe("auto");
	});
});
