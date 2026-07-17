import { describe, expect, it } from "vitest";
import { appendMaestroStageTrailer } from "../packages/commit/src/index.js";

// Importing the extension module is safe here; the helper is pure and exported
// from the same public surface commitLocal uses.
describe("Maestro-Stage commit trailers", () => {
	it("appends one compact trailer without changing the conventional subject", () => {
		expect(
			appendMaestroStageTrailer(
				"feat(runtime): add boundary commits\n\nExplain why.",
				"verification/final",
			),
		).toBe(
			"feat(runtime): add boundary commits\n\nExplain why.\n\nMaestro-Stage: verification/final",
		);
	});

	it("is optional and replaces an existing trailer idempotently", () => {
		const message = "fix(core): handle null";
		expect(appendMaestroStageTrailer(message, undefined)).toBe(message);
		expect(
			appendMaestroStageTrailer(
				`${message}\n\nMaestro-Stage: old-stage`,
				"new-stage",
			),
		).toBe(`${message}\n\nMaestro-Stage: new-stage`);
	});

	it("rejects prose and newline injection", () => {
		expect(() =>
			appendMaestroStageTrailer("feat(core): x", "stage\nCo-authored-by: x"),
		).toThrow("compact identifier");
	});
});
