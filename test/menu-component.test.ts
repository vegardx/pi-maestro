import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigMenuComponent } from "../packages/settings/src/menu.js";

const KEY_DOWN = "[B";
const KEY_ENTER = "\r";
const NOOP_PALETTE = {
	dim: (s: string) => s,
	accent: (s: string) => s,
	heading: (s: string) => s,
	muted: (s: string) => s,
	success: (s: string) => s,
};

let root: string;
let prevAgentDir: string | undefined;

function fakeCtx(): ExtensionContext {
	return {
		cwd: root,
		model: { provider: "anthropic", id: "sonnet" },
		modelRegistry: {
			find: (provider: string, id: string) => ({
				provider,
				id,
				name: `${provider}/${id}`,
			}),
			getAvailable: () => [
				{ provider: "anthropic", id: "sonnet", name: "Sonnet" },
				{ provider: "openai", id: "o3", name: "o3" },
			],
			getAll: () => [],
			hasConfiguredAuth: () => true,
		},
		ui: { theme: null },
	} as unknown as ExtensionContext;
}

/** Read the component's private `mode` for assertions. */
function modeOf(c: ConfigMenuComponent): string {
	return (c as unknown as { mode: string }).mode;
}
function cursorOf(c: ConfigMenuComponent): number {
	return (c as unknown as { cursor: number }).cursor;
}
function rowKeyAt(c: ConfigMenuComponent, i: number): string {
	return (c as unknown as { flatRows: Array<{ key: string }> }).flatRows[i].key;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "menu-comp-"));
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "agent"), { recursive: true });
	// A profile so the section has target/tier rows.
	writeFileSync(
		join(root, "agent", "settings.json"),
		JSON.stringify({
			models: {
				profiles: { opus: { targets: ["anthropic/sonnet"], roles: {} } },
			},
		}),
	);
});
afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	rmSync(root, { recursive: true, force: true });
});

