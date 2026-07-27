// Shift+Tab is the GUIDED rail, deliberately not the same path as the commands.
//
// The commands are the expert path: direct posture switches and explicit verbs,
// no ceremony. The rail keeps the ceremony — form, preview, then the readiness
// gate (review + ruling) before auto. Both share the live-worker guard, so
// neither can walk away from running work.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const context = readFileSync(
	join(process.cwd(), "packages/modes/src/runtime/context.ts"),
	"utf8",
);

/** The cycle() member body — the Shift+Tab handler. */
const cycle = (() => {
	const from = context.indexOf("async cycle(ctx: ExtensionContext)");
	expect(from).toBeGreaterThan(-1);
	const rest = context.slice(from);
	const end = rest.indexOf("\n\t\t},");
	return end === -1 ? rest : rest.slice(0, end);
})();

describe("the two-step plan gesture", () => {
	it("forms and previews on the first gesture, staying in plan", () => {
		expect(cycle).toContain("formPlanPreview");
		expect(cycle).toContain("nodes.length ?? 0) === 0");
	});

	it("offers auto or hack once a plan exists", () => {
		expect(cycle).toContain('"auto — fully autonomous"');
		expect(cycle).toContain('"hack — fully autonomous, all tools"');
	});

	it("keeps the readiness gate for auto — the rail is where ceremony lives", () => {
		// requestMode routes through TransitionGateCoordinator (form → mechanical
		// check → plan-review → ruling). /mode auto deliberately does NOT.
		expect(cycle).toContain('rt.requestMode("auto", ctx)');
		expect(cycle).toContain("rt.runResume(undefined, ctx)");
	});

	it("keeps hack ungated — the #345 invariant", () => {
		// A half-built draft must survive dropping into hack: no forming, no
		// review, no activation.
		expect(cycle).toContain('rt.requestMode("hack", ctx)');
		const from = cycle.indexOf('if (to === "hack") {');
		expect(from).toBeGreaterThan(-1);
		// Bound to the branch's own closing brace, or the slice runs on into the
		// auto branch below (which legitimately does resume).
		const rest = cycle.slice(from);
		const hackBranch = rest.slice(0, rest.indexOf("\n\t\t\t\t}"));
		expect(hackBranch).toContain("return;");
		expect(hackBranch).not.toContain("runResume");
	});

	it("does nothing when the picker is dismissed", () => {
		expect(cycle).toContain("if (!to) return;");
	});
});

describe("the rail shares the live-worker guard", () => {
	it("guards the forward gesture into an execution posture", () => {
		expect(cycle).toContain("rt.guardPostureChange(ctx, to)");
	});

	it("guards the backward gesture via returnToPlan", () => {
		expect(cycle).toContain("returnToPlan(ctx)");
	});

	it("asks before the mode change, not after", () => {
		// A guard that runs after requestMode would have already committed the
		// posture by the time the user says "stay".
		const guardAt = cycle.indexOf("guardPostureChange");
		const requestAt = cycle.indexOf('rt.requestMode("hack"');
		expect(guardAt).toBeGreaterThan(-1);
		expect(guardAt).toBeLessThan(requestAt);
	});
});

describe("recon stays a one-way side-trip", () => {
	it("exits through exitRecon, restoring the session it forked from", () => {
		expect(cycle).toContain("exitRecon(ctx)");
	});
});
