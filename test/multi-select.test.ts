// The checkbox multi-select (editor-takeover): space toggles at a STABLE
// cursor, arrows move, enter applies the whole selection at once, esc cancels,
// a/n bulk-select, rendered with [x]/[ ]. Driven directly through the
// component's handleInput — the same bytes the TUI feeds it.

import { describe, expect, it } from "vitest";
import { MultiSelectComponent } from "../packages/settings/src/multi-select.js";

const ESC = "\u001b";
const DOWN = "\u001b[B";

function component(checked: string[] = ["b"]) {
	const results: Array<string[] | undefined> = [];
	const c = new MultiSelectComponent(
		"Pick",
		[
			{ id: "a", label: "alpha", checked: checked.includes("a") },
			{ id: "b", label: "beta", checked: checked.includes("b") },
			{ id: "c", label: "gamma", checked: checked.includes("c") },
		],
		(result) => results.push(result),
	);
	return { c, results };
}

describe("multi-select checkbox", () => {
	it("space toggles under a cursor that arrows move", () => {
		const { c, results } = component();
		c.handleInput(" "); // toggle a ON at cursor 0
		c.handleInput(DOWN); // cursor to b
		c.handleInput(" "); // toggle b OFF
		c.handleInput(DOWN); // cursor to c
		c.handleInput(" "); // toggle c ON
		c.handleInput("\r"); // apply
		expect(results).toEqual([["a", "c"]]);
	});

	it("esc cancels with undefined, keeping the caller's state untouched", () => {
		const { c, results } = component();
		c.handleInput(" ");
		c.handleInput(ESC);
		expect(results).toEqual([undefined]);
	});

	it("a selects all, n selects none", () => {
		const { c, results } = component();
		c.handleInput("a");
		c.handleInput("\r");
		expect(results[0]).toEqual(["a", "b", "c"]);
		const second = component();
		second.c.handleInput("n");
		second.c.handleInput("\r");
		expect(second.results[0]).toEqual([]);
	});

	it("matches arrows/enter/esc via the keybindings manager (like ui.select)", () => {
		// The terminal's actual arrow bytes may differ from the hard-coded CSI
		// forms; the KeyMatcher (pi's KeybindingsManager) is the ground truth.
		const results: Array<string[] | undefined> = [];
		const matcher = {
			matches: (data: string, action: string) =>
				(data === "KDOWN" && action === "tui.select.down") ||
				(data === "KUP" && action === "tui.select.up") ||
				(data === "KENTER" && action === "tui.select.confirm") ||
				(data === "KESC" && action === "tui.select.cancel"),
		};
		const c = new MultiSelectComponent(
			"Pick",
			[
				{ id: "a", label: "alpha", checked: false },
				{ id: "b", label: "beta", checked: false },
			],
			(r) => results.push(r),
			undefined,
			matcher,
		);
		c.handleInput("KDOWN"); // cursor → b (via keybinding, not a raw arrow byte)
		c.handleInput(" "); // toggle b
		c.handleInput("KUP"); // cursor → a
		c.handleInput(" "); // toggle a
		c.handleInput("KENTER"); // apply via keybinding
		expect(results).toEqual([["a", "b"]]);
	});

	it("satisfies the Component/Focusable contract ui.custom requires", () => {
		const { c } = component();
		expect(typeof c.invalidate).toBe("function");
		expect(() => c.invalidate()).not.toThrow();
		expect("focused" in c).toBe(true);
	});

	it("renders cursor, [x]/[ ] boxes, and the key hint", () => {
		const { c } = component();
		const lines = c.render(80);
		expect(lines[1]).toContain("space toggle");
		expect(lines.some((l) => l.includes("▸ [ ] alpha"))).toBe(true);
		expect(lines.some((l) => l.includes("[x] beta"))).toBe(true);
	});

	it("windows long lists around the cursor instead of overflowing", () => {
		const results: Array<string[] | undefined> = [];
		const many = Array.from({ length: 40 }, (_, i) => ({
			id: `m${i}`,
			label: `model-${i}`,
			checked: false,
		}));
		const c = new MultiSelectComponent("Pick", many, (r) => results.push(r));
		for (let i = 0; i < 30; i++) c.handleInput(DOWN);
		const lines = c.render(80);
		expect(lines.some((l) => l.includes("▸ [ ] model-30"))).toBe(true);
		expect(lines.some((l) => l.includes("more"))).toBe(true);
		expect(lines.length).toBeLessThan(20);
	});
});
