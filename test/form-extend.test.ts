// `/form` is ONE verb doing two jobs: author an empty plan, extend a populated
// one. Before this, forming had no extend path at all — runFormingTurn returned
// early on a populated plan and the preamble said "Create ALL top-level nodes",
// so both the harness and the prompt assumed a blank slate.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanEngine } from "../packages/modes/src/plan/engine.js";
import type { Plan } from "../packages/modes/src/plan/schema.js";
import {
	buildFormingPreamble,
	buildPlanModePreamble,
} from "../packages/modes/src/planning-preamble.js";

const node = (
	id: string,
	over: Partial<Plan["nodes"][number]> = {},
): Plan["nodes"][number] =>
	({
		id,
		title: `Do ${id}`,
		status: "planned",
		agent: "worker",
		tasks: [],
		...over,
	}) as Plan["nodes"][number];

const engineWith = (nodes: Plan["nodes"]): PlanEngine =>
	({
		isDraft: () => false,
		get: () => ({ slug: "demo", nodes }) as Plan,
	}) as unknown as PlanEngine;

describe("extend preamble", () => {
	const nodes = [
		node("api", { tasks: [{}, {}] as Plan["nodes"][number]["tasks"] }),
		node("ui", { children: [node("ui-review", { agent: "reviewer" })] }),
	];
	const extend = buildFormingPreamble(engineWith(nodes), { extend: true });

	it("frames the turn as adding, not authoring", () => {
		expect(extend).toContain("EXTENDING THE PLAN");
		expect(extend).toContain("ADD, don't re-author");
		// The authoring instruction must NOT leak in — it tells the model to
		// create ALL top-level nodes, which would duplicate the whole tree.
		expect(extend).not.toContain("Create ALL top-level nodes");
	});

	it("shows what already exists so the model can avoid colliding with it", () => {
		expect(extend).toContain("`api`");
		expect(extend).toContain("`ui`");
		expect(extend).toContain("`ui-review`"); // nested children included
		expect(extend).toContain("2 tasks");
	});

	it("still opens the structure tools", () => {
		expect(extend).toContain("deliverable");
		expect(extend).toContain("task");
	});

	it("says nothing about frozen work when nothing has started", () => {
		expect(extend).not.toContain("This plan has started");
	});

	it("spells out the append-only rules once execution has started", () => {
		const started = buildFormingPreamble(
			engineWith([node("api", { status: "active" })]),
			{ extend: true },
		);
		expect(started).toContain("This plan has started");
		// The engine refuses these; the model should not waste a turn trying.
		expect(started).toContain("follow-up or manual-checkpoint tasks");
		expect(started).toContain("refused");
	});

	it("still authors from scratch when not extending", () => {
		const author = buildFormingPreamble(engineWith([]));
		expect(author).toContain("FORMING THE PLAN");
		expect(author).toContain("Create ALL top-level nodes");
		expect(author).not.toContain("EXTENDING THE PLAN");
	});
});

describe("plan-mode conversation preamble", () => {
	it("points at /form now that forming is a verb", () => {
		const preamble = buildPlanModePreamble(engineWith([]));
		expect(preamble).toContain("/form");
		// Plan conversation still must not author.
		expect(preamble).not.toContain("## Author");
	});
});

describe("/form does not claim success for an unrunnable plan", () => {
	const context = readFileSync(
		join(process.cwd(), "packages/modes/src/runtime/context.ts"),
		"utf8",
	);
	const runForm = (() => {
		const from = context.indexOf("async function runForm(");
		expect(from).toBeGreaterThan(-1);
		const rest = context.slice(from);
		const end = rest.search(/\n\t\}[,\n]/);
		return end === -1 ? rest : rest.slice(0, end);
	})();

	it("runs the mechanical readiness check before reporting", () => {
		// Caught on a LIVE drive: Opus authored three deliverables and stopped
		// before their tasks. `nodes.length > 0` is not "the plan can run", and a
		// worker deliverable with no gating work can never enter execution.
		// Forming used to be bundled into the transition, so the gate reported
		// this in the same gesture; as a standalone verb /form must say it itself.
		expect(runForm).toContain("executionReadinessValidations");
		expect(runForm).toContain("can't run yet");
	});

	it("still points back at /form to fill the gap", () => {
		expect(runForm).toContain("`/form` again");
	});
});

describe("the forming turn", () => {
	const context = readFileSync(
		join(process.cwd(), "packages/modes/src/runtime/context.ts"),
		"utf8",
	);

	it("measures an extend by fingerprint, not by node count", () => {
		// Nodes already exist when extending, so "did anything happen?" cannot be
		// answered by counting them — only by whether the plan changed.
		expect(context).toContain("planFingerprint(after) !== before");
	});

	it("keeps the gate's skip-if-populated path", () => {
		// A reopened or seeded plan must still skip forming entirely.
		expect(context).toContain(
			'if (populated && !opts?.extend) return { status: "formed", summary: "" };',
		);
	});
});