describe("ConfigMenuComponent", () => {
	it("builds name, targets, plan, and curated role rows for a profile", () => {
		const c = new ConfigMenuComponent(fakeCtx(), NOOP_PALETTE, () => {});
		expect(rowKeyAt(c, 0)).toBe("@name.opus");
		expect(rowKeyAt(c, 1)).toBe("opus.@targets");
		expect(rowKeyAt(c, 2)).toBe("opus.plan");
		expect(rowKeyAt(c, 3)).toBe("opus.worker");
		expect(rowKeyAt(c, 4)).toBe("opus.reviewer");
		expect(rowKeyAt(c, 11)).toBe("opus.delegate");
	});

	it("navigates with SS3 arrows (application-cursor mode, e.g. outside tmux)", () => {
		// Terminals in DECCKM mode send arrows as ESC O B, not ESC [ B. pi
		// forwards raw bytes, so the component must accept both forms.
		const SS3_DOWN = "OB";
		const c = new ConfigMenuComponent(fakeCtx(), NOOP_PALETTE, () => {});
		expect(cursorOf(c)).toBe(0);
		c.handleInput(SS3_DOWN);
		expect(cursorOf(c)).toBe(1);
		expect(rowKeyAt(c, cursorOf(c))).toBe("opus.@targets");
	});

	it("Enter on the targets row opens the targets picker", () => {
		const c = new ConfigMenuComponent(fakeCtx(), NOOP_PALETTE, () => {});
		c.handleInput(KEY_DOWN); // → targets
		expect(cursorOf(c)).toBe(1);
		c.handleInput(KEY_ENTER);
		expect(modeOf(c)).toBe("targets");
	});

	it("Enter on the worker row opens the role model picker", () => {
		const c = new ConfigMenuComponent(fakeCtx(), NOOP_PALETTE, () => {});
		c.handleInput(KEY_DOWN); // targets
		c.handleInput(KEY_DOWN); // plan
		c.handleInput(KEY_DOWN); // work
		expect(rowKeyAt(c, cursorOf(c))).toBe("opus.worker");
		c.handleInput(KEY_ENTER);
		expect(modeOf(c)).toBe("tier-pick-model");
	});

	it("renders without throwing at a normal width", () => {
		const c = new ConfigMenuComponent(fakeCtx(), NOOP_PALETTE, () => {});
		expect(() => c.render(100)).not.toThrow();
	});

	it("picking a model + effort for a role persists to settings", () => {
		const c = new ConfigMenuComponent(fakeCtx(), NOOP_PALETTE, () => {});
		// Navigate to the review row (name,targets,plan,work,review).
		for (let i = 0; i < 4; i++) c.handleInput(KEY_DOWN);
		expect(rowKeyAt(c, cursorOf(c))).toBe("opus.reviewer");
		c.handleInput(KEY_ENTER); // open model picker (cursor 0 = "= plan", 1 = sonnet, 2 = o3)
		expect(modeOf(c)).toBe("tier-pick-model");
		c.handleInput(KEY_DOWN); // → sonnet
		c.handleInput(KEY_DOWN); // → o3
		c.handleInput(KEY_ENTER); // pick o3 → effort picker
		expect(modeOf(c)).toBe("tier-pick-effort");
		c.handleInput(KEY_ENTER); // confirm default effort
		expect(modeOf(c)).toBe("browse");

		const saved = JSON.parse(
			readFileSync(join(root, "agent", "settings.json"), "utf8"),
		);
		expect(saved.models.profiles.opus.roles.reviewer.models).toEqual([
			"openai/o3",
		]);
	});

	it("windows the box to the viewport and keeps the cursor visible", () => {
		// Many profiles (6 rows each) so the browse list overflows a short terminal.
		writeFileSync(
			join(root, "agent", "settings.json"),
			JSON.stringify({
				models: {
					profiles: {
						a: { targets: ["anthropic/sonnet"] },
						b: { targets: [] },
						c: { targets: [] },
						d: { targets: [] },
						e: { targets: [] },
					},
				},
			}),
		);
		// viewport 20 rows → budget = max(12, floor(20*0.6)) = 12.
		const c = new ConfigMenuComponent(
			fakeCtx(),
			NOOP_PALETTE,
			() => {},
			() => 20,
		);
		// Drive the cursor deep into the list (past the first screen).
		for (let i = 0; i < 20; i++) c.handleInput(KEY_DOWN);

		const lines = c.render(100);
		expect(lines.length).toBeLessThanOrEqual(12);
		// The selected row is rendered (accent pointer, identity palette → "▶").
		expect(lines.join("\n")).toContain("▶");
		// Overflow indicators show there is more above/below the window.
		expect(lines.join("\n")).toContain("⋯");
	});

	it("does not window when the viewport is unbounded (test default)", () => {
		const c = new ConfigMenuComponent(fakeCtx(), NOOP_PALETTE, () => {});
		const lines = c.render(100);
		expect(lines.join("\n")).not.toContain("⋯");
	});

	it("lists global packages as child-extension toggles and persists the set", () => {
		// Global settings carry a `packages` list (pi package manager); each
		// non-maestro entry becomes a toggle for the -ne passthrough.
		writeFileSync(
			join(root, "agent", "settings.json"),
			JSON.stringify({
				packages: ["/ext/custom-provider", "/ext/other-infra"],
				extensionConfig: {},
				models: {
					profiles: { opus: { targets: ["anthropic/sonnet"], roles: {} } },
				},
			}),
		);
		const c = new ConfigMenuComponent(fakeCtx(), NOOP_PALETTE, () => {});
		// 12 profile rows (name/targets/plan + nine roles), then toggles.
		expect(rowKeyAt(c, 12)).toBe("@childext./ext/custom-provider");
		expect(rowKeyAt(c, 13)).toBe("@childext./ext/other-infra");

		for (let i = 0; i < 12; i++) c.handleInput(KEY_DOWN);
		c.handleInput(" "); // toggle on
		let saved = JSON.parse(
			readFileSync(join(root, "agent", "settings.json"), "utf8"),
		);
		expect(saved.extensionConfig.modes.childExtensions).toEqual([
			"/ext/custom-provider",
		]);

		c.handleInput(KEY_ENTER); // Enter toggles too — back off
		saved = JSON.parse(
			readFileSync(join(root, "agent", "settings.json"), "utf8"),
		);
		expect(saved.extensionConfig.modes.childExtensions).toEqual([]);
	});

	it("toggling a target in the picker persists to settings", () => {
		const c = new ConfigMenuComponent(fakeCtx(), NOOP_PALETTE, () => {});
		c.handleInput(KEY_DOWN); // → targets row
		c.handleInput(KEY_ENTER); // open targets picker
		expect(modeOf(c)).toBe("targets");
		c.handleInput(KEY_DOWN); // → openai/o3 (cursor 0 = sonnet already selected)
		c.handleInput(" "); // toggle o3 on
		const saved = JSON.parse(
			readFileSync(join(root, "agent", "settings.json"), "utf8"),
		);
		expect(saved.models.profiles.opus.targets).toContain("openai/o3");
	});
});
