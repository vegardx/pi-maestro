// Recon mode: the session-start research posture. Default mode, outside the
// Shift+Tab cycle (one-way exit into plan), read-only toolset with the
// research loop but ZERO plan surface — no plan/readiness/structure tools,
// and a preamble that never frames research as a countdown to planning.

import { describe, expect, it } from "vitest";
import { ALL_MODES, MODE_NAMES } from "../packages/contracts/src/modes.js";
import {
	computeActiveTools,
	toolBlockedInReconMode,
} from "../packages/modes/src/policy.js";
import { buildReconPreamble } from "../packages/modes/src/runtime/preambles.js";
import {
	initialModesState,
	isModeName,
	nextMode,
} from "../packages/modes/src/state.js";

const now = () => "2026-07-14T00:00:00.000Z";

const ALL_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
	"ask",
	"websearch",
	"webfetch",
	"deliverable",
	"task",
	"agent",
	"plan",
	"knowledge",
	"research",
	"readiness",
	"dig",
	"gate",
];

describe("recon in the mode contract", () => {
	it("is a real mode but never part of the Shift+Tab cycle", () => {
		expect(isModeName("recon")).toBe(true);
		expect(ALL_MODES).toContain("recon");
		expect(MODE_NAMES).not.toContain("recon");
		expect(MODE_NAMES).not.toContain("hack");
		expect(MODE_NAMES).toEqual(["plan", "auto"]);
	});

	it("is NOT the default mode — plan is the boot posture; recon is a deliberate off-ramp", () => {
		expect(initialModesState(now).mode).toBe("plan");
	});

	it("cycle is plan ⇄ auto; off-cycle modes exit into plan", () => {
		expect(nextMode("plan")).toBe("auto");
		expect(nextMode("auto")).toBe("plan");
		// The exit ramp: recon and hack are command-entered, keyboard-exited.
		expect(nextMode("recon")).toBe("plan");
		expect(nextMode("hack")).toBe("plan");
		expect(nextMode("agent")).toBe("plan");
	});
});

describe("recon tool policy", () => {
	it("allows the read-only set plus the research loop", () => {
		const active = computeActiveTools({
			mode: "recon",
			availableTools: ALL_TOOLS,
		});
		for (const open of [
			"read",
			"grep",
			"find",
			"ls",
			"websearch",
			"webfetch",
			"research",
			"dig",
			"ask",
			"bash",
		]) {
			expect(active).toContain(open);
		}
	});

	it("exposes no plan surface at all", () => {
		const active = computeActiveTools({
			mode: "recon",
			availableTools: ALL_TOOLS,
		});
		for (const hidden of [
			"plan",
			"readiness",
			"deliverable",
			"task",
			"agent",
			"knowledge",
			"edit",
			"write",
			"gate",
		]) {
			expect(active).not.toContain(hidden);
		}
	});

	it("call-time gate matches the policy and explains the posture", () => {
		for (const open of ["read", "grep", "bash", "research", "dig", "ask"]) {
			expect(toolBlockedInReconMode(open)).toBeNull();
		}
		for (const blocked of ["edit", "deliverable", "readiness", "plan"]) {
			expect(toolBlockedInReconMode(blocked)).toMatch(/recon/);
		}
	});
});

describe("recon preamble", () => {
	it("frames the mode as research with no destination", () => {
		const preamble = buildReconPreamble();
		expect(preamble).toContain("RECON MODE");
		expect(preamble).toContain("research");
		expect(preamble).toContain("dig");
		expect(preamble).toContain("Read-only");
	});

	it("contains none of the plan-formation machinery", () => {
		const preamble = buildReconPreamble();
		// The whole point of a distinct mode: the prompt never mentions the
		// gate or the structure tools, so there is no planning gravity.
		expect(preamble).not.toContain("readiness");
		expect(preamble).not.toContain("deliverable");
		expect(preamble).not.toContain("STRUCTURING");
		expect(preamble).not.toContain("form a plan");
	});
});
