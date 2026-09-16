// RFC 6901 pointers and the three RFC 6902 operations, over plain JSON.
//
// The cases below are the ones that decide whether accepting a review finding
// is safe: a pointer that does not resolve, an index that is not an index, an
// operation this seat does not implement, a value JSON cannot hold, and the
// promise that nothing is mutated when any of those happens.

import { describe, expect, it } from "vitest";
import {
	applyJsonPatch,
	isJsonPatchOperation,
	MAX_POINTER_DEPTH,
	parsePointer,
	resolvePointer,
} from "../packages/maestro/src/json-patch.js";

const document = {
	slug: "compose",
	deliverables: [
		{ id: "one", tasks: [{ id: "impl" }] },
		{ id: "two", tasks: [] },
	],
	policy: { effort: "standard" },
};

describe("parsePointer", () => {
	it("reads the empty pointer as the whole document", () => {
		expect(parsePointer("")).toEqual([]);
	});

	it("refuses a pointer that does not start with a slash", () => {
		expect(parsePointer("deliverables/0")).toBeNull();
	});

	it("decodes ~1 as a slash and ~0 as a tilde, in that order", () => {
		expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
		expect(parsePointer("/~01")).toEqual(["~1"]);
	});

	it("refuses a tilde that is not an escape", () => {
		expect(parsePointer("/a~2b")).toBeNull();
	});

	it("refuses a pointer deeper than the bound", () => {
		const deep = "/a".repeat(MAX_POINTER_DEPTH + 1);
		expect(parsePointer(deep)).toBeNull();
	});
});

describe("resolvePointer", () => {
	it("finds what a pointer points at", () => {
		expect(resolvePointer(document, "/deliverables/1/id")).toEqual({
			found: true,
			value: "two",
		});
	});

	it("reports a pointer that resolves to nothing", () => {
		expect(resolvePointer(document, "/deliverables/9").found).toBe(false);
		expect(resolvePointer(document, "/nope/deeper").found).toBe(false);
	});
});

describe("applyJsonPatch", () => {
	it("replaces an object member and leaves the original alone", () => {
		const result = applyJsonPatch(document, {
			op: "replace",
			path: "/policy/effort",
			value: "deep",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect((result.document as typeof document).policy.effort).toBe("deep");
		expect(document.policy.effort).toBe("standard");
		// Untouched branches are shared, not copied.
		expect((result.document as typeof document).deliverables).toBe(
			document.deliverables,
		);
	});

	it("adds a member that does not exist yet", () => {
		const result = applyJsonPatch(document, {
			op: "add",
			path: "/policy/maxFixRounds",
			value: 2,
		});
		expect(
			result.ok &&
				(result.document as { policy: { maxFixRounds: number } }).policy
					.maxFixRounds,
		).toBe(2);
	});

	it("refuses to replace a member that does not exist", () => {
		const result = applyJsonPatch(document, {
			op: "replace",
			path: "/policy/gates",
			value: "approve-plan",
		});
		expect(result).toMatchObject({ ok: false });
		if (result.ok) return;
		expect(result.reason).toContain("does not exist");
	});

	it("inserts into an array at an index and appends at -", () => {
		const inserted = applyJsonPatch(document, {
			op: "add",
			path: "/deliverables/0",
			value: { id: "zero", tasks: [] },
		});
		expect(
			inserted.ok &&
				(inserted.document as typeof document).deliverables.map((d) => d.id),
		).toEqual(["zero", "one", "two"]);
		const appended = applyJsonPatch(document, {
			op: "add",
			path: "/deliverables/-",
			value: { id: "three", tasks: [] },
		});
		expect(
			appended.ok &&
				(appended.document as typeof document).deliverables.map((d) => d.id),
		).toEqual(["one", "two", "three"]);
	});

	it("refuses - anywhere but an add, and refuses a padded index", () => {
		expect(
			applyJsonPatch(document, { op: "remove", path: "/deliverables/-" }),
		).toMatchObject({ ok: false });
		expect(
			applyJsonPatch(document, {
				op: "replace",
				path: "/deliverables/01",
				value: {},
			}),
		).toMatchObject({ ok: false });
	});

	it("removes an array element and an object member", () => {
		const removed = applyJsonPatch(document, {
			op: "remove",
			path: "/deliverables/0",
		});
		expect(
			removed.ok &&
				(removed.document as typeof document).deliverables.map((d) => d.id),
		).toEqual(["two"]);
		const dropped = applyJsonPatch(document, {
			op: "remove",
			path: "/policy/effort",
		});
		expect(
			dropped.ok &&
				Object.hasOwn((dropped.document as typeof document).policy, "effort"),
		).toBe(false);
	});

	it("refuses an operation this seat does not implement", () => {
		const result = applyJsonPatch(document, {
			op: "move",
			path: "/policy",
			from: "/deliverables",
		});
		expect(result).toMatchObject({ ok: false });
		if (result.ok) return;
		expect(result.reason).toContain("`move` is not an operation");
	});

	it("refuses an add or replace with no value at all", () => {
		expect(
			applyJsonPatch(document, { op: "add", path: "/policy/gates" }),
		).toMatchObject({ ok: false });
	});

	it("refuses a value JSON cannot hold", () => {
		for (const value of [undefined, Number.NaN, () => 1, new Date()]) {
			expect(
				applyJsonPatch(document, { op: "add", path: "/x", value }),
			).toMatchObject({ ok: false });
		}
	});

	it("refuses to walk into something that holds no members", () => {
		const result = applyJsonPatch(document, {
			op: "replace",
			path: "/slug/0",
			value: "x",
		});
		expect(result).toMatchObject({ ok: false });
	});

	it("replaces the whole document but never removes it", () => {
		const replaced = applyJsonPatch(document, {
			op: "replace",
			path: "",
			value: { slug: "other" },
		});
		expect(replaced).toEqual({ ok: true, document: { slug: "other" } });
		expect(applyJsonPatch(document, { op: "remove", path: "" })).toMatchObject({
			ok: false,
		});
	});

	it("recognises the operations a finding may carry", () => {
		expect(isJsonPatchOperation({ op: "add", path: "/a" })).toBe(true);
		expect(isJsonPatchOperation({ op: "test", path: "/a" })).toBe(false);
		expect(isJsonPatchOperation({ path: "/a" })).toBe(false);
	});
});
