// Hack mode is the escape hatch where the maestro BECOMES the sequential
// worker: it implements directly and must not fan out. Only auto orchestrates
// (new-deliverable activation); already-running workers drain regardless.
// Pins docs/modes-architecture.md § The four modes (backlog #3).

import { describe, expect, it } from "vitest";
import { orchestrationActive } from "../packages/modes/src/policy.js";

describe("orchestration by mode", () => {
	it("only auto activates new deliverables", () => {
		expect(orchestrationActive("auto")).toBe(true);
		expect(orchestrationActive("hack")).toBe(false);
		expect(orchestrationActive("plan")).toBe(false);
		expect(orchestrationActive("recon")).toBe(false);
	});
});
